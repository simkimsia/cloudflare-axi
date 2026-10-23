import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the spawn layer: these tests never run the real wrangler binary.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { findWranglerConfig, shellQuote } from "../src/config.js";
import { parseOutputEntries } from "../src/wrangler.js";
import { failure, fakeWrangler } from "./fake-wrangler.js";
import {
  listDependents,
  parseBindings,
  parseDeletedSiteNamespaces,
  parseUploadSize,
  redactValue,
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
      // wrangler runs from the config's dir, so a relative --outdir is
      // resolved against the caller's cwd first.
      resolve("dist"),
    ]);
    expect(calls[0].cwd).toBe(dir);
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

  it("real deploy hints carry --config into secret list and deployments", async () => {
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
    expect(out).toContain(`cloudflare-axi deployments --config ${quoted}\``);
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

  it("a raw wrangler hint runs from the config's directory too", async () => {
    // No deploy entry in the output file: wrangler named no Worker.
    fakeWrangler(() => ({ stdout: DRY_RUN_STDOUT }));
    const err = await failure(
      workersCommand([
        "deploy",
        "--name",
        "family-haze-bot",
        "--config",
        spaced,
      ]),
    );
    expect(err.code).toBe("UNKNOWN");
    expect(err.suggestions.join(" ")).toContain(
      `wrangler deploy --dry-run --cwd '${join(dir, "my worker")}' --config ${quoted}\``,
    );
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

  it("a missing `main` file is VALIDATION_ERROR with a --config hint (#43)", async () => {
    fakeWrangler(() => ({
      stderr:
        '\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mThe entry-point file at "src/worker.js" was not found.\u001b[0m\n\n  \n  This might mean that your entry-point file needs to be generated (which is the general case when a framework is being used).\n',
      exitCode: 1,
    }));
    const err = await failure(
      workersCommand(["deploy", "--dry-run", "--config", spaced]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("entry-point file src/worker.js not found");
    expect(err.suggestions.join(" ")).toContain(
      `workers deploy --dry-run --config ${quoted}\``,
    );
  });

  it("a missing [assets] directory is VALIDATION_ERROR with a --config hint (#44)", async () => {
    const assetsDir = join(dir, "my worker", "public");
    fakeWrangler(() => ({
      stderr: `\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mThe directory specified by the "assets.directory" field in your configuration file does not exist:\u001b[0m\n\n  ${assetsDir}\n\n\n`,
      exitCode: 1,
    }));
    const err = await failure(
      workersCommand(["deploy", "--dry-run", "--config", spaced]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe(`[assets] directory ${assetsDir} does not exist`);
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

  it("points the --name hint at the absolute config path", async () => {
    pipeStdin(SECRET);
    fakeWrangler(() => ({}));
    const err = await failure(
      workersCommand([
        "secret",
        "put",
        "API_KEY",
        "--config",
        "../w/wrangler.toml",
      ]),
    );
    expect(err.suggestions).toContain(
      `Run \`cloudflare-axi workers deploy --dry-run --config ${shellQuote(resolve("../w/wrangler.toml"))}\` to see the Worker name this config deploys`,
    );
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
    expect((await failure(workersCommand(["logs"]))).message).toContain(
      "unknown subcommand logs",
    );
  });

  it("prints the workers help and points at `deployments` without calling wrangler", async () => {
    const calls = fakeWrangler(() => ({}));
    const out = await workersCommand([]);
    expect(calls).toEqual([]);
    expect(out).toContain("usage: cloudflare-axi workers");
    expect(out).toContain(
      "deploy, delete, tail, secret put <KEY>|list|delete <KEY>",
    );
    expect(out).toContain(
      "Run `cloudflare-axi deployments` for recent deployments",
    );
  });
});

// ---- --config (issue #38) ----

describe("workers --config", () => {
  it("runs every wrangler call from the config's directory with an absolute --config", async () => {
    const calls = fakeWrangler((args) =>
      args.includes("--dry-run")
        ? { stdout: DRY_RUN_STDOUT, ndjson: DRY_RUN_NDJSON }
        : { stdout: REAL_DEPLOY_STDOUT, ndjson: REAL_DEPLOY_NDJSON },
    );
    // A relative path, as an agent in another directory would pass it.
    const rel = relative(process.cwd(), config);
    const out = await workersCommand([
      "deploy",
      "--name",
      "family-haze-bot",
      "--config",
      rel,
    ]);
    expect(calls.map((c) => c.args)).toEqual([
      ["deploy", "--dry-run", "--config", config],
      ["deploy", "--config", config],
    ]);
    expect(calls.map((c) => c.cwd)).toEqual([dir, dir]);
    // Next steps keep working without a cd.
    expect(out).toContain(`cloudflare-axi deployments --config ${config}`);
    expect(out).toContain(
      `workers secret list --name family-haze-bot --config ${config}`,
    );
  });

  it("does not need a config in cwd when --config is given", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/");
    const calls = fakeWrangler(() => ({
      stdout: DRY_RUN_STDOUT,
      ndjson: DRY_RUN_NDJSON,
    }));
    const out = await workersCommand([
      "deploy",
      "--dry-run",
      "--config",
      config,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(dir);
    expect(out).toContain(
      `workers deploy --name family-haze-bot --config ${config}`,
    );
  });

  it("leaves cwd alone without --config", async () => {
    const calls = fakeWrangler(() => ({ stdout: SECRET_LIST_JSON }));
    await workersCommand(["secret", "list", "--name", "family-haze-bot"]);
    expect(calls[0].cwd).toBeUndefined();
    expect(calls[0].args).not.toContain("--config");
  });

  it("secret list passes --config and runs from its directory", async () => {
    const calls = fakeWrangler(() => ({ stdout: "[]" }));
    const out = await workersCommand(["secret", "list", "--config", config]);
    expect(calls[0].args).toEqual([
      "secret",
      "list",
      "--format",
      "json",
      "--config",
      config,
    ]);
    expect(calls[0].cwd).toBe(dir);
    expect(out).toContain(
      `secrets: 0 secrets on the Worker configured in ${config}`,
    );
    expect(out).toContain(`workers deploy --dry-run --config ${config}`);
  });

  it("secret put prechecks and puts from the config's directory", async () => {
    vi.spyOn(stdinSource, "isTTY").mockReturnValue(false);
    vi.spyOn(stdinSource, "read").mockResolvedValue("s3cr3t-value");
    const calls = fakeWrangler((args) =>
      args[1] === "list"
        ? { stdout: SECRET_LIST_JSON }
        : { stdout: "✨ Success! Uploaded secret NEW_KEY\n" },
    );
    const out = await workersCommand([
      "secret",
      "put",
      "NEW_KEY",
      "--name",
      "family-haze-bot",
      "--config",
      config,
    ]);
    expect(calls.map((c) => c.args)).toEqual([
      [
        "secret",
        "list",
        "--format",
        "json",
        "--name",
        "family-haze-bot",
        "--config",
        config,
      ],
      [
        "secret",
        "put",
        "NEW_KEY",
        "--name",
        "family-haze-bot",
        "--config",
        config,
      ],
    ]);
    expect(calls.map((c) => c.cwd)).toEqual([dir, dir]);
    expect(calls[1].stdin).toBe("s3cr3t-value");
    expect(out).toContain(`--config ${config}`);
  });

  it.each([
    ["deploy", ["deploy", "--dry-run"]],
    ["secret list", ["secret", "list"]],
  ])(
    "%s: a missing --config path is VALIDATION_ERROR before wrangler",
    async (_label, argv) => {
      const calls = fakeWrangler(() => ({}));
      const err = await failure(
        workersCommand([...argv, "--config", join(dir, "nope.toml")]),
      );
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.message).toContain("does not exist");
      expect(calls).toHaveLength(0);
    },
  );

  it("secret put: a missing --config path is VALIDATION_ERROR before any wrangler call", async () => {
    vi.spyOn(stdinSource, "isTTY").mockReturnValue(false);
    vi.spyOn(stdinSource, "read").mockResolvedValue("s3cr3t-value");
    const calls = fakeWrangler(() => ({}));
    const err = await failure(
      workersCommand([
        "secret",
        "put",
        "K",
        "--name",
        "w",
        "--config",
        join(dir, "nope.toml"),
      ]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(calls).toHaveLength(0);
  });

  it("a directory --config names the config file inside it", async () => {
    const calls = fakeWrangler(() => ({}));
    const err = await failure(
      workersCommand(["deploy", "--dry-run", "--config", dir]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("is a directory");
    expect(err.suggestions).toEqual([`Use \`--config ${config}\``]);
    expect(calls).toHaveLength(0);
  });

  it("NOT_LINKED from a config with no Worker name names the config", async () => {
    fakeWrangler(() => ({
      stderr:
        "✘ [ERROR] Required Worker name missing. Please specify the Worker name in your Wrangler configuration file, or pass it as an argument with `--name <worker-name>`",
      exitCode: 1,
    }));
    const err = await failure(
      workersCommand(["secret", "list", "--config", config]),
    );
    expect(err.code).toBe("NOT_LINKED");
    expect(err.message).toBe(
      `No Worker is configured in ${config} (wrangler found no Worker name in it)`,
    );
  });

  it("NOT_LINKED without --config suggests --config", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/");
    fakeWrangler(() => ({}));
    const err = await failure(workersCommand(["deploy", "--dry-run"]));
    expect(err.code).toBe("NOT_LINKED");
    expect(err.suggestions.join(" ")).toContain("--config <path>");
  });
});

// ---- delete (issue #47) ----

const WORKER = "axi-smoke-20261012-worker";
// `wrangler delete` stdout shape from wrangler 4.127.1 source (src/delete.ts):
// "Successfully deleted <name>", after one line per Workers Sites asset
// namespace it removed.
const DELETE_STDOUT = `\n ⛅️ wrangler 4.127.1\n───────────────────\n🌀 Deleted asset namespace for Workers Site "__${WORKER}-workers_sites_assets"\nSuccessfully deleted ${WORKER}\n`;
// The same 'Worker "x" not found.' stderr with real ANSI escapes.
const MISSING_WORKER_STDERR =
  '\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mWorker "family-haze-bto" not found.\u001b[0m\n\n  If this is a new Worker, run `wrangler deploy` first to create it.';
const SECRET_DELETE_STDOUT = `🌀 Deleting the secret WEBHOOK_SECRET on the Worker ${WORKER}\n✨ Success! Deleted secret WEBHOOK_SECRET\n`;
const ok = (result: unknown) =>
  new Response(
    JSON.stringify({ success: true, errors: [], messages: [], result }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
const NO_REFERENCES = {
  services: { incoming: [], pages_function: false },
  durable_objects: [],
  dispatch_outbounds: [],
};

/** Stub the REST API: references and tail consumers for the Worker in account "acc". */
function stubApi(references: unknown = NO_REFERENCES, tails: unknown = []) {
  const paths: string[] = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      paths.push(path);
      if (path.endsWith("/references")) return ok(references);
      if (path.includes("/tails/by-consumer/")) return ok(tails);
      if (path.startsWith("/accounts?"))
        return ok([{ id: "solo", name: "Solo" }]);
      return new Response("{}", { status: 404 });
    }),
  );
  return paths;
}

describe("listDependents", () => {
  it("names every kind of dependent wrangler checks for", () => {
    const lines = listDependents(
      "api",
      {
        services: {
          incoming: [{ service: "web", environment: "production" }],
          pages_function: true,
        },
        durable_objects: [
          { service: "api", durable_object_namespace_name: "SELF" },
          { script: "chat", durable_object_namespace_name: "ROOMS" },
        ],
        dispatch_outbounds: [{ service: "router", namespace: "tenants" }],
      },
      [{ producer: { script: "logger" } }],
    );
    expect(lines).toEqual([
      "Worker web (production) uses it as a Service Binding",
      "A Pages project has a Service Binding to it",
      'Worker chat binds the Durable Object namespace "ROOMS" it implements',
      'Worker router uses it as the Outbound Worker of dispatch namespace "tenants"',
      "Worker logger uses it as a Tail Worker",
    ]);
  });

  it("is empty for a Worker nothing depends on", () => {
    expect(listDependents("api", NO_REFERENCES, [])).toEqual([]);
    expect(listDependents("api", {}, [])).toEqual([]);
  });
});

describe("parseDeletedSiteNamespaces", () => {
  it("picks the Workers Sites namespaces wrangler deleted", () => {
    expect(parseDeletedSiteNamespaces(DELETE_STDOUT)).toEqual([
      `__${WORKER}-workers_sites_assets`,
    ]);
    expect(parseDeletedSiteNamespaces("Successfully deleted x\n")).toEqual([]);
  });
});

describe("workers delete", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("requires --name and never falls back to the cwd config", async () => {
    const calls = fakeWrangler(() => ({}));
    const err = await failure(workersCommand(["delete"]));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("--name is required");
    expect(err.suggestions.join(" ")).toContain("workers deploy --dry-run");
    expect(calls).toHaveLength(0);
  });

  it("rejects a positional name and unknown flags before any call", async () => {
    const calls = fakeWrangler(() => ({}));
    expect(
      (await failure(workersCommand(["delete", WORKER]))).message,
    ).toContain(`unexpected argument ${WORKER}`);
    expect(
      (await failure(workersCommand(["delete", "--name", WORKER, "--yes"])))
        .message,
    ).toContain("unknown flag --yes");
    expect(calls).toHaveLength(0);
  });

  it("checks existence and dependents, then deletes with --force so wrangler never prompts", async () => {
    const paths = stubApi();
    const calls = fakeWrangler((args) =>
      args[0] === "secret"
        ? { stdout: SECRET_LIST_JSON }
        : { stdout: DELETE_STDOUT },
    );
    const out = await workersCommand(["delete", "--name", WORKER]);
    expect(calls.map((c) => c.args)).toEqual([
      ["secret", "list", "--format", "json", "--name", WORKER],
      ["delete", "--name", WORKER, "--force"],
    ]);
    expect(paths).toEqual([
      `/accounts/acc/workers/scripts/${WORKER}/references`,
      `/accounts/acc/workers/tails/by-consumer/${WORKER}`,
    ]);
    expect(out).toContain(`worker: ${WORKER}`);
    expect(out).toContain("status: deleted");
    expect(out).toContain("secrets: 2");
    expect(out).toContain("cron triggers, routes");
    expect(out).toContain(`__${WORKER}-workers_sites_assets`);
    expect(out).toContain(
      `cloudflare-axi workers secret list --name ${WORKER}\` to confirm it is gone`,
    );
    expect(out).not.toContain("not checked");
  });

  it("is NOT_FOUND for an unknown Worker, with nothing deleted", async () => {
    const paths = stubApi();
    const calls = fakeWrangler(() => ({
      stderr: MISSING_WORKER_STDERR,
      exitCode: 1,
    }));
    const err = await failure(
      workersCommand(["delete", "--name", "family-haze-bto"]),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe(
      'Worker "family-haze-bto" not found; nothing deleted',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 2)).toEqual(["secret", "list"]);
    expect(paths).toEqual([]);
  });

  it("refuses a Worker other Workers depend on and names them", async () => {
    stubApi({ services: { incoming: [{ service: "web", environment: "" }] } }, [
      { producer: { script: "logger" } },
    ]);
    const calls = fakeWrangler(() => ({ stdout: "[]" }));
    const err = await failure(workersCommand(["delete", "--name", WORKER]));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe(
      `Worker ${WORKER} is in use by other Workers; nothing deleted`,
    );
    expect(err.suggestions).toContain(
      "Worker web uses it as a Service Binding",
    );
    expect(err.suggestions).toContain("Worker logger uses it as a Tail Worker");
    expect(err.suggestions.join(" ")).toContain(
      `workers delete --name ${WORKER} --force`,
    );
    expect(calls.map((c) => c.args[0])).toEqual(["secret"]);
  });

  it("--force skips the dependents check and says so", async () => {
    const paths = stubApi();
    const calls = fakeWrangler((args) =>
      args[0] === "secret" ? { stdout: "[]" } : { stdout: DELETE_STDOUT },
    );
    const out = await workersCommand(["delete", "--name", WORKER, "--force"]);
    expect(paths).toEqual([]);
    expect(calls[1].args).toEqual(["delete", "--name", WORKER, "--force"]);
    expect(out).toContain("secrets: 0");
    expect(out).toContain("dependents: not checked (--force)");
  });

  it("is UNKNOWN when wrangler does not confirm the delete", async () => {
    stubApi();
    fakeWrangler((args) =>
      args[0] === "secret" ? { stdout: "[]" } : { stdout: "something else\n" },
    );
    const err = await failure(workersCommand(["delete", "--name", WORKER]));
    expect(err.code).toBe("UNKNOWN");
    expect(err.suggestions.join(" ")).toContain("secret list --name");
  });

  it("carries --config into wrangler and the hints", async () => {
    stubApi();
    const calls = fakeWrangler((args) =>
      args[0] === "secret" ? { stdout: "[]" } : { stdout: DELETE_STDOUT },
    );
    const out = await workersCommand([
      "delete",
      "--name",
      WORKER,
      "--config",
      config,
    ]);
    expect(calls[1].args).toEqual([
      "delete",
      "--name",
      WORKER,
      "--force",
      "--config",
      config,
    ]);
    expect(calls[1].cwd).toBe(dir);
    expect(out).toContain(`--name ${WORKER} --config ${shellQuote(config)}`);
  });
});

describe("workers delete account resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const deleteCalls = () =>
    fakeWrangler((args) =>
      args[0] === "secret" ? { stdout: "[]" } : { stdout: DELETE_STDOUT },
    );
  const dependentPaths = (account: string) => [
    `/accounts/${account}/workers/scripts/${WORKER}/references`,
    `/accounts/${account}/workers/tails/by-consumer/${WORKER}`,
  ];

  it("uses the --config account_id over CLOUDFLARE_ACCOUNT_ID, like wrangler", async () => {
    writeFileSync(
      config,
      'name = "x"\naccount_id = "cfgacc" # pinned\n\n[env.staging]\naccount_id = "stage"\n',
    );
    const paths = stubApi();
    deleteCalls();
    await workersCommand(["delete", "--name", WORKER, "--config", config]);
    expect(paths).toEqual(dependentPaths("cfgacc"));
  });

  it.each([
    ['"account_id" = "quoted"', "quoted"],
    ["'account_id' = 'quoted'", "quoted"],
    ['account_id = """multi"""', "multi"],
  ])("reads a TOML account_id written as %s", async (line, account) => {
    writeFileSync(config, `name = "x"\n${line}\n`);
    const paths = stubApi();
    deleteCalls();
    await workersCommand(["delete", "--name", WORKER, "--config", config]);
    expect(paths).toEqual(dependentPaths(account));
  });

  it("refuses an unparseable TOML config before any delete", async () => {
    writeFileSync(config, 'name = "x"\naccount_id = \n');
    const paths = stubApi();
    const calls = deleteCalls();
    const err = await failure(
      workersCommand(["delete", "--name", WORKER, "--config", config]),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(paths).toEqual([]);
    expect(calls.map((c) => c.args[0])).toEqual(["secret"]);
  });

  it("reads account_id from a JSONC config with comments and trailing commas", async () => {
    const jsonc = join(dir, "wrangler.jsonc");
    writeFileSync(
      jsonc,
      '{\n  // the Worker\n  "name": "x", /* "account_id": "no" */\n  "main": "src//index.ts",\n  "account_id": "jsonacc",\n}\n',
    );
    const paths = stubApi();
    deleteCalls();
    await workersCommand(["delete", "--name", WORKER, "--config", jsonc]);
    expect(paths).toEqual(dependentPaths("jsonacc"));
  });

  it("finds the cwd config's account_id when no --config is given", async () => {
    writeFileSync(config, 'name = "x"\naccount_id = "cwdacc"\n');
    const nested = join(dir, "src");
    mkdirSync(nested);
    vi.spyOn(process, "cwd").mockReturnValue(nested);
    const paths = stubApi();
    deleteCalls();
    await workersCommand(["delete", "--name", WORKER]);
    expect(paths).toEqual(dependentPaths("cwdacc"));
  });

  it("falls back to CLOUDFLARE_ACCOUNT_ID when the config has no account_id", async () => {
    const paths = stubApi();
    deleteCalls();
    await workersCommand(["delete", "--name", WORKER, "--config", config]);
    expect(paths).toEqual(dependentPaths("acc"));
  });

  it("with no config at all, uses CLOUDFLARE_ACCOUNT_ID, else the token's sole account", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/");
    const paths = stubApi();
    deleteCalls();
    await workersCommand(["delete", "--name", WORKER]);
    expect(paths).toEqual(dependentPaths("acc"));

    paths.length = 0;
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    await workersCommand(["delete", "--name", WORKER]);
    expect(paths).toEqual(["/accounts?per_page=50", ...dependentPaths("solo")]);
  });

  it("refuses with nothing deleted when several accounts are visible and none is pinned", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/");
    stubApi();
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok([
          { id: "a1", name: "One" },
          { id: "a2", name: "Two" },
        ]),
      ),
    );
    const calls = deleteCalls();
    const err = await failure(workersCommand(["delete", "--name", WORKER]));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("nothing deleted");
    expect(calls.map((c) => c.args[0])).toEqual(["secret"]);
  });
});

describe("workers secret delete", () => {
  it("deletes an exactly named secret after a read-only precheck", async () => {
    const calls = fakeWrangler((args) =>
      args[1] === "list"
        ? { stdout: SECRET_LIST_JSON }
        : { stdout: SECRET_DELETE_STDOUT },
    );
    const out = await workersCommand([
      "secret",
      "delete",
      "WEBHOOK_SECRET",
      "--name",
      WORKER,
    ]);
    expect(calls.map((c) => c.args)).toEqual([
      ["secret", "list", "--format", "json", "--name", WORKER],
      ["secret", "delete", "WEBHOOK_SECRET", "--name", WORKER],
    ]);
    expect(out).toContain("secret: WEBHOOK_SECRET");
    expect(out).toContain("status: deleted");
    expect(out).toContain("secrets_left: 1");
    expect(out).toContain(`workers secret list --name ${WORKER}`);
  });

  it("is NOT_FOUND for a secret that does not match exactly, with nothing deleted", async () => {
    const calls = fakeWrangler(() => ({ stdout: SECRET_LIST_JSON }));
    const err = await failure(
      workersCommand(["secret", "delete", "webhook_secret", "--name", WORKER]),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe(
      `secret webhook_secret not found on Worker ${WORKER}; nothing deleted`,
    );
    expect(calls).toHaveLength(1);
  });

  it("is NOT_FOUND for an unknown Worker and never reaches the delete", async () => {
    const calls = fakeWrangler(() => ({
      stderr: MISSING_WORKER_STDERR,
      exitCode: 1,
    }));
    const err = await failure(
      workersCommand([
        "secret",
        "delete",
        "API_KEY",
        "--name",
        "family-haze-bto",
      ]),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("nothing deleted");
    expect(calls).toHaveLength(1);
  });

  it("requires KEY and --name, and never echoes stray input", async () => {
    const calls = fakeWrangler(() => ({}));
    expect(
      (await failure(workersCommand(["secret", "delete", "--name", WORKER])))
        .message,
    ).toBe("secret name <KEY> is required");
    expect(
      (await failure(workersCommand(["secret", "delete", "API_KEY"]))).message,
    ).toBe("--name is required");
    const stray = await failure(
      workersCommand(["secret", "delete", "API_KEY", SECRET, "--name", WORKER]),
    );
    expect(stray.code).toBe("VALIDATION_ERROR");
    expect(stray.message).not.toContain(SECRET);
    const kv = await failure(
      workersCommand([
        "secret",
        "delete",
        `API_KEY=${SECRET}`,
        "--name",
        WORKER,
      ]),
    );
    expect(kv.message).not.toContain(SECRET);
    expect(calls).toHaveLength(0);
  });

  it("is UNKNOWN when wrangler does not confirm the delete", async () => {
    fakeWrangler((args) =>
      args[1] === "list" ? { stdout: SECRET_LIST_JSON } : { stdout: "" },
    );
    const err = await failure(
      workersCommand(["secret", "delete", "WEBHOOK_SECRET", "--name", WORKER]),
    );
    expect(err.code).toBe("UNKNOWN");
  });

  it("lists delete among the secret subcommands", async () => {
    const err = await failure(workersCommand(["secret", "rotate"]));
    expect(err.suggestions).toContain("subcommands: put, list, delete");
  });
});
