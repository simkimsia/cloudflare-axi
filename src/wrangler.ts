import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AxiError,
  mapWranglerError,
  UNKNOWN_SUGGESTION,
  wranglerNotInstalledError,
} from "./errors.js";
import { debugWrangler } from "./debug.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

export interface RunOptions {
  /**
   * Written to wrangler's stdin (e.g. a secret value). Never logged: AXI_DEBUG
   * prints argv only.
   */
  input?: string;
  /** Extra environment variables for this call, on top of process.env. */
  env?: Record<string, string>;
  /**
   * Working directory for wrangler (default: this process's cwd). `--config`
   * runs set it to the config's directory; see src/config.ts.
   */
  cwd?: string;
  /**
   * Give up after this many ms: wrangler gets SIGTERM (SIGKILL after
   * RUN_KILL_GRACE_MS) and the call throws WranglerTimeoutError. Only for
   * read-only calls; a write is never cut off mid-way.
   */
  timeoutMs?: number;
}

/**
 * Budget for quick read-only wrangler calls (`whoami`, including the one that
 * refreshes an expired OAuth token), in line with the REST API_TIMEOUT_MS.
 */
export const WRANGLER_READ_TIMEOUT_MS = 30_000;

/** After a timeout's SIGTERM, how long before SIGKILL. */
export const RUN_KILL_GRACE_MS = 5000;

/** wrangler did not finish within the caller's `timeoutMs`. */
export class WranglerTimeoutError extends AxiError {
  constructor(args: string[], timeoutMs: number) {
    // Name the subcommand only (argv up to the first flag), never values.
    const command = ["wrangler", ...args]
      .slice(0, args.findIndex((a) => a.startsWith("-")) + 1 || undefined)
      .join(" ");
    super(`${command} did not answer within ${timeoutMs / 1000}s`, "UNKNOWN", [
      "Retry; if it keeps timing out, run it with AXI_DEBUG=1 and check https://www.cloudflarestatus.com",
    ]);
  }
}

type RunResult = ExecResult & { timedOut?: boolean };

function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  debugWrangler(args, opts.cwd);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const child = execFile(
      "wrangler",
      args,
      {
        maxBuffer: MAX_BUFFER_BYTES,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          settle({ stdout: "", stderr: "ENOENT", exitCode: 127 });
          return;
        }
        const exitCode = error
          ? ((error as Error & { code?: string | number }).code ?? 1)
          : 0;
        settle({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: typeof exitCode === "number" ? exitCode : 1,
        });
      },
    );
    // Always close stdin so wrangler never blocks waiting on it (it reads a
    // secret value from a non-TTY stdin), and pass `input` when given.
    child?.stdin?.on("error", () => {});
    child?.stdin?.end(opts.input ?? "");
    if (opts.timeoutMs !== undefined && child) {
      timer = setTimeout(() => {
        // The wrangler bin forwards SIGTERM to its CLI grandchild, which
        // shares our pipes; don't wait for them to close, return now.
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, RUN_KILL_GRACE_MS).unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle({ stdout: "", stderr: "", exitCode: 1, timedOut: true });
      }, opts.timeoutMs);
    }
  });
}

/** Shared failure handling for wranglerJson / wranglerExec. */
function checkResult(
  args: string[],
  result: RunResult,
  opts: RunOptions | undefined,
): void {
  if (result.timedOut) {
    throw new WranglerTimeoutError(args, opts?.timeoutMs ?? 0);
  }
  if (result.stderr === "ENOENT") throw wranglerNotInstalledError();
  if (result.exitCode !== 0) {
    throw mapWranglerError(result.stderr || result.stdout, result.exitCode);
  }
}

/**
 * Wrangler prints a "⛅️ wrangler x.y.z" banner on stdout before some payloads
 * (it suppresses it under --json, but don't rely on that). Return stdout from
 * the first line that starts the JSON document.
 */
