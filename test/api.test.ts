import { describe, expect, it } from "vitest";
import { mapApiError } from "../src/errors.js";

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

  it("falls back to UNKNOWN with the message and code", () => {
    const err = mapApiError(400, [
      { code: 2054, message: "Destination address is not verified" },
    ]);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe(
      "Destination address is not verified [code: 2054]",
    );
  });

  it("reports the HTTP status when the envelope has no errors", () => {
    expect(mapApiError(502, [], "/zones").message).toBe("HTTP 502 from /zones");
  });
});
