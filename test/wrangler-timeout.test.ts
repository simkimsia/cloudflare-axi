import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUN_KILL_GRACE_MS,
  WranglerTimeoutError,
  wranglerExec,
  wranglerJson,
} from "../src/wrangler.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

/** A wrangler that never exits on its own, recording the signals it gets. */
function hangingWrangler() {
  const kills: string[] = [];
  const destroyed: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: { on: () => undefined, end: () => undefined },
    stdout: { destroy: () => destroyed.push("stdout") },
    stderr: { destroy: () => destroyed.push("stderr") },
    kill: (sig: string) => {
      kills.push(sig);
      return true;
    },
  });
  vi.mocked(execFile).mockImplementation((() => child) as never);
  return { child, kills, destroyed };
}

describe("wrangler spawn timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(execFile).mockReset();
  });

  it("gives up after timeoutMs: SIGTERM, then SIGKILL after the grace", async () => {
    vi.useFakeTimers();
    const { kills, destroyed } = hangingWrangler();
    const result = wranglerJson(["pages", "project", "list", "--json"], {
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const err = await result;
    expect(err).toBeInstanceOf(WranglerTimeoutError);
    expect((err as WranglerTimeoutError).code).toBe("UNKNOWN");
    expect((err as WranglerTimeoutError).message).toBe(
      "wrangler pages project list did not answer within 20s",
    );
    expect(kills).toEqual(["SIGTERM"]);
    expect(destroyed).toEqual(["stdout", "stderr"]);

    await vi.advanceTimersByTimeAsync(RUN_KILL_GRACE_MS);
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("skips SIGKILL when wrangler exited on SIGTERM", async () => {
    vi.useFakeTimers();
    const { child, kills } = hangingWrangler();
    const result = wranglerExec(["whoami"], { timeoutMs: 100 }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(((await result) as Error).message).toBe(
      "wrangler whoami did not answer within 0.1s",
    );
    child.signalCode = "SIGTERM";
    await vi.advanceTimersByTimeAsync(RUN_KILL_GRACE_MS);
    expect(kills).toEqual(["SIGTERM"]);
  });

  it("clears the timer when wrangler answers in time", async () => {
    vi.useFakeTimers();
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: unknown, stdout: string, stderr: string) => void,
    ) => {
      setTimeout(() => cb(null, "[]", ""), 10);
      return {
        stdin: { on: () => undefined, end: () => undefined },
        kill: () => {
          throw new Error("must not be killed");
        },
      };
    }) as never);
    const result = wranglerJson(["kv", "namespace", "list"], {
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("dashboard with a hung wrangler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.mocked(execFile).mockReset();
  });

  it("still renders, saying which wrangler calls timed out", async () => {
    vi.useFakeTimers();
    const { kills } = hangingWrangler();
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const { homeCommand, HOME_WRANGLER_TIMEOUT_MS } =
      await import("../src/commands/home.js");
    const output = homeCommand();
    await vi.advanceTimersByTimeAsync(2 * HOME_WRANGLER_TIMEOUT_MS);
    const text = await output;
    expect(text).toContain(
      "worker: unknown (wrangler deployments list did not answer within 20s)",
    );
    expect(text).toContain(
      "projects: could not list (wrangler did not answer within 20s)",
    );
    expect(text).toContain("cloudflare-axi deployments");
    expect(kills.filter((k) => k === "SIGTERM")).toHaveLength(2);
  });
});
