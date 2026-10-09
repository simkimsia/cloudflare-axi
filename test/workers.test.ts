import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the spawn layer: these tests never run the real wrangler binary.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { AxiError } from "../src/errors.js";
import { parseOutputEntries } from "../src/wrangler.js";
import {
  findWranglerConfig,
  parseBindings,
  parseUploadSize,
  redactValue,
  shellQuote,
  splitTargets,
  stdinSource,
  toSecretRows,
  workersCommand,
} from "../src/commands/workers.js";

// Real `wrangler deploy --dry-run --outdir X` stdout from family-haze-bot,
// wrangler 4.127.1, captured live 2026-10-09.
const DRY_RUN_STDOUT = [
  "",
  " ⛅️ wrangler 4.127.1 (update available 4.149.0)",
  "───────────────────────────────────────────────",
  "Total Upload: 181.11 KiB / gzip: 164.93 KiB",
  "Your Worker has access to the following bindings:",
  "Binding                                                    Resource                  ",
  "env.SETTINGS (8cd31376cd9a4223b6c49b94da311025)            KV Namespace              ",
  'env.DEFAULT_LAT ("1.3297")                                 Environment Variable      ',
  'env.DEFAULT_LON ("103.8985")                               Environment Variable      ',
  'env.DEFAULT_LABEL ("Ubi (东部 Timur)")                       Environment Variable      ',
  'env.BOT_USERNAME ("HazeKakiBot")                           Environment Variable      ',
  'env.EXERCISE_LIMIT ("150")                                 Environment Variable      ',
  "",
  "--dry-run: exiting now.",
  "",
].join("\n");

// Real ND-JSON written to WRANGLER_OUTPUT_FILE_PATH by the same dry run.
const DRY_RUN_NDJSON = [
  '{"type":"wrangler-session","version":1,"wrangler_version":"4.127.1","command_line_args":["deploy","--dry-run"],"log_file_path":"/Users/me/.wrangler/logs/wrangler.log","timestamp":"2026-10-09T07:24:03.796Z"}',
  '{"type":"deploy","version":1,"worker_name":"family-haze-bot","worker_tag":null,"version_id":null,"worker_name_overridden":false,"timestamp":"2026-10-09T07:24:03.968Z"}',
  "",
].join("\n");

// Shape from wrangler source (cli.js `deploy()` -> writeOutput, 4.127.1): a
// real deploy writes version_id, worker_tag and `targets` (workers.dev URL,
// routes, "schedule: <cron>").
const REAL_DEPLOY_ENTRY = {
  type: "deploy",
  version: 1,
  worker_name: "family-haze-bot",
  worker_tag: "abc123tag",
  version_id: "1f2e3d4c-0000-4000-8000-000000000001",
  targets: [
    "https://family-haze-bot.x.workers.dev",
    "schedule: */5 * * * *",
    "schedule: 15 9 * * *",
  ],
  worker_name_overridden: false,
};
const REAL_DEPLOY_NDJSON = [
  DRY_RUN_NDJSON.split("\n")[0],
  JSON.stringify(REAL_DEPLOY_ENTRY),
  "",
].join("\n");
const REAL_DEPLOY_STDOUT = `${DRY_RUN_STDOUT.replace("--dry-run: exiting now.\n", "")}Uploaded family-haze-bot (3.21 sec)
Deployed family-haze-bot triggers (1.02 sec)
  https://family-haze-bot.x.workers.dev
  schedule: */5 * * * *
  schedule: 15 9 * * *
Current Version ID: 1f2e3d4c-0000-4000-8000-000000000001
`;

// Real `wrangler secret list` stdout (JSON by default), captured 2026-10-09.
const SECRET_LIST_JSON = `[
  {
    "name": "TELEGRAM_BOT_TOKEN",
    "type": "secret_text"
  },
  {
    "name": "WEBHOOK_SECRET",
    "type": "secret_text"
  }
]
`;

