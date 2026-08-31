import { assertNoArgs } from "../args.js";
import { notAuthenticatedError } from "../errors.js";
import { encode } from "../toon.js";
import { wranglerExec } from "../wrangler.js";

export const WHOAMI_HELP = `usage: cloudflare-axi whoami
Shows the Cloudflare account you are logged in as, with account name/id.
flags: none
examples:
  cloudflare-axi whoami
`;

export interface WhoamiInfo {
  authenticated: boolean;
  email?: string;
  auth?: string;
  accounts: { name: string; id: string }[];
}

export async function whoamiCommand(args: string[]): Promise<string> {
  assertNoArgs("whoami", args);
  const info = parseWhoami(await wranglerExec(["whoami"]));
  // Quirk: `wrangler whoami` exits 0 even when logged out, printing
  // "You are not authenticated. Please run `wrangler login`." on stdout —
  // surface that as a structured AUTH error, not a success.
  if (!info.authenticated) {
    throw notAuthenticatedError();
  }
  return encode({
    user: info.email ?? "unknown",
    ...(info.auth ? { auth: info.auth } : {}),
    accounts: info.accounts,
  });
}

/**
 * Parse `wrangler whoami` text. Real output (wrangler 4.x):
 *   👋 You are logged in with an OAuth Token, associated with the email me@x.com.
 *   ┌ Account Name │ Account ID ┐ table rows follow
 */
export function parseWhoami(raw: string): WhoamiInfo {
  if (/You are not authenticated/i.test(raw)) {
    return { authenticated: false, accounts: [] };
  }

  const login =
    /logged in with an? ([^,]+), associated with the email (\S+?)\.?(?:\s|$)/i.exec(
      raw,
    );

  const accounts: { name: string; id: string }[] = [];
  for (const line of raw.split("\n")) {
    const row = /^\s*│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│\s*$/.exec(line);
    if (row) accounts.push({ name: row[1], id: row[2] });
  }

  if (!login) {
    // Shape changed: still report what we can rather than fail.
    return { authenticated: true, accounts };
  }
  return {
    authenticated: true,
    auth: login[1],
    email: login[2],
    accounts,
  };
}