export function extractJson(stdout: string): string {
  const index = stdout.search(/^[[{]/m);
  return index === -1 ? stdout : stdout.slice(index);
}

/** Execute wrangler and return parsed JSON. */
export async function wranglerJson<T = unknown>(
  args: string[],
  opts?: RunOptions,
): Promise<T> {
  const result = await run(args, opts);
  checkResult(args, result, opts);
  try {
    return JSON.parse(extractJson(result.stdout)) as T;
  } catch {
    throw new AxiError(
      `Unexpected wrangler output: ${result.stdout.slice(0, 200)}`,
      "UNKNOWN",
      [UNKNOWN_SUGGESTION],
    );
  }
}

/** Execute wrangler and return raw stdout. */
export async function wranglerExec(
  args: string[],
  opts?: RunOptions,
): Promise<string> {
  const result = await run(args, opts);
  checkResult(args, result, opts);
  return result.stdout;
}

/** KV values go up to 25 MiB; leave headroom for wrangler's own output. */
export const BYTES_MAX_BUFFER = 32 * 1024 * 1024; // 32 MiB

/** wrangler printed more than the buffer allows; callers can suggest a bounded alternative. */
export class WranglerOutputTooLargeError extends AxiError {
  constructor(limit: number) {
    super(
      `wrangler output exceeded ${Math.round(limit / (1024 * 1024))} MiB`,
      "UNKNOWN",
      [UNKNOWN_SUGGESTION],
    );
  }
}

/**
 * Execute wrangler and return raw stdout bytes, undecoded (a value may not be
 * UTF-8). Separate from `run` on purpose: same error mapping, but a larger
 * buffer and a distinct error when output overflows it.
 */
export function wranglerBytes(
  args: string[],
  maxBuffer = BYTES_MAX_BUFFER,
): Promise<Buffer> {
  debugWrangler(args);
  return new Promise((resolve, reject) => {
    const child = execFile(
      "wrangler",
      args,
      { encoding: "buffer", maxBuffer },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT") return reject(wranglerNotInstalledError());
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(new WranglerOutputTooLargeError(maxBuffer));
        }
        const toBuffer = (b: Buffer | string | undefined) =>
          Buffer.isBuffer(b) ? b : Buffer.from(b ?? "");
        if (error) {
          const text =
            toBuffer(stderr).toString("utf8") ||
            toBuffer(stdout).toString("utf8");
          return reject(
            mapWranglerError(text, typeof code === "number" ? code : 1),
          );
        }
        resolve(toBuffer(stdout));
      },
    );
    // Same as `run`: close stdin so wrangler never blocks waiting on it.
    child?.stdin?.on("error", () => {});
    child?.stdin?.end();
  });
}

/**
 * One line of wrangler's ND-JSON output file (WRANGLER_OUTPUT_FILE_PATH).
 * Seen types: "wrangler-session", "deploy", "command-failed".
 */
export interface WranglerOutputEntry {
  type: string;
  [key: string]: unknown;
}

/** Parse wrangler's ND-JSON output file, skipping blank or malformed lines. */
export function parseOutputEntries(ndjson: string): WranglerOutputEntry[] {
  const entries: WranglerOutputEntry[] = [];
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        entries.push(parsed as WranglerOutputEntry);
      }
    } catch {
      // not JSON; skip
    }
  }
  return entries;
}

/**
 * Execute wrangler with WRANGLER_OUTPUT_FILE_PATH pointed at a private temp
 * file, and return stdout plus the machine-readable entries wrangler wrote
 * there. The temp directory is always removed.
 */
