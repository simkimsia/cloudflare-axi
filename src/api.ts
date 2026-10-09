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

export function cfGet<T = unknown>(path: string): Promise<T> {
  return cfRequest<T>("GET", path);
}

/** Write calls (POST/PUT/DELETE) send `body` as JSON; same envelope and error mapping as reads. */
export async function cfRequest<T = unknown>(
  method: ApiMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  return (await cfEnvelope<T>(method, path, body)).result;
}

/** GET returning `result` plus `result_info`, for cursor-paged list endpoints. */
export async function cfGetPage<T = unknown>(
  path: string,
): Promise<{ result: T; info: ApiResultInfo }> {
  const envelope = await cfEnvelope<T>("GET", path);
  return { result: envelope.result, info: envelope.result_info ?? {} };
}

/**
 * GET a raw-body endpoint (e.g. a KV value), which answers with the bytes
 * themselves rather than the JSON envelope. Failures still come back as an
 * envelope and map through mapApiError like every other call.
 */
export async function cfGetBytes(path: string): Promise<Buffer> {
  const response = await send("GET", path);
  if (response.ok) return Buffer.from(await response.arrayBuffer());
  const text = await response.text();
  const envelope = parseEnvelope<unknown>(text);
  throw mapApiError(response.status, envelope?.errors ?? [], path);
}

async function send(
  method: ApiMethod,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token } = await resolveApiCredentials();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  debugApi(method, path);
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
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
): Promise<ApiEnvelope<T>> {
  const response = await send(method, path, body);
  const text = await response.text();
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
