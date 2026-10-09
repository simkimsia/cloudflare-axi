import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the spawn layer: these tests never run the real wrangler binary.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { liftLeadingConfig, main } from "../src/cli.js";
import { fakeWrangler } from "./fake-wrangler.js";

// Global `--config <path>` for directory-scoped commands (issue #38), driven
// end to end through the real CLI entry (`main`) with wrangler faked.

const DEPLOYMENTS_JSON = JSON.stringify([
  {
    id: "d1",
    source: "wrangler",
    author_email: "jane@example.com",
    created_on: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
    annotations: { "workers/message": "first" },
  },
  {
    id: "d2",
    source: "wrangler",
    author_email: "jane@example.com",
    created_on: new Date(Date.now() - 60 * 1000).toISOString(),
  },
]);

// Real stderr shape of `wrangler deployments list` with no config in cwd.
const NO_NAME_STDERR =
  '✘ [ERROR] You need to provide a name for your Worker. Either pass it as a cli arg with `--name <name>` or in your configuration file as `name = "<name>"`';

let dir: string;
let config: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "config-test-"));
  config = join(dir, "wrangler.toml");
  writeFileSync(config, 'name = "family-haze-bot"\nmain = "src/index.ts"\n');
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(execFile).mockReset();
  process.exitCode = undefined;
});

async function run(argv: string[]): Promise<{ out: string; code: number }> {
  let out = "";
  await main(argv, {
    write: (chunk: string) => {
      out += chunk;
    },
  });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out, code };
}

describe("deployments --config", () => {
  it("passes an absolute --config and runs wrangler from the config's directory", async () => {
    const calls = fakeWrangler(() => ({ stdout: DEPLOYMENTS_JSON }));
    const { out, code } = await run([
      "deployments",
      "--config",
      relative(process.cwd(), config),
    ]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "deployments",
      "list",
      "--json",
      "--config",
      config,
    ]);
    expect(calls[0].cwd).toBe(dir);
    expect(out).toContain("count: 2 deployments (newest first)");
    expect(out).toContain(`wrangler deployments status --config ${config}`);
  });

  it("accepts --config=<path>", async () => {
    const calls = fakeWrangler(() => ({ stdout: "[]" }));
    const { out, code } = await run(["deployments", `--config=${config}`]);
    expect(code).toBe(0);
    expect(calls[0].cwd).toBe(dir);
    expect(out).toContain(
      `deployments: 0 deployments found for the Worker configured in ${config}`,
    );
  });

  it("accepts --config ahead of the command (global position)", async () => {
    const calls = fakeWrangler(() => ({ stdout: DEPLOYMENTS_JSON }));
    const { code } = await run(["--config", config, "deployments"]);
    expect(code).toBe(0);
    expect(calls[0].args).toContain("--config");
    expect(calls[0].cwd).toBe(dir);
  });

  it("is VALIDATION_ERROR (exit 2) for a missing path, before wrangler", async () => {
    const calls = fakeWrangler(() => ({}));
    const { out, code } = await run([
      "deployments",
      "--config",
      join(dir, "nope.toml"),
    ]);
    expect(code).toBe(2);
    expect(decode(out.trim())).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(out).toContain("does not exist");
    expect(calls).toHaveLength(0);
  });

  it("is VALIDATION_ERROR for --config with no value", async () => {
    fakeWrangler(() => ({}));
    const { out, code } = await run(["deployments", "--config"]);
    expect(code).toBe(2);
    expect(out).toContain("--config requires a value");
  });

  it("still rejects other flags by name", async () => {
    fakeWrangler(() => ({}));
    const { out, code } = await run([
      "deployments",
      "--config",
      config,
      "--bogus",
    ]);
    expect(code).toBe(2);
    expect(out).toContain("unknown flag --bogus for `deployments`");
    expect(out).toContain("cloudflare-axi deployments [--config <path>]");
  });

  it("NOT_LINKED without --config suggests --config", async () => {
    fakeWrangler(() => ({ stderr: NO_NAME_STDERR, exitCode: 1 }));
    const { out, code } = await run(["deployments"]);
    expect(code).toBe(1);
    const parsed = decode(out.trim()) as { code: string; help: string[] };
    expect(parsed.code).toBe("NOT_LINKED");
    expect(parsed.help.join(" ")).toContain("--config <path>");
  });

  it("NOT_LINKED with --config names the config instead of 'this directory'", async () => {
    fakeWrangler(() => ({ stderr: NO_NAME_STDERR, exitCode: 1 }));
    const { out, code } = await run(["deployments", "--config", config]);
    expect(code).toBe(1);
    expect(out).toContain(`No Worker is configured in ${config}`);
    expect(out).not.toContain("this directory");
  });
});

