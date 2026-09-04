import { describe, expect, it } from "vitest";
import {
  isTokenExpired,
  parseWranglerConfig,
  wranglerConfigCandidates,
} from "../src/credentials.js";

// Shape of ~/.wrangler/config/default.toml written by wrangler 4.127.1
// (values redacted).
const CONFIG = `oauth_token = "cf-oauth-token-value"
expiration_time = "2026-09-04T11:13:44.673Z"
refresh_token = "refresh-token-value"
scopes = [ "user:read", "offline_access", "zone:read", "email_routing:write" ]
`;

describe("parseWranglerConfig", () => {
  it("reads the token, expiry, and scopes", () => {
    expect(parseWranglerConfig(CONFIG)).toEqual({
      oauthToken: "cf-oauth-token-value",
      expirationTime: "2026-09-04T11:13:44.673Z",
      scopes: [
        "user:read",
        "offline_access",
        "zone:read",
        "email_routing:write",
      ],
    });
  });

  it("returns no token for an empty or logged-out file", () => {
    expect(parseWranglerConfig("").oauthToken).toBeUndefined();
    expect(parseWranglerConfig("scopes = []").scopes).toEqual([]);
  });
});

describe("isTokenExpired", () => {
  const exp = "2026-09-04T11:13:44.673Z";
  it("is false well before expiry and true after", () => {
    expect(isTokenExpired(exp, Date.parse("2026-09-04T10:00:00Z"))).toBe(false);
    expect(isTokenExpired(exp, Date.parse("2026-09-04T11:20:00Z"))).toBe(true);
  });
  it("treats the last minute before expiry as expired (clock skew)", () => {
    expect(isTokenExpired(exp, Date.parse("2026-09-04T11:13:00Z"))).toBe(true);
  });
  it("never expires a token with no or unparseable expiry", () => {
    expect(isTokenExpired(undefined)).toBe(false);
    expect(isTokenExpired("garbage")).toBe(false);
  });
});

describe("wranglerConfigCandidates", () => {
  it("prefers legacy ~/.wrangler, then the macOS Preferences dir", () => {
    const list = wranglerConfigCandidates({}, "darwin", "/Users/jane");
    expect(list[0]).toBe("/Users/jane/.wrangler/config/default.toml");
    expect(list).toContain(
      "/Users/jane/Library/Preferences/.wrangler/config/default.toml",
    );
  });

  it("honours XDG_CONFIG_HOME on linux and skips the macOS path", () => {
    const list = wranglerConfigCandidates(
      { XDG_CONFIG_HOME: "/xdg" },
      "linux",
      "/home/jane",
    );
    expect(list).toEqual([
      "/home/jane/.wrangler/config/default.toml",
      "/xdg/.wrangler/config/default.toml",
      "/home/jane/.config/.wrangler/config/default.toml",
    ]);
  });
});
