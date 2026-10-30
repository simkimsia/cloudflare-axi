import { resolveApiCredentials } from "./credentials.js";
import { debugApi } from "./debug.js";
import {
  AxiError,
  mapApiError,
  REPORT_SUGGESTION,
  type ApiErrorEntry,
} from "./errors.js";

/**
 * Sole place that talks to the Cloudflare REST API directly. Used only for
 * surfaces wrangler has no subcommand for (VISION.md: wrangler first, REST
 * where wrangler has no surface).
 */
export const API_BASE = "https://api.cloudflare.com/client/v4";

interface ApiEnvelope<T> {
  success: boolean;
  errors?: ApiErrorEntry[];
  result: T;
  result_info?: ApiResultInfo;
}

/** Paging info some list endpoints return beside `result` (KV keys: `cursor`, "" on the last page). */
export interface ApiResultInfo {
  count?: number;
  cursor?: string;
}

export type ApiMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Default per-request budget, covering both the response headers and the
 * body read. Without one, a hung api.cloudflare.com would stall a command for
 * undici's own ~300s. Raw-body reads use the separate budget below.
 */
export const API_TIMEOUT_MS = 30_000;

/** Raw-body reads (KV values, up to 25 MiB) get a longer budget. */
export const API_BYTES_TIMEOUT_MS = 120_000;

export interface ApiRequestOptions {
  /** Abort the request (and its body read) after this many ms. */
  timeoutMs?: number;
}

export function cfGet<T = unknown>(
  path: string,
  options?: ApiRequestOptions,
): Promise<T> {
  return cfRequest<T>("GET", path, undefined, options);
}

/** Write calls (POST/PUT/DELETE) send `body` as JSON; same envelope and error mapping as reads. */
export async function cfRequest<T = unknown>(
  method: ApiMethod,
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<T> {
  return (await cfEnvelope<T>(method, path, body, options)).result;
}

/** GET returning `result` plus `result_info`, for cursor-paged list endpoints. */
export async function cfGetPage<T = unknown>(
  path: string,
  options?: ApiRequestOptions,
): Promise<{ result: T; info: ApiResultInfo }> {
  const envelope = await cfEnvelope<T>("GET", path, undefined, options);
  return { result: envelope.result, info: envelope.result_info ?? {} };
}

/**
 * GET a raw-body endpoint (e.g. a KV value), which answers with the bytes
 * themselves rather than the JSON envelope. Failures still come back as an
 * envelope and map through mapApiError like every other call.
 */
export async function cfGetBytes(
  path: string,
  options?: ApiRequestOptions,
): Promise<Buffer> {
  const { response, data } = await send(
    "GET",
    path,
    undefined,
    async (r): Promise<Buffer | string> =>
      r.ok ? Buffer.from(await r.arrayBuffer()) : r.text(),
    options?.timeoutMs ?? API_BYTES_TIMEOUT_MS,
  );
  if (typeof data !== "string") return data;
  const envelope = parseEnvelope<unknown>(data);
  throw mapApiError(response.status, envelope?.errors ?? [], path);
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      (error.cause instanceof Error && error.cause.name === "TimeoutError"))
  );
}

/**
 * One request, its body read by `read` under the same timeout. A timeout or
 * network failure is an AxiError (UNKNOWN) that says which one it was.
 */
async function send<R>(
  method: ApiMethod,
  path: string,
  body: unknown,
  read: (response: Response) => Promise<R>,
  timeoutMs: number = API_TIMEOUT_MS,
): Promise<{ response: Response; data: R }> {
  const { token } = await resolveApiCredentials();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  debugApi(method, path);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    return { response, data: await read(response) };
  } catch (error) {
    if (signal.aborted || isTimeout(error)) {
      throw new AxiError(
        `The Cloudflare API did not answer within ${timeoutMs / 1000}s (${method} ${path})`,
        "UNKNOWN",
        [
          // A write may have gone through before the answer was lost.
          method === "GET"
            ? "Retry"
            : `The ${method} may still have been applied: check the current state before retrying`,
          "If it keeps timing out, check https://www.cloudflarestatus.com and network access to api.cloudflare.com",
        ],
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new AxiError(
      `Could not reach the Cloudflare API: ${detail}`,
      "UNKNOWN",
      ["Check network access to api.cloudflare.com, then retry"],
    );
  }
}

function parseEnvelope<T>(text: string): ApiEnvelope<T> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ApiEnvelope<T>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function cfEnvelope<T>(
  method: ApiMethod,
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<ApiEnvelope<T>> {
  const { response, data: text } = await send(
    method,
    path,
    body,
    (r) => r.text(),
    options?.timeoutMs,
  );
  const envelope = parseEnvelope<T>(text);
  if (!envelope) {
    throw new AxiError(
      `Unexpected Cloudflare API response (HTTP ${response.status}): ${text.slice(0, 200)}`,
      "UNKNOWN",
      [REPORT_SUGGESTION],
    );
  }
  if (!response.ok || envelope.success === false) {
    throw mapApiError(response.status, envelope.errors ?? [], path);
  }
  return envelope;
}