const WORKER_NOT_FOUND_STDERR = `[31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mWorker "family-haze-bto" not found.[0m

  If this is a new Worker, run \`wrangler deploy\` first to create it.
  Otherwise, check that the Worker name is correct and you're logged into the right account.`;

// ---- fake wrangler ----

interface Call {
  args: string[];
  env?: Record<string, string | undefined>;
  stdin?: string;
}
interface Reply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  ndjson?: string;
}

function fakeWrangler(replies: (args: string[]) => Reply): Call[] {
  const calls: Call[] = [];
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    args: string[],
    opts: { env?: Record<string, string | undefined> },
    cb: (err: unknown, stdout: string, stderr: string) => void,
  ) => {
    const call: Call = { args, env: opts?.env };
    calls.push(call);
    const reply = replies(args);
    const outFile = opts?.env?.WRANGLER_OUTPUT_FILE_PATH;
    if (outFile && reply.ndjson) writeFileSync(outFile, reply.ndjson);
    setImmediate(() =>
      cb(
        reply.exitCode ? { code: reply.exitCode } : null,
        reply.stdout ?? "",
        reply.stderr ?? "",
      ),
    );
    return {
      stdin: {
        on: () => undefined,
        end: (input: string) => {
          call.stdin = input;
        },
      },
    };
  }) as never);
  return calls;
}

let dir: string;
let config: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "workers-test-"));
  config = join(dir, "wrangler.toml");
  writeFileSync(config, 'name = "family-haze-bot"\n');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(execFile).mockReset();
});

async function failure(promise: Promise<unknown>): Promise<AxiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AxiError);
    return error as AxiError;
  }
  throw new Error("expected a failure");
}

// ---- pure helpers ----

describe("parseBindings", () => {
  it("returns name and type per row and drops the values", () => {
    const rows = parseBindings(DRY_RUN_STDOUT);
    expect(rows).toEqual([
      { name: "SETTINGS", type: "KV Namespace" },
      { name: "DEFAULT_LAT", type: "Environment Variable" },
      { name: "DEFAULT_LON", type: "Environment Variable" },
      { name: "DEFAULT_LABEL", type: "Environment Variable" },
      { name: "BOT_USERNAME", type: "Environment Variable" },
      { name: "EXERCISE_LIMIT", type: "Environment Variable" },
    ]);
    const flat = JSON.stringify(rows);
    expect(flat).not.toContain("1.3297");
    expect(flat).not.toContain("8cd31376");
    expect(flat).not.toContain("HazeKakiBot");
  });

  it("strips ANSI first (FORCE_COLOR colors header and rows)", () => {
    // Shape from wrangler 4.127.1 source: dim2() header, white() name,
    // brandColor() type, dim2() value.
    const colored = [
      "\u001b[2mTotal Upload: 181.11 KiB / gzip: 164.93 KiB\u001b[22m",
      "Your Worker has access to the following bindings:",
      "\u001b[2mBinding\u001b[22m                                  \u001b[2mResource\u001b[22m      ",
      "\u001b[37menv.SETTINGS\u001b[39m (\u001b[2m8cd31376\u001b[22m)                    \u001b[38;5;214mKV Namespace\u001b[39m  ",
      "",
      "Current Version ID: \u001b[36mabc-123\u001b[39m",
    ].join("\n");
    expect(parseBindings(colored)).toEqual([
      { name: "SETTINGS", type: "KV Namespace" },
    ]);
    expect(parseUploadSize(colored)).toBe("181.11 KiB (gzip 164.93 KiB)");
  });

  it("returns [] when there is no bindings table", () => {
    expect(parseBindings("Total Upload: 1 KiB / gzip: 1 KiB\n")).toEqual([]);
  });
});

