import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the spawn layer: these tests never run the real wrangler binary.
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));
// resolveApiCredentials reads wrangler's config under the home directory;
// point it at a temp dir so a real login on this machine is never read.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

import { execFile, spawn } from "node:child_process";
import { resolveApiCredentials } from "../src/credentials.js";
import {
  BOUNDED_KILL_GRACE_MS,
  STREAM_CLOSE_GRACE_MS,
  WRANGLER_READ_TIMEOUT_MS,
  WranglerTimeoutError,
  wranglerExec,
  wranglerJson,
} from "../src/wrangler.js";
import { failure, FAKE_PID, fakeWranglerSpawn } from "./fake-wrangler.js";

const posix = process.platform !== "win32";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  vi.mocked(execFile).mockReset();
});

describe("bounded wrangler runs (timeoutMs)", () => {
  it("returns parsed output from a spawn in its own process group", async () => {
    const calls = fakeWranglerSpawn(() => ({ stdout: '[{"id":"a"}]' }));
    const out = await wranglerJson(["pages", "project", "list", "--json"], {
      timeoutMs: 1000,
      cwd: "/proj",
    });
    expect(out).toEqual([{ id: "a" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe("/proj");
    expect(calls[0].detached).toBe(posix);
    expect(calls[0].groupKills).toEqual([]);
    // execFile (the unbounded path) is not used.
    expect(execFile).not.toHaveBeenCalled();
  });

  it("stops a hung wrangler's whole group at the timeout and says so", async () => {
    const calls = fakeWranglerSpawn(() => ({ hang: true }));
    const pending = failure(
      wranglerJson(["pages", "project", "list", "--json"], {
        timeoutMs: 20_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(calls[0].groupKills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err).toBeInstanceOf(WranglerTimeoutError);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe(
      "wrangler pages project list did not answer within 20s",
    );
    expect(err.suggestions[0]).toContain(
      "run `wrangler pages project list` directly",
    );
    if (posix) {
      expect(process.kill).toHaveBeenCalledWith(-FAKE_PID, "SIGTERM");
    }
    expect(calls[0].groupKills).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when wrangler ignores SIGTERM", async () => {
    const calls = fakeWranglerSpawn(() => ({ hang: true, ignoreTerm: true }));
    const pending = failure(wranglerExec(["whoami"], { timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls[0].groupKills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(BOUNDED_KILL_GRACE_MS);
    const err = await pending;
    expect(err.message).toBe("wrangler whoami did not answer within 1s");
    expect(calls[0].groupKills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("settles even when a grandchild keeps the pipes open after the exit", async () => {
    const calls = fakeWranglerSpawn(() => ({
      hang: true,
      exitWithoutClose: true,
    }));
    const pending = failure(wranglerExec(["whoami"], { timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000 + STREAM_CLOSE_GRACE_MS);
    const err = await pending;
    expect(err).toBeInstanceOf(WranglerTimeoutError);
    expect(calls[0].destroyed).toBe(true);
  });

  it("maps a failed bounded run like any other wrangler failure", async () => {
    fakeWranglerSpawn(() => ({
      stderr: "✘ [ERROR] You need to provide a name for your Worker",
      exitCode: 1,
    }));
    const err = await failure(
      wranglerJson(["deployments", "list", "--json"], { timeoutMs: 1000 }),
    );
    expect(err.code).toBe("NOT_LINKED");
  });

  it("reports a missing binary as WRANGLER_NOT_INSTALLED", async () => {
    fakeWranglerSpawn(() => ({ enoent: true }));
    const err = await failure(wranglerExec(["whoami"], { timeoutMs: 1000 }));
    expect(err.code).toBe("WRANGLER_NOT_INSTALLED");
  });

  it("refuses stdin input, which a bounded run cannot pass", async () => {
    fakeWranglerSpawn(() => ({}));
    await expect(
      wranglerExec(["secret", "put", "K"], { timeoutMs: 1000, input: "v" }),
    ).rejects.toThrow("cannot take stdin input");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("forwards a Ctrl-C to wrangler's group, then re-raises it", async () => {
    const calls = fakeWranglerSpawn(() => ({ hang: true }));
    const before = process.listenerCount("SIGINT");
    const pending = failure(wranglerExec(["whoami"], { timeoutMs: 60_000 }));
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    process.emit("SIGINT", "SIGINT");
    expect(calls[0].groupKills).toEqual(["SIGTERM"]);
    expect(process.kill).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(process.listenerCount("SIGINT")).toBe(before);
    // The fake process survives the re-raise; the run still settles, well
    // before its 60s budget, and not as a timeout.
    const err = await pending;
    expect(err).not.toBeInstanceOf(WranglerTimeoutError);
  });

  it("removes its signal listeners once the run ends", async () => {
    fakeWranglerSpawn(() => ({ stdout: "ok" }));
    const before = process.listenerCount("SIGTERM");
    await wranglerExec(["whoami"], { timeoutMs: 1000 });
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("OAuth refresh (wrangler whoami) timeout", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bounded-wrangler-test-"));
    home.dir = dir;
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const configDir = join(dir, ".wrangler", "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "default.toml"),
      'oauth_token = "old"\nexpiration_time = "2000-01-01T00:00:00.000Z"\n',
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives up on a hung refresh and suggests an API token", async () => {
    const calls = fakeWranglerSpawn(() => ({ hang: true }));
    const pending = failure(resolveApiCredentials());
    await vi.advanceTimersByTimeAsync(WRANGLER_READ_TIMEOUT_MS);
    const err = await pending;
    expect(calls.map((c) => c.args)).toEqual([["whoami"]]);
    expect(err).toBeInstanceOf(WranglerTimeoutError);
    expect(err.message).toBe(
      `wrangler whoami did not answer within ${WRANGLER_READ_TIMEOUT_MS / 1000}s`,
    );
    const hints = err.suggestions.join("\n");
    expect(hints).toContain("refreshing the expired OAuth token");
    expect(hints).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("re-reads the refreshed token when whoami answers in time", async () => {
    fakeWranglerSpawn(() => {
      writeFileSync(
        join(dir, ".wrangler", "config", "default.toml"),
        'oauth_token = "new"\nexpiration_time = "2999-01-01T00:00:00.000Z"\n',
      );
      return { stdout: "You are logged in" };
    });
    const creds = await resolveApiCredentials();
    expect(creds.token).toBe("new");
    expect(creds.source).toBe("wrangler-oauth");
  });
});
