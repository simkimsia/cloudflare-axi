import { describe, expect, it } from "vitest";
import { parseWhoami } from "../src/commands/whoami.js";

// Real `wrangler whoami` stdout (wrangler 4.127.1), captured live.
const LOGGED_IN = `
 ⛅️ wrangler 4.127.1
────────────────────
Getting User settings...
👋 You are logged in with an OAuth Token, associated with the email jane@example.com.
🔐 Credentials are stored in: /Users/jane/.wrangler/config/default.toml
┌──────────────┬──────────────────────────────────┐
│ Account Name │ Account ID                       │
├──────────────┼──────────────────────────────────┤
│ Acme         │ 67f26364f1b3e31c82c5182b3a63b92c │
└──────────────┴──────────────────────────────────┘
🔓 Token Permissions:
Scope (Access)
- user (read)
`;

// Real logged-out stdout — note wrangler exits 0 in this state.
const LOGGED_OUT = `
 ⛅️ wrangler 4.127.1
────────────────────
Getting User settings...
You are not authenticated. Please run \`wrangler login\`.
To deploy without logging in, run a command like \`wrangler deploy --temporary\` to use a temporary preview account.
`;

describe("parseWhoami", () => {
  it("extracts auth type, email, and account rows from real output", () => {
    expect(parseWhoami(LOGGED_IN)).toEqual({
      authenticated: true,
      auth: "OAuth Token",
      email: "jane@example.com",
      accounts: [{ name: "Acme", id: "67f26364f1b3e31c82c5182b3a63b92c" }],
    });
  });

  it("detects the logged-out message (which exits 0)", () => {
    expect(parseWhoami(LOGGED_OUT)).toEqual({
      authenticated: false,
      accounts: [],
    });
  });

  it("stays authenticated with no detail when the shape changes", () => {
    expect(parseWhoami("some new format")).toEqual({
      authenticated: true,
      accounts: [],
    });
  });
});