describe("parseUploadSize", () => {
  it("compacts the Total Upload line", () => {
    expect(parseUploadSize(DRY_RUN_STDOUT)).toBe(
      "181.11 KiB (gzip 164.93 KiB)",
    );
    expect(parseUploadSize("nothing")).toBeUndefined();
  });
});

describe("parseOutputEntries", () => {
  it("parses the real dry-run ND-JSON and skips garbage lines", () => {
    const entries = parseOutputEntries(`${DRY_RUN_NDJSON}not json\n{}\n`);
    expect(entries.map((e) => e.type)).toEqual(["wrangler-session", "deploy"]);
    expect(entries[1].worker_name).toBe("family-haze-bot");
    expect(entries[1].version_id).toBeNull();
  });

  it("parses a real-deploy entry (shape from wrangler source)", () => {
    const [, entry] = parseOutputEntries(REAL_DEPLOY_NDJSON);
    expect(entry.version_id).toBe(REAL_DEPLOY_ENTRY.version_id);
    expect(entry.targets).toEqual(REAL_DEPLOY_ENTRY.targets);
  });
});

describe("splitTargets", () => {
  it("splits urls, crons and other", () => {
    expect(
      splitTargets([
        ...REAL_DEPLOY_ENTRY.targets,
        "example.com/* (zone name: example.com)",
        "Producer for my-queue",
      ]),
    ).toEqual({
      urls: [
        "https://family-haze-bot.x.workers.dev",
        "example.com/* (zone name: example.com)",
      ],
      crons: ["*/5 * * * *", "15 9 * * *"],
      other: ["Producer for my-queue"],
    });
    expect(splitTargets(undefined)).toEqual({ urls: [], crons: [], other: [] });
  });

  it("does not report wrangler's >10 routes truncation marker as a URL", () => {
    expect(splitTargets(["example.com/a/*", "...and 5 more routes"])).toEqual({
      urls: ["example.com/a/*"],
      crons: [],
      other: ["...and 5 more routes"],
    });
  });
});

describe("toSecretRows", () => {
  it("keeps name and type from the real secret list JSON", () => {
    expect(toSecretRows(JSON.parse(SECRET_LIST_JSON))).toEqual([
      { name: "TELEGRAM_BOT_TOKEN", type: "secret_text" },
      { name: "WEBHOOK_SECRET", type: "secret_text" },
    ]);
  });
});

describe("redactValue", () => {
  it("replaces long values anywhere and short values only as whole tokens", () => {
    expect(redactValue("token=abcdefgh123 bad", "abcdefgh123\n")).toBe(
      "token=<redacted> bad",
    );
    expect(
      redactValue('Worker "no-such-worker-xyz-axi" not found. x', "x"),
    ).toBe('Worker "no-such-worker-xyz-axi" not found. <redacted>');
  });
});

describe("shellQuote", () => {
  it("leaves safe paths bare and single-quotes the rest", () => {
    expect(shellQuote("/a/b-c_d.e/wrangler.toml")).toBe(
      "/a/b-c_d.e/wrangler.toml",
    );
    expect(shellQuote("/my worker/wrangler.toml")).toBe(
      "'/my worker/wrangler.toml'",
    );
    expect(shellQuote("/it's/$HOME/w.toml")).toBe("'/it'\\''s/$HOME/w.toml'");
    expect(shellQuote("~/w.toml")).toBe("'~/w.toml'");
    expect(shellQuote("")).toBe("''");
  });
});

