import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the spawn layer: these tests never run the real wrangler binary.
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { workersCommand } from "../src/commands/workers.js";
import {
  JsonObjectStream,
  describeTrigger,
  parseDuration,
  redactSecrets,
  safePath,
  toTailRow,
} from "../src/commands/workers-tail.js";
import { failure } from "./fake-wrangler.js";

// Event shapes follow wrangler 4.127.1 `src/tail/createTail.ts`
// (TailEventMessage: outcome, scriptName, exceptions, logs, eventTimestamp,
// event), printed by `jsonPrintLogs` as JSON.stringify(event, null, 4).
const T0 = Date.UTC(2026, 9, 23, 8, 5, 0);

const FETCH_EVENT = {
  outcome: "ok",
  scriptName: "family-haze-bot",
  diagnosticsChannelEvents: [],
  exceptions: [],
  logs: [
    {
      message: ["webhook update", { chat: 42 }],
      level: "log",
      timestamp: T0 + 10,
    },
  ],
  eventTimestamp: T0,
  event: {
    request: {
      url: "https://family-haze-bot.x.workers.dev/webhook?secret_token=abc123",
      method: "POST",
      headers: {
        authorization: "Bearer sk-live-REALSECRET",
        cookie: "session=COOKIESECRET",
        "content-type": "application/json",
      },
      cf: { colo: "SIN", clientTcpRtt: 3 },
    },
    response: { status: 200 },
  },
};

const CRON_EVENT = {
  outcome: "ok",
  scriptName: "family-haze-bot",
  diagnosticsChannelEvents: [],
  exceptions: [],
  logs: [{ message: ["pm2.5 east=12"], level: "info", timestamp: T0 + 60 }],
  eventTimestamp: T0 + 300_000,
  event: { cron: "*/5 * * * *", scheduledTime: T0 + 300_000 },
};

const ERROR_EVENT = {
  outcome: "exception",
  scriptName: "family-haze-bot",
  diagnosticsChannelEvents: [],
  exceptions: [
    {
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'id')",
      timestamp: T0 + 5,
      stack: "TypeError: ...\n    at worker.js:10:3",
    },
  ],
  logs: [
    {
      message: ['calling api with token=hunter2 {braces} "quoted"'],
      level: "error",
      timestamp: T0 + 4,
    },
  ],
  eventTimestamp: T0 + 1000,
  event: {
    request: {
      url: "https://family-haze-bot.x.workers.dev/",
      method: "get",
      headers: {},
    },
    response: { status: 500 },
  },
};

const json = (e: unknown) => `${JSON.stringify(e, null, 4)}\n`;

interface Script {
  /** stdout chunks, emitted right after spawn. */
  chunks?: string[];
  stderr?: string;
  /** Exit by itself with this code after the chunks; omit to run until killed. */
  exit?: number;
  /** Ignore SIGTERM (only SIGKILL ends it). */
  ignoreTerm?: boolean;
  enoent?: boolean;
}

interface SpawnCall {
  args: string[];
  opts: { stdio?: unknown; cwd?: string; env?: Record<string, string> };
  kills: string[];
}

