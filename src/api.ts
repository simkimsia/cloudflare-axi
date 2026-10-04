import { resolveApiCredentials } from "./credentials.js";
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
  const { token } = await resolveApiCredentials();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
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

  const text = await response.text();
  let envelope: ApiEnvelope<T> | undefined;
  try {
    envelope = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    envelope = undefined;
  }
  if (!envelope || typeof envelope !== "object") {
    throw new AxiError(
      `Unexpected Cloudflare API response (HTTP ${response.status}): ${text.slice(0, 200)}`,
      "UNKNOWN",
      [REPORT_SUGGESTION],
    );
  }
  if (!response.ok || envelope.success === false) {
    throw mapApiError(response.status, envelope.errors ?? [], path);
  }
  return envelope.result;
}
