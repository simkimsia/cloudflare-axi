import { describe, expect, it } from "vitest";
import { mapApiError, REPORT_SUGGESTION } from "../src/errors.js";

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