function fakeSpawn(script: Script): SpawnCall[] {
  const calls: SpawnCall[] = [];
  vi.mocked(spawn).mockImplementation(((
    _cmd: string,
    args: string[],
    opts: SpawnCall["opts"],
  ) => {
    const call: SpawnCall = { args, opts, kills: [] };
    calls.push(call);
    const stream = () =>
      Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    const child = Object.assign(new EventEmitter(), {
      stdout: stream(),
      stderr: stream(),
      kill: (signal: string) => {
        call.kills.push(signal);
        if (signal === "SIGTERM" && script.ignoreTerm) return true;
        queueMicrotask(() =>
          child.emit(
            "close",
            signal === "SIGKILL" ? null : 0,
            signal === "SIGKILL" ? "SIGKILL" : null,
          ),
        );
        return true;
      },
    });
    queueMicrotask(() => {
      if (script.enoent) {
        child.emit(
          "error",
          Object.assign(new Error("spawn wrangler ENOENT"), { code: "ENOENT" }),
        );
        return;
      }
      if (script.stderr) child.stderr.emit("data", script.stderr);
      for (const chunk of script.chunks ?? []) child.stdout.emit("data", chunk);
      if (script.exit !== undefined) child.emit("close", script.exit, null);
    });
    return child;
  }) as never);
  return calls;
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run the command and advance fake time until it settles. */
async function run(args: string[], advanceMs = 60_000): Promise<string> {
  const promise = workersCommand(["tail", ...args]);
  // Observe a rejection now, so it is not reported as unhandled while time advances.
  promise.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(advanceMs);
  return promise;
}

describe("workers tail", () => {
  it("stops at the --for limit with SIGTERM and prints one row per event, never headers or query strings", async () => {
    const calls = fakeSpawn({
      chunks: [json(FETCH_EVENT), json(CRON_EVENT), json(ERROR_EVENT)],
    });
    const out = await run(
      ["--name", "family-haze-bot", "--for", "90s"],
      90_000,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "tail",
      "family-haze-bot",
      "--format",
      "json",
    ]);
    // stdin is never a pipe wrangler could wait on.
    expect(calls[0].opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(calls[0].kills).toEqual(["SIGTERM"]);

    expect(out).toContain("worker: family-haze-bot");
    expect(out).toMatch(/window: "?90s \(ran 90s, stopped: time limit\)/);
    expect(out).toContain("count: 3\nerrors: 1\n");
    expect(out).toContain(
      "events[3]{time,trigger,outcome,status,logs,exceptions}:",
    );
    expect(out).toContain(
      '"2026-10-23T08:05:00Z",fetch POST /webhook?…,ok,"200"',
    );
    expect(out).toContain('cron \\"*/5 * * * *\\"');
    expect(out).toContain("TypeError: Cannot read properties of undefined");
    expect(out).toContain('fetch GET /,exception,"500"');
    expect(out).toContain('log: webhook update {\\"chat\\":42}');

    for (const secret of [
      "REALSECRET",
      "COOKIESECRET",
      "abc123",
      "hunter2",
      "authorization",
      "colo",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("token=<redacted>");
  });

  it("stops early at --max-events, even with an event split across chunks", async () => {
    const whole = json(FETCH_EVENT) + json(CRON_EVENT) + json(ERROR_EVENT);
    const calls = fakeSpawn({
      chunks: [whole.slice(0, 50), whole.slice(50, 700), whole.slice(700)],
    });
    const out = await run(
      ["--name", "family-haze-bot", "--max-events", "2"],
      0,
    );

    expect(calls[0].kills).toEqual(["SIGTERM"]);
    expect(out).toContain("stopped: max events");
    expect(out).toContain("count: 2\nerrors: 0\n");
    expect(out).toContain("Stopped at --max-events 2");
    expect(out).not.toContain("TypeError");
  });

  it("keeps only cron events with --cron and counts the rest", async () => {
    fakeSpawn({
      chunks: [json(FETCH_EVENT), json(CRON_EVENT), json(ERROR_EVENT)],
    });
    const out = await run(
      ["--name", "family-haze-bot", "--cron", "--for", "6m"],
      360_000,
    );
    expect(out).toContain("count: 1\nerrors: 0\nskipped_not_cron: 2\n");
    expect(out).toContain("events[1]");
    expect(out).not.toContain("fetch POST");
  });

  it("explains an empty window and how long to wait for a cron", async () => {
    fakeSpawn({});
    const out = await run(["--name", "family-haze-bot", "--cron"]);
    expect(out).toContain("events: 0 cron events");
    expect(out).toContain('a "*/5 * * * *" cron needs --for 6m');
  });

  it("names the Worker from the events when --name is not given", async () => {
    const calls = fakeSpawn({ chunks: [json(CRON_EVENT)] });
    const out = await run([]);
    expect(calls[0].args).toEqual(["tail", "--format", "json"]);
    expect(out).toContain("worker: family-haze-bot");
  });

  it("forwards --status values to wrangler and offers no redundant --status hint", async () => {
    const calls = fakeSpawn({ chunks: [json(ERROR_EVENT)] });
    const out = await run(["--name", "w", "--status", "error,canceled"]);
    expect(calls[0].args).toEqual([
      "tail",
      "w",
      "--format",
      "json",
      "--status",
      "error",
      "--status",
      "canceled",
    ]);
    expect(out).toMatch(/status_filter: "?error,canceled"?/);
    expect(out).not.toContain("to see only failed invocations");
  });

  it("warns that cron events may be missing after a reconnect", async () => {
    fakeSpawn({
      stderr:
        "▲ [WARNING] Tail connection lost. Reconnecting (attempt 1 of 5) in 1s...\n",
      chunks: [json(FETCH_EVENT)],
    });
    const out = await run(["--name", "family-haze-bot"]);
    expect(out).toContain("The tail reconnected 1 times");
    expect(out).toContain("cron (scheduled) events");
  });

  it("stops wrangler and still prints the events when this process is interrupted", async () => {
    const calls = fakeSpawn({ chunks: [json(FETCH_EVENT)] });
    const promise = workersCommand(["tail", "--name", "family-haze-bot"]);
    await vi.advanceTimersByTimeAsync(1_000);
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    const out = await promise;
    expect(calls[0].kills).toEqual(["SIGTERM"]);
    expect(out).toContain("stopped: interrupted");
    expect(out).toContain("events[1]");
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  it("falls back to SIGKILL when wrangler ignores SIGTERM", async () => {
    const calls = fakeSpawn({ ignoreTerm: true });
    const out = await run(["--name", "w", "--for", "5s"], 5_000 + 5_000);
    expect(calls[0].kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(out).toContain("stopped: time limit");
  });

  it("maps a failure before any event (unknown Worker) to NOT_FOUND", async () => {
    fakeSpawn({
      stderr: '✘ [ERROR] Worker "nope" not found.\n',
      exit: 1,
    });
    const error = await failure(run(["--name", "nope"], 0));
    expect(error.code).toBe("NOT_FOUND");
  });

  it("maps a missing Worker name to NOT_LINKED", async () => {
    fakeSpawn({
      stderr:
        "✘ [ERROR] Required Worker name missing. Please specify the Worker name in your Wrangler configuration file, or pass it as an argument with `wrangler tail <worker-name>`\n",
      exit: 1,
    });
    const error = await failure(run([], 0));
    expect(error.code).toBe("NOT_LINKED");
  });

  it("keeps the events when wrangler gives up after some arrived", async () => {
    fakeSpawn({
      chunks: [json(FETCH_EVENT)],
      stderr:
        "✘ [ERROR] Unable to reconnect to the tail for family-haze-bot after 5 attempts.\n",
      exit: 1,
    });
    const out = await run(["--name", "family-haze-bot"], 0);
    expect(out).toContain("stopped: wrangler exited with code 1");
    expect(out).toContain("wrangler exited early: Unable to reconnect");
    expect(out).toContain("events[1]");
  });

  it("reports WRANGLER_NOT_INSTALLED when the binary is missing", async () => {
    fakeSpawn({ enoent: true });
    const error = await failure(run(["--name", "w"], 0));
    expect(error.code).toBe("WRANGLER_NOT_INSTALLED");
  });

  it("runs from the config's directory and carries --config into hints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-axi-tail-"));
    try {
      const config = join(dir, "wrangler.toml");
      writeFileSync(config, 'name = "family-haze-bot"\n');
      const calls = fakeSpawn({ chunks: [json(FETCH_EVENT)] });
      const out = await run(["--config", config]);
      expect(calls[0].args).toEqual([
        "tail",
        "--format",
        "json",
        "--config",
        config,
      ]);
      expect(calls[0].opts.cwd).toBe(dir);
      expect(out).toContain(`--cron --for 6m --config ${config}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [["--for", "2h"], "--for must be"],
    [["--for", "1s"], "--for must be"],
    [["--for", "soon"], "--for must be"],
    [["--max-events", "0"], "--max-events must be"],
    [["--max-events", "501"], "--max-events must be"],
    [["--status", "bogus"], "--status takes"],
    [["family-haze-bot"], "unexpected argument family-haze-bot"],
    [["--follow"], "unknown flag --follow"],
  ])("rejects %j before spawning wrangler", async (args, message) => {
    const calls = fakeSpawn({});
    const error = await failure(workersCommand(["tail", ...args]));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain(message);
    expect(calls).toEqual([]);
  });
});

describe("tail helpers", () => {
  it("splits concatenated pretty JSON objects, with braces and quotes inside strings", () => {
    const stream = new JsonObjectStream();
    const text = json({ a: "x { y", b: 'q \\" }' }) + json({ c: 1 });
    const out: unknown[] = [];
    for (const ch of text) out.push(...stream.push(ch));
    expect(out).toEqual([{ a: "x { y", b: 'q \\" }' }, { c: 1 }]);
    // A bare JSON string (wrangler's json-mode fatal error) is not an event.
    expect(new JsonObjectStream().push('"Unable to reconnect"\n')).toEqual([]);
  });

  it("parses durations", () => {
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("30m")).toBe(1800);
  });

  it("redacts credential-looking values in console lines", () => {
    expect(redactSecrets("Authorization: Bearer abc.def")).not.toContain(
      "abc.def",
    );
    expect(redactSecrets("api_key=XYZ password: pw1")).toBe(
      "api_key=<redacted> password: <redacted>",
    );
    expect(
      redactSecrets("bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ x"),
    ).toBe("bot <redacted> x");
  });

  it("keeps only the path of a URL", () => {
    expect(safePath("https://u:p@example.com/a/b?token=1#x")).toBe("/a/b?…");
    expect(safePath("https://example.com/")).toBe("/");
  });

  it("describes non-fetch triggers like wrangler's pretty printer", () => {
    expect(describeTrigger({ event: { queue: "jobs", batchSize: 3 } })).toBe(
      "queue jobs (3 messages)",
    );
    expect(describeTrigger({ event: { scheduledTime: 1 } })).toBe("alarm");
    expect(
      describeTrigger({ entrypoint: "Api", event: { rpcMethod: "get" } }),
    ).toBe("rpc Api.get");
    expect(describeTrigger({ event: { mailFrom: "a@b", rcptTo: "c@d" } })).toBe(
      "email",
    );
    expect(describeTrigger({ event: null })).toBe("unknown");
  });

  it("caps console lines per event", () => {
    const row = toTailRow(
      {
        logs: Array.from({ length: 8 }, (_, i) => ({
          level: "log",
          message: [`line ${i} ${"x".repeat(300)}`],
        })),
      },
      false,
    );
    expect(row.logs).toContain("+3 more");
    expect(String(row.logs).split(" | ")[0].length).toBeLessThanOrEqual(205);
  });
});
