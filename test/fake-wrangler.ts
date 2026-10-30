import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { expect, vi } from "vitest";
import { AxiError } from "../src/errors.js";

// Shared fake for the wrangler spawn layer. Each test file that uses it must
// itself call `vi.mock("node:child_process", () => ({ execFile: vi.fn() }))`
// (vi.mock is hoisted per file), so no test ever runs the real binary.

export interface Call {
  args: string[];
  env?: Record<string, string | undefined>;
  /** The child's working directory (undefined = inherit this process's cwd). */
  cwd?: string;
  stdin?: string;
}
export interface Reply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  ndjson?: string;
}

export function fakeWrangler(replies: (args: string[]) => Reply): Call[] {
  const calls: Call[] = [];
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    args: string[],
    opts: { env?: Record<string, string | undefined>; cwd?: string },
    cb: (err: unknown, stdout: string, stderr: string) => void,
  ) => {
    const call: Call = { args, env: opts?.env, cwd: opts?.cwd };
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

export interface SpawnReply extends Reply {
  /** Never exit by itself; only a signal to the process group ends it. */
  hang?: boolean;
  /** Ignore SIGTERM (only SIGKILL ends it). */
  ignoreTerm?: boolean;
  /**
   * Like the real `wrangler` wrapper whose CLI grandchild keeps the pipes
   * open: on a signal the direct child emits `exit`, but `close` never comes.
   */
  exitWithoutClose?: boolean;
  enoent?: boolean;
}

export interface SpawnCall extends Call {
  detached?: boolean;
  /** Signals sent to the process group (process.kill(-pid, sig)). */
  groupKills: string[];
  /** The pipes were destroyed (the close-grace backstop fired). */
  destroyed: boolean;
}

export const FAKE_PID = 4242;

/**
 * Fake for bounded runs (`timeoutMs`), which go through `spawn` rather than
 * `execFile`. The test file's `vi.mock("node:child_process", ...)` must
 * provide `spawn: vi.fn()`. Spies on `process.kill` to record group signals
 * (and the re-raise of a forwarded signal, sent to `process.pid`).
 */
export function fakeWranglerSpawn(
  replies: (args: string[]) => SpawnReply,
): SpawnCall[] {
  const calls: SpawnCall[] = [];
  const live = new Map<number, (signal: string) => void>();
  let nextPid = FAKE_PID;
  vi.spyOn(process, "kill").mockImplementation(((
    pid: number,
    signal: string,
  ) => {
    if (pid === process.pid) return true; // a re-raised signal: recorded only
    const deliver = live.get(-pid);
    if (!deliver) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    deliver(signal);
    return true;
  }) as never);
  vi.mocked(spawn).mockImplementation(((
    _cmd: string,
    args: string[],
    opts: { env?: Record<string, string>; cwd?: string; detached?: boolean },
  ) => {
    const pid = nextPid++;
    const call: SpawnCall = {
      args,
      env: opts?.env,
      cwd: opts?.cwd,
      detached: opts?.detached,
      groupKills: [],
      destroyed: false,
    };
    calls.push(call);
    const reply = replies(args);
    let exited = false;
    const stream = () =>
      Object.assign(new EventEmitter(), {
        setEncoding: () => undefined,
        destroy: () => {
          call.destroyed = true;
        },
      });
    const child = Object.assign(new EventEmitter(), {
      pid,
      unref: () => undefined,
      stdout: stream(),
      stderr: stream(),
      kill: (signal: string) => onSignal(signal),
    });
    const end = (code: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      live.delete(pid);
      child.emit("exit", code, signal);
      if (!reply.exitWithoutClose) child.emit("close", code, signal);
    };
    const onSignal = (signal: string) => {
      if (exited) return false;
      call.groupKills.push(signal);
      if (signal === "SIGTERM" && reply.ignoreTerm) return true;
      queueMicrotask(() =>
        end(
          signal === "SIGKILL" ? null : 143,
          signal === "SIGKILL" ? "SIGKILL" : null,
        ),
      );
      return true;
    };
    live.set(pid, onSignal);
    queueMicrotask(() => {
      if (reply.enoent) {
        live.delete(pid);
        child.emit(
          "error",
          Object.assign(new Error("spawn wrangler ENOENT"), { code: "ENOENT" }),
        );
        return;
      }
      if (reply.stderr) child.stderr.emit("data", reply.stderr);
      if (reply.stdout) child.stdout.emit("data", reply.stdout);
      if (!reply.hang) end(reply.exitCode ?? 0, null);
    });
    return child;
  }) as never);
  return calls;
}

export async function failure(promise: Promise<unknown>): Promise<AxiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AxiError);
    return error as AxiError;
  }
  throw new Error("expected a failure");
}