export async function wranglerExecWithOutput(
  args: string[],
  opts: RunOptions = {},
): Promise<{ stdout: string; entries: WranglerOutputEntry[] }> {
  const dir = await mkdtemp(join(tmpdir(), "cloudflare-axi-"));
  const file = join(dir, "out.ndjson");
  try {
    const stdout = await wranglerExec(args, {
      ...opts,
      env: { ...opts.env, WRANGLER_OUTPUT_FILE_PATH: file },
    });
    const ndjson = await readFile(file, "utf8").catch(() => "");
    return { stdout, entries: parseOutputEntries(ndjson) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** How a streamed wrangler child ended. */
export interface StreamResult {
  /** Exit code, or null when a signal ended it. */
  exitCode: number | null;
  signal: string | null;
  /** The last 64 KiB of stderr (warnings such as tail reconnects, errors). */
  stderr: string;
  /** The wrangler binary was not found. */
  notInstalled: boolean;
}

export interface StreamHandle {
  /**
   * Ask wrangler to stop (SIGTERM, which `wrangler tail` handles by deleting
   * its tail on the server), then SIGKILL after `killAfterMs`. Idempotent.
   */
  stop(killAfterMs?: number): void;
  /**
   * SIGKILL the group now, skipping the grace period (a repeated Ctrl-C).
   * `done` still settles, after at most STREAM_CLOSE_GRACE_MS. Idempotent.
   */
  kill(): void;
  done: Promise<StreamResult>;
}

const STREAM_STDERR_KEEP = 64 * 1024;
export const STREAM_KILL_GRACE_MS = 5000;
/**
 * How long to wait for stdout/stderr to close after the child exits (or
 * after SIGKILL) before destroying the pipes and returning anyway.
 */
export const STREAM_CLOSE_GRACE_MS = 2000;

/**
 * Spawn a long-running wrangler command (e.g. `tail`) and hand stdout to
 * `onStdout` as it arrives. stdin is /dev/null so wrangler never waits on
 * it. The caller bounds it by calling `stop()`; nothing here ever waits
 * without an end.
 *
 * The `wrangler` bin is a wrapper that runs the real CLI as a grandchild
 * sharing our pipes, so killing only the direct child is not enough. On
 * POSIX the child gets its own process group (`detached`) and every signal
 * goes to the whole group. Because the group is not the terminal's
 * foreground group, a Ctrl-C does not reach wrangler on its own: callers
 * stop it from their own SIGINT/SIGTERM handlers, and this process kills
 * the group on exit. As a backstop, once the child has exited (or SIGKILL
 * was sent) the pipes are destroyed after STREAM_CLOSE_GRACE_MS, so `done`
 * always settles even if a straggler holds them open.
 */
export function wranglerStream(
  args: string[],
  opts: RunOptions & { onStdout: (chunk: string) => void },
): StreamHandle {
  debugWrangler(args, opts.cwd);
  const group = process.platform !== "win32";
  const child = spawn("wrangler", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: group,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  let stderr = "";
  let settled = false;
  let stopping = false;
  let killed = false;
  let exitInfo: { code: number | null; signal: string | null } | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopHook: (killAfterMs: number) => void = () => undefined;
  let killHook: () => void = () => undefined;

  const signal = (sig: NodeJS.Signals) => {
    if (group && child.pid !== undefined) {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch {
        // group already gone, or no permission: fall back to the child
      }
    }
    try {
      child.kill(sig);
    } catch {
      // already exited
    }
  };
  const killOnExit = () => signal("SIGKILL");
  process.once("exit", killOnExit);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => opts.onStdout(chunk));
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STREAM_STDERR_KEEP);
  });
  const done = new Promise<StreamResult>((resolve) => {
    const finish = (result: StreamResult) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      process.removeListener("exit", killOnExit);
      resolve(result);
    };
    const forceClose = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({
        exitCode: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? (stopping ? "SIGKILL" : null),
        stderr,
        notInstalled: false,
      });
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: 127,
        signal: null,
        stderr: error.message,
        notInstalled: error.code === "ENOENT",
      });
    });
    child.on("exit", (code: number | null, sig: string | null) => {
      exitInfo = { code, signal: sig };
      // A grandchild may still hold the pipes: take the group down too,
      // and stop waiting for `close` after a grace period.
      if (group) signal("SIGKILL");
      timers.push(setTimeout(forceClose, STREAM_CLOSE_GRACE_MS));
    });
    child.on("close", (code: number | null, sig: string | null) => {
      finish({ exitCode: code, signal: sig, stderr, notInstalled: false });
    });
    stopHook = (killAfterMs) => {
      signal("SIGTERM");
      timers.push(
        setTimeout(() => {
          signal("SIGKILL");
          timers.push(setTimeout(forceClose, STREAM_CLOSE_GRACE_MS));
        }, killAfterMs),
      );
    };
    killHook = () => {
      signal("SIGKILL");
      timers.push(setTimeout(forceClose, STREAM_CLOSE_GRACE_MS));
    };
  });
  return {
    stop(killAfterMs = STREAM_KILL_GRACE_MS) {
      if (settled || stopping) return;
      stopping = true;
      stopHook(killAfterMs);
    },
    kill() {
      if (settled || killed) return;
      killed = stopping = true;
      killHook();
    },
    done,
  };
}