describe("findWranglerConfig", () => {
  it("finds a config in the dir or a parent, else undefined", () => {
    const child = join(dir, "src", "deep");
    mkdirSync(child, { recursive: true });
    expect(findWranglerConfig(dir)).toBe(config);
    expect(findWranglerConfig(child)).toBe(config);
    const empty = mkdtempSync(join(tmpdir(), "workers-none-"));
    try {
      // tmpdir() itself may sit under a dir with a config on some machines;
      // only assert when nothing is found above it.
      const found = findWranglerConfig(empty);
      if (found !== undefined) expect(found.startsWith(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---- deploy ----

describe("workers deploy", () => {
  it("rejects --message on deploy as an unknown flag", async () => {
    fakeWrangler(() => ({}));
    const err = await failure(
      workersCommand(["deploy", "--dry-run", "--message", "x"]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("--message");
  });

  it("refuses a real deploy without --name before spawning wrangler", async () => {
    const calls = fakeWrangler(() => ({}));
    const err = await failure(workersCommand(["deploy", "--config", config]));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("--name is required");
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing --config path before spawning wrangler", async () => {
    const calls = fakeWrangler(() => ({}));
    const err = await failure(
      workersCommand([
        "deploy",
        "--dry-run",
        "--config",
        join(dir, "nope.toml"),
      ]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(calls).toHaveLength(0);
  });

  it("is NOT_LINKED when no wrangler config is found from cwd", async () => {
    const calls = fakeWrangler(() => ({}));
    vi.spyOn(process, "cwd").mockReturnValue("/");
    const err = await failure(workersCommand(["deploy", "--dry-run"]));
    expect(err.code).toBe("NOT_LINKED");
    expect(calls).toHaveLength(0);
  });

  it("rejects --env and an entry-path positional", async () => {
    fakeWrangler(() => ({}));
    const env = await failure(
      workersCommand(["deploy", "--dry-run", "--env", "prod"]),
    );
    expect(env.code).toBe("VALIDATION_ERROR");
    expect(env.message).toContain("--env");
    const pos = await failure(
      workersCommand(["deploy", "src/worker.js", "--dry-run"]),
    );
    expect(pos.message).toContain("src/worker.js");
  });

  it("refuses a --name that differs from the config after only the dry run", async () => {
    const calls = fakeWrangler(() => ({
      stdout: DRY_RUN_STDOUT,
      ndjson: DRY_RUN_NDJSON,
    }));
    const err = await failure(
      workersCommand([
        "deploy",
        "--name",
        "family-haze-bto",
        "--config",
        config,
      ]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe(
      "--name family-haze-bto does not match the Worker this config deploys (family-haze-bot)",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--dry-run");
  });

  it("dry run: bundles only and renders worker, upload and bindings", async () => {
    const calls = fakeWrangler(() => ({
      stdout: DRY_RUN_STDOUT,
      ndjson: DRY_RUN_NDJSON,
    }));
    const out = await workersCommand([
      "deploy",
      "--dry-run",
      "--config",
      config,
      "--outdir",
      "dist",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "deploy",
      "--dry-run",
      "--config",
      config,
      "--outdir",
      "dist",
    ]);
    expect(calls[0].env?.WRANGLER_OUTPUT_FILE_PATH).toMatch(/out\.ndjson$/);
    expect(out).toContain("worker: family-haze-bot");
    expect(out).toContain("upload: 181.11 KiB (gzip 164.93 KiB)");
    expect(out).toContain("bindings[6]{name,type}:");
    expect(out).toContain("SETTINGS,KV Namespace");
    expect(out).not.toContain("1.3297");
    expect(out).toContain("workers deploy --name family-haze-bot");
  });

  it("real deploy: dry run, then deploy without forwarding --name", async () => {
    const calls = fakeWrangler((args) =>
      args.includes("--dry-run")
        ? { stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }
        : { stdout: REAL_DEPLOY_STDOUT, ndjson: REAL_DEPLOY_NDJSON },
    );
    const out = await workersCommand([
      "deploy",
      "--name",
      "family-haze-bot",
      "--config",
      config,
    ]);
    expect(calls.map((c) => c.args)).toEqual([
      ["deploy", "--dry-run", "--config", config],
      ["deploy", "--config", config],
    ]);
    for (const c of calls) {
      expect(c.args).not.toContain("--name");
      expect(c.env?.WRANGLER_OUTPUT_FILE_PATH).toBeTruthy();
      expect(c.stdin).toBe("");
    }
    expect(out).toContain("worker: family-haze-bot");
    expect(out).toContain(`version: ${REAL_DEPLOY_ENTRY.version_id}`);
    expect(out).toContain('urls[1]: "https://family-haze-bot.x.workers.dev"');
    expect(out).toContain("crons[2]: */5 * * * *,15 9 * * *");
    expect(out).toContain("bindings[6]{name,type}:");
  });

  it("states empty urls and crons in words", async () => {
    const entry = { ...REAL_DEPLOY_ENTRY, targets: [] };
    fakeWrangler((args) =>
      args.includes("--dry-run")
        ? { stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }
        : {
            stdout: REAL_DEPLOY_STDOUT,
            ndjson: `${DRY_RUN_NDJSON.split("\n")[0]}\n${JSON.stringify(entry)}\n`,
          },
    );
    const out = await workersCommand([
      "deploy",
      "--name",
      "family-haze-bot",
      "--config",
      config,
    ]);
    expect(out).toMatch(/urls: "?none \(workers_dev off/);
    expect(out).toContain("crons: none");
    expect(out).not.toContain("[]");
  });

  it("falls back to the stdout version id and reports urls/crons as unknown (not none) without a deploy entry", async () => {
    fakeWrangler((args) =>
      args.includes("--dry-run")
        ? { stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }
        : { stdout: REAL_DEPLOY_STDOUT },
    );
    const out = await workersCommand([
      "deploy",
      "--name",
      "family-haze-bot",
      "--config",
      config,
    ]);
    expect(out).toContain(`version: ${REAL_DEPLOY_ENTRY.version_id}`);
    expect(out).toMatch(
      /urls: "?unknown \(wrangler reported no deploy details\)/,
    );
    expect(out).toMatch(
      /crons: "?unknown \(wrangler reported no deploy details\)/,
    );
    expect(out).not.toContain("none (workers_dev");
    expect(out).not.toContain("crons: none");
    expect(out).toContain("cloudflare-axi deployments");
  });

  it("reports unknown when the deploy entry has no targets field", async () => {
    const { targets: _targets, ...entry } = REAL_DEPLOY_ENTRY;
    fakeWrangler((args) =>
      args.includes("--dry-run")
        ? { stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }
        : {
            stdout: REAL_DEPLOY_STDOUT,
            ndjson: `${JSON.stringify(entry)}\n`,
          },
    );
    const out = await workersCommand([
      "deploy",
      "--name",
      "family-haze-bot",
      "--config",
      config,
    ]);
    expect(out).toMatch(/urls: "?unknown/);
    expect(out).toMatch(/crons: "?unknown/);
  });

  it("is UNKNOWN when wrangler reports no version id", async () => {
    fakeWrangler((args) =>
      args.includes("--dry-run")
        ? { stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }
        : { stdout: "Uploaded family-haze-bot\n" },
    );
    const err = await failure(
      workersCommand([
        "deploy",
        "--name",
        "family-haze-bot",
        "--config",
        config,
      ]),
    );
    expect(err.code).toBe("UNKNOWN");
    expect(err.suggestions.join(" ")).toContain("cloudflare-axi deployments");
  });
});

// ---- --config carried into hints ----

describe("--config in follow-up hints", () => {
  let spaced: string;
  let quoted: string;
  beforeEach(() => {
    const sub = join(dir, "my worker");
    mkdirSync(sub);
    spaced = join(sub, "wrangler.toml");
    writeFileSync(spaced, 'name = "family-haze-bot"\n');
    quoted = `'${spaced}'`;
  });

  it("dry run -> real deploy hint carries a plain --config bare", async () => {
    fakeWrangler(() => ({ stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }));
    const out = await workersCommand([
      "deploy",
      "--dry-run",
      "--config",
      config,
    ]);
    expect(out).toContain(
      `workers deploy --name family-haze-bot --config ${config}\``,
    );
  });

  it("dry run -> real deploy hint single-quotes a path with spaces", async () => {
    fakeWrangler(() => ({ stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }));
    const out = await workersCommand([
      "deploy",
      "--dry-run",
      "--config",
      spaced,
    ]);
    expect(out).toContain(
      `workers deploy --name family-haze-bot --config ${quoted}\``,
    );
  });

  it("omits --config from hints when it was not passed", async () => {
    fakeWrangler(() => ({ stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const out = await workersCommand(["deploy", "--dry-run"]);
    expect(out).toContain("workers deploy --name family-haze-bot`");
    expect(out).not.toContain("--config");
  });

  it("real deploy hints carry --config and point deployments at the config's dir", async () => {
    fakeWrangler((args) =>
      args.includes("--dry-run")
        ? { stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }
        : { stdout: REAL_DEPLOY_STDOUT, ndjson: REAL_DEPLOY_NDJSON },
    );
    const out = await workersCommand([
      "deploy",
      "--name",
      "family-haze-bot",
      "--config",
      spaced,
    ]);
    expect(out).toContain(
      `workers secret list --name family-haze-bot --config ${quoted}\``,
    );
    expect(out).toContain(`from '${join(dir, "my worker")}'`);
  });

  it("refusals carry --config: missing --name and a mismatched --name", async () => {
    const calls = fakeWrangler(() => ({
      stdout: DRY_RUN_STDOUT,
      ndjson: DRY_RUN_NDJSON,
    }));
    const noName = await failure(
      workersCommand(["deploy", "--config", spaced]),
    );
    expect(noName.suggestions.join(" ")).toContain(
      `workers deploy --dry-run --config ${quoted}\``,
    );
    const mismatch = await failure(
      workersCommand([
        "deploy",
        "--name",
        "family-haze-bto",
        "--config",
        spaced,
      ]),
    );
    expect(mismatch.suggestions.join(" ")).toContain(
      `workers deploy --name family-haze-bot --config ${quoted}\``,
    );
    expect(calls).toHaveLength(1);
  });

  it("a config with no entry point is VALIDATION_ERROR with a --config hint", async () => {
    fakeWrangler(() => ({
      stderr:
        "\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mMissing entry-point to Worker script or to assets directory\u001b[0m\n",
      exitCode: 1,
    }));
    const err = await failure(
      workersCommand(["deploy", "--dry-run", "--config", spaced]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("wrangler config has no entry point");
    expect(err.suggestions.join(" ")).toContain('main = "src/index.ts"');
    expect(err.suggestions.join(" ")).toContain(
      `workers deploy --dry-run --config ${quoted}\``,
    );
  });

  it("secret list hints and mapped errors carry --config", async () => {
    fakeWrangler(() => ({ stdout: SECRET_LIST_JSON }));
    const out = await workersCommand(["secret", "list", "--config", spaced]);
    expect(out).toContain(`workers deploy --dry-run --config ${quoted}\``);
    expect(out).toContain(
      `secret put <KEY> --name <worker> --config ${quoted}\``,
    );

    vi.mocked(execFile).mockReset();
    fakeWrangler(() => ({ stderr: WORKER_NOT_FOUND_STDERR, exitCode: 1 }));
    const err = await failure(
      workersCommand(["secret", "list", "--name", "x", "--config", spaced]),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.suggestions.join(" ")).toContain(
      `workers deploy --dry-run --config ${quoted}\``,
    );
  });

  it("secret put success hint carries --config", async () => {
    vi.spyOn(stdinSource, "isTTY").mockReturnValue(false);
    vi.spyOn(stdinSource, "read").mockResolvedValue("v4lue-xyz");
    fakeWrangler((args) =>
      args[1] === "list"
        ? { stdout: SECRET_LIST_JSON }
        : { stdout: "✨ Success! Uploaded secret API_KEY\n" },
    );
    const out = await workersCommand([
      "secret",
      "put",
      "API_KEY",
      "--name",
      "family-haze-bot",
      "--config",
      spaced,
    ]);
    expect(out).toContain(
      `workers secret list --name family-haze-bot --config ${quoted}\``,
    );
  });
});

// ---- secret list ----

describe("workers secret list", () => {
  it("lists names and types", async () => {
    const calls = fakeWrangler(() => ({ stdout: SECRET_LIST_JSON }));
    const out = await workersCommand([
      "secret",
      "list",
      "--name",
      "family-haze-bot",
    ]);
    expect(calls[0].args).toEqual([
      "secret",
      "list",
      "--format",
      "json",
      "--name",
      "family-haze-bot",
    ]);
    expect(out).toContain("count: 2 secrets on family-haze-bot");
    expect(out).toContain("TELEGRAM_BOT_TOKEN,secret_text");
    expect(out).toContain("write-only");
  });

  it("says so when there are no secrets", async () => {
    fakeWrangler(() => ({ stdout: "[]" }));
    const out = await workersCommand(["secret", "list"]);
    expect(out).toContain(
      "secrets: 0 secrets on the Worker configured in this directory",
    );
    expect(out).toContain("workers deploy --dry-run` to see the Worker name");
  });

  it("names the Worker in hints when --name is given", async () => {
    fakeWrangler(() => ({ stdout: SECRET_LIST_JSON }));
    const out = await workersCommand([
      "secret",
      "list",
      "--name",
      "family-haze-bot",
    ]);
    expect(out).toContain("--name family-haze-bot");
    expect(out).not.toContain("--dry-run");
  });

  it("maps a missing Worker to NOT_FOUND", async () => {
    fakeWrangler(() => ({ stderr: WORKER_NOT_FOUND_STDERR, exitCode: 1 }));
    const err = await failure(
      workersCommand(["secret", "list", "--name", "family-haze-bto"]),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.suggestions.join(" ")).toContain("workers deploy --dry-run");
    expect(err.suggestions.join(" ")).not.toContain("secret list");
  });
});

// ---- secret put ----

const SECRET = "s3cr3t";

function pipeStdin(value: string, tty = false) {
  vi.spyOn(stdinSource, "isTTY").mockReturnValue(tty);
  vi.spyOn(stdinSource, "read").mockResolvedValue(value);
}

describe("workers secret put", () => {
  it("requires --name", async () => {
    pipeStdin(SECRET);
    const calls = fakeWrangler(() => ({}));
    const err = await failure(workersCommand(["secret", "put", "API_KEY"]));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("--name is required");
    expect(calls).toHaveLength(0);
  });

  it("refuses a TTY stdin and an empty stdin", async () => {
    const calls = fakeWrangler(() => ({}));
    pipeStdin("", true);
    const tty = await failure(
      workersCommand(["secret", "put", "API_KEY", "--name", "w"]),
    );
    expect(tty.message).toBe("secret value must be piped on stdin");
    vi.restoreAllMocks();
    pipeStdin("\n");
    const empty = await failure(
      workersCommand(["secret", "put", "API_KEY", "--name", "w"]),
    );
    expect(empty.message).toBe("secret value on stdin is empty");
    expect(calls).toHaveLength(0);
  });

  it.each([
    [["API_KEY", SECRET, "--name", "w"]],
    [["API_KEY", `--value=${SECRET}`, "--name", "w"]],
    [["API_KEY", "--value", SECRET, "--name", "w"]],
    [[`API_KEY=${SECRET}`, "--name", "w"]],
    [["API_KEY", `-${SECRET}`, "--name", "w"]],
    [["API_KEY", `--${SECRET}`, "--name", "w"]],
  ])("never echoes a value passed in argv: %j", async (argv) => {
    pipeStdin(SECRET);
    const calls = fakeWrangler(() => ({}));
    const err = await failure(workersCommand(["secret", "put", ...argv]));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify([err.message, err.suggestions])).not.toContain(
      SECRET,
    );
    expect(calls).toHaveLength(0);
  });

  it("names only exact known flags among the leftovers", async () => {
    pipeStdin(SECRET);
    fakeWrangler(() => ({}));
    const err = await failure(
      workersCommand([
        "secret",
        "put",
        "API_KEY",
        "--env=prod",
        `-${SECRET}`,
        "--name",
        "w",
      ]),
    );
    expect(err.message).toContain("(flags: --env)");
    expect(err.message).not.toContain(SECRET);
  });

  it("does not echo an unknown secret subcommand", async () => {
    const err = await failure(workersCommand(["secret", SECRET]));
    expect(err.message).not.toContain(SECRET);
  });

  it("stops at NOT_FOUND before any put (no draft Worker is created)", async () => {
    pipeStdin(SECRET);
    const calls = fakeWrangler(() => ({
      stderr: WORKER_NOT_FOUND_STDERR,
      exitCode: 1,
    }));
    const err = await failure(
      workersCommand(["secret", "put", "API_KEY", "--name", "family-haze-bto"]),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 2)).toEqual(["secret", "list"]);
  });

  it.each([
    ["TELEGRAM_BOT_TOKEN", "updated"],
    ["NEW_KEY", "created"],
  ])("puts %s with the value on stdin only (%s)", async (key, status) => {
    pipeStdin(`${SECRET}\n`);
    const debug: string[] = [];
    vi.stubEnv("AXI_DEBUG", "1");
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      debug.push(String(chunk));
      return true;
    });
    const calls = fakeWrangler((args) =>
      args[1] === "list"
        ? { stdout: SECRET_LIST_JSON }
        : { stdout: `✨ Success! Uploaded secret ${key}\n` },
    );
    const out = await workersCommand([
      "secret",
      "put",
      key,
      "--name",
      "family-haze-bot",
    ]);
    vi.unstubAllEnvs();
    expect(calls.map((c) => c.args)).toEqual([
      ["secret", "list", "--format", "json", "--name", "family-haze-bot"],
      ["secret", "put", key, "--name", "family-haze-bot"],
    ]);
    expect(calls[1].stdin).toBe(`${SECRET}\n`);
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(SECRET);
    expect(out).toContain(`status: ${status}`);
    expect(out).toContain(`secret: ${key}`);
    expect(out).not.toContain(SECRET);
    expect(debug.join("")).toContain("wrangler secret put");
    expect(debug.join("")).not.toContain(SECRET);
  });

  it("redacts the value if a wrangler error ever contains it", async () => {
    pipeStdin(SECRET);
    fakeWrangler((args) =>
      args[1] === "list"
        ? { stdout: SECRET_LIST_JSON }
        : { stderr: `✘ [ERROR] could not store ${SECRET}`, exitCode: 1 },
    );
    const err = await failure(
      workersCommand(["secret", "put", "API_KEY", "--name", "family-haze-bot"]),
    );
    expect(err.message).toBe("could not store <redacted>");
  });
});

// ---- bare workers ----

describe("workers (bare)", () => {
  it("rejects unknown args and subcommands", async () => {
    fakeWrangler(() => ({}));
    expect((await failure(workersCommand(["--bogus"]))).code).toBe(
      "VALIDATION_ERROR",
    );
    expect((await failure(workersCommand(["tail"]))).message).toContain(
      "unknown subcommand tail",
    );
  });

  it("prints the workers help and points at `deployments` without calling wrangler", async () => {
    const calls = fakeWrangler(() => ({}));
    const out = await workersCommand([]);
    expect(calls).toEqual([]);
    expect(out).toContain("usage: cloudflare-axi workers");
    expect(out).toContain("deploy, secret put <KEY>|list");
    expect(out).toContain(
      "Run `cloudflare-axi deployments` for recent deployments",
    );
  });
});
