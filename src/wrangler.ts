import { execFile } from "node:child_process";
import {
  AxiError,
  mapWranglerError,
  wranglerNotInstalledError,
} from "./errors.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

function run(args: string[]): Promise<ExecResult> {
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
