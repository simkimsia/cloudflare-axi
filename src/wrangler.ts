import { execFile } from "node:child_process";
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

function run(args: string[]): Promise<ExecResult> {
  debugWrangler(args);
  return new Promise((resolve) => {
    execFile(
      "wrangler",
      args,
      { maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ stdout: "", stderr: "ENOENT", exitCode: 127 });
          return;
        }
        const exitCode = error
          ? ((error as Error & { code?: string | number }).code ?? 1)
          : 0;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: typeof exitCode === "number" ? exitCode : 1,
        });
      },
    );
  });
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
export async function wranglerJson<T = unknown>(args: string[]): Promise<T> {
  const result = await run(args);
  if (result.stderr === "ENOENT") throw wranglerNotInstalledError();
  if (result.exitCode !== 0) {
    throw mapWranglerError(result.stderr || result.stdout, result.exitCode);
  }
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
export async function wranglerExec(args: string[]): Promise<string> {
  const result = await run(args);
  if (result.stderr === "ENOENT") throw wranglerNotInstalledError();
  if (result.exitCode !== 0) {
    throw mapWranglerError(result.stderr || result.stdout, result.exitCode);
  }
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
    execFile(
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
  });
}
