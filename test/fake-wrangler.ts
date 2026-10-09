import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
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

export async function failure(promise: Promise<unknown>): Promise<AxiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AxiError);
    return error as AxiError;
  }
  throw new Error("expected a failure");
}