describe("dashboard --config", () => {
  it("shows the Worker from the config and threads --config into the hints", async () => {
    const calls = fakeWrangler(() => ({ stdout: DEPLOYMENTS_JSON }));
    const { out, code } = await run(["--config", config]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "deployments",
      "list",
      "--json",
      "--config",
      config,
    ]);
    expect(calls[0].cwd).toBe(dir);
    expect(out).toContain(`worker: configured in ${config} (2 deployments)`);
    expect(out).toContain(`cloudflare-axi deployments --config ${config}`);
  });

  it("reports a failing --config Worker instead of falling back to Pages", async () => {
    const calls = fakeWrangler(() => ({ stderr: NO_NAME_STDERR, exitCode: 1 }));
    const { out, code } = await run([`--config=${config}`]);
    expect(code).toBe(1);
    expect(out).toContain("NOT_LINKED");
    expect(calls).toHaveLength(1);
  });

  it("is VALIDATION_ERROR for a missing --config path", async () => {
    const calls = fakeWrangler(() => ({}));
    const { out, code } = await run(["--config", join(dir, "nope.toml")]);
    expect(code).toBe(2);
    expect(out).toContain("VALIDATION_ERROR");
    expect(calls).toHaveLength(0);
  });

  it("without --config, falls back to Pages and mentions --config", async () => {
    const calls = fakeWrangler((args) =>
      args[0] === "deployments"
        ? { stderr: NO_NAME_STDERR, exitCode: 1 }
        : { stdout: "[]" },
    );
    const { out, code } = await run([]);
    expect(code).toBe(0);
    expect(calls.every((c) => c.cwd === undefined)).toBe(true);
    expect(out).toContain("worker: none configured in this directory");
    expect(out).toContain("cloudflare-axi --config <path>");
  });
});

describe("workers via a leading --config", () => {
  it("routes `--config x workers secret list` to the subcommand", async () => {
    const calls = fakeWrangler(() => ({ stdout: "[]" }));
    const { code } = await run([
      "--config",
      config,
      "workers",
      "secret",
      "list",
    ]);
    expect(code).toBe(0);
    expect(calls[0].args.slice(0, 2)).toEqual(["secret", "list"]);
    expect(calls[0].cwd).toBe(dir);
  });
});

describe("account-scoped commands reject --config", () => {
  it.each([["kv"], ["pages"], ["whoami"]])("%s", async (command) => {
    const calls = fakeWrangler(() => ({}));
    const { out, code } = await run(["--config", config, command]);
    expect(code).toBe(2);
    expect(out).toContain("--config");
    expect(out).toContain("VALIDATION_ERROR");
    expect(calls).toHaveLength(0);
  });
});

describe("liftLeadingConfig", () => {
  it("moves a leading --config behind the command and leaves other argv alone", () => {
    expect(
      liftLeadingConfig(["--config", "a.toml", "workers", "deploy"]),
    ).toEqual({
      argv: ["workers", "deploy", "--config", "a.toml"],
    });
    expect(liftLeadingConfig(["--config=a.toml", "deployments"])).toEqual({
      argv: ["deployments", "--config=a.toml"],
    });
    expect(liftLeadingConfig(["deployments", "--config", "a.toml"])).toEqual({
      argv: ["deployments", "--config", "a.toml"],
    });
    expect(liftLeadingConfig(["--config", "a.toml", "--help"])).toEqual({
      argv: ["--help"],
    });
  });
});
