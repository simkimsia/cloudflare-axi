import { resolveApiCredentials } from "./credentials.js";
import { AxiError, mapApiError, type ApiErrorEntry } from "./errors.js";

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

export async function cfGet<T = unknown>(path: string): Promise<T> {
  const { token } = await resolveApiCredentials();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
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
  let body: ApiEnvelope<T> | undefined;
  try {
    body = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    body = undefined;
  }
  if (!body || typeof body !== "object") {
    throw new AxiError(
      `Unexpected Cloudflare API response (HTTP ${response.status}): ${text.slice(0, 200)}`,
      "UNKNOWN",
    );
  }
  if (!response.ok || body.success === false) {
    throw mapApiError(response.status, body.errors ?? [], path);
  }
  return body.result;
}
