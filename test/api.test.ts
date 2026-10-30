import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_BYTES_TIMEOUT_MS,
  API_TIMEOUT_MS,
  cfGet,
  cfGetBytes,
  cfRequest,
} from "../src/api.js";
import { AxiError, mapApiError, REPORT_SUGGESTION } from "../src/errors.js";

// Real api.cloudflare.com envelopes captured live 2026-09-04.
const AUTH_10000 = [
  {
    code: 10000,
    message: "Authentication error",
    documentation_url:
      "https://developers.cloudflare.com/api/resources/email_routing/methods/get",
  },
];
const BAD_HEADER = [{ code: 6003, message: "Invalid request headers" }];

describe("mapApiError", () => {
  it("maps code 10000 (HTTP 403) to AUTH with a scope hint", () => {
    const err = mapApiError(403, AUTH_10000);
    expect(err.code).toBe("AUTH");
    expect(err.message).toContain("[code: 10000]");
    expect(err.suggestions.join(" ")).toContain("wrangler whoami");
  });

  it("maps a malformed Authorization header (HTTP 400, code 6003) to AUTH", () => {
    expect(mapApiError(400, BAD_HEADER).code).toBe("AUTH");
  });

  it("maps HTTP 404, code 7003, and code 9109 (invalid zone id) to NOT_FOUND", () => {
    expect(mapApiError(404, []).code).toBe("NOT_FOUND");
    expect(
      mapApiError(400, [{ code: 9109, message: "Invalid zone identifier" }])
        .code,
    ).toBe("NOT_FOUND");
    expect(
      mapApiError(400, [{ code: 7003, message: "Could not route to /x" }]).code,
    ).toBe("NOT_FOUND");
  });

  it("maps KV codes 10009 (key) and 10013 (namespace) to NOT_FOUND, keeping the codes", () => {
    const key = mapApiError(404, [
      { code: 10009, message: "get: 'key not found'" },
    ]);
    expect(key.code).toBe("NOT_FOUND");
    expect(key.apiCodes).toEqual([10009]);
    const ns = mapApiError(404, [
      { code: 10013, message: "get namespace: 'namespace not found'" },
    ]);
    expect(ns.code).toBe("NOT_FOUND");
    expect(ns.suggestions[0]).toContain("cloudflare-axi kv");
  });

  it("maps code 2054 (unverified destination) to UNVERIFIED with a next step", () => {
    const err = mapApiError(400, [
      { code: 2054, message: "Destination address is not verified" },
    ]);
    expect(err.code).toBe("UNVERIFIED");
    expect(err.message).toBe(
      "Destination address is not verified [code: 2054]",
    );
    expect(err.suggestions.join(" ")).toContain("verification link");
  });

  it("falls back to UNKNOWN with the message and code", () => {
    const err = mapApiError(400, [{ code: 2999, message: "Something odd" }]);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("Something odd [code: 2999]");
    expect(err.suggestions).toEqual([REPORT_SUGGESTION]);
  });

  it("reports the HTTP status when the envelope has no errors", () => {
    expect(mapApiError(502, [], "/zones").message).toBe("HTTP 502 from /zones");
  });
});

describe("REST request timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** A fetch that never answers, rejecting only when its signal aborts. */
  function hangingFetch() {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return; // would hang forever: the bug this guards
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("gives every call a default timeout and reports a hang as UNKNOWN", async () => {
    hangingFetch();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const err = await cfGet("/accounts", { timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AxiError);
    expect((err as AxiError).code).toBe("UNKNOWN");
    expect((err as AxiError).message).toBe(
      "The Cloudflare API did not answer within 0.02s (GET /accounts)",
    );
    expect(timeout).toHaveBeenCalledWith(20);

    timeout.mockImplementation(() =>
      AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
    );
    const byDefault = await cfGet("/accounts").catch((e: unknown) => e);
    expect((byDefault as AxiError).message).toContain(
      `within ${API_TIMEOUT_MS / 1000}s`,
    );
    expect(timeout).toHaveBeenLastCalledWith(API_TIMEOUT_MS);
  });

  it("says a timed-out write may have gone through instead of a bare Retry", async () => {
    hangingFetch();
    const read = (await cfGet("/accounts", { timeoutMs: 20 }).catch(
      (e: unknown) => e,
    )) as AxiError;
    expect(read.suggestions[0]).toMatch(/^Retry;/);

    for (const method of ["POST", "PUT", "DELETE"] as const) {
      const write = (await cfRequest(
        method,
        "/zones/z/email/routing/rules",
        {},
        {
          timeoutMs: 20,
        },
      ).catch((e: unknown) => e)) as AxiError;
      expect(write.code).toBe("UNKNOWN");
      expect(write.suggestions[0]).toContain(
        `The ${method} may have gone through: check the current state`,
      );
      expect(write.suggestions[0]).not.toMatch(/^Retry/);
    }
  });

  it("gives raw-body reads a longer default budget", async () => {
    hangingFetch();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() =>
        AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
      );
    const err = await cfGetBytes("/x/values/k").catch((e: unknown) => e);
    expect((err as AxiError).code).toBe("UNKNOWN");
    expect(timeout).toHaveBeenCalledWith(API_BYTES_TIMEOUT_MS);
  });

  it("still says the API could not be reached on a network error", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await cfGet("/accounts").catch((e: unknown) => e);
    expect((err as AxiError).message).toBe(
      "Could not reach the Cloudflare API: fetch failed",
    );
  });
});
