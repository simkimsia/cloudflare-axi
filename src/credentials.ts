import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError, notAuthenticatedError } from "./errors.js";
import { wranglerExec } from "./wrangler.js";

/**
 * Credentials for direct Cloudflare REST API calls (surfaces wrangler does not
 * wrap, e.g. Email Routing). Precedence mirrors wrangler's own:
 *   1. CLOUDFLARE_API_TOKEN in the environment
 *   2. the OAuth token `wrangler login` stored in its global config
 */
export interface ApiCredentials {
  token: string;
  source: "env" | "wrangler-oauth";
  /** Config file the OAuth token was read from (absent for env tokens). */
  path?: string;
}

export interface WranglerOAuthConfig {
  oauthToken?: string;
  expirationTime?: string;
  scopes: string[];
}

/**
 * Minimal reader for wrangler's `config/default.toml`. The file is flat
 * key = "value" pairs plus one `scopes = [ ... ]` array, so a regex parser is
 * enough; pulling in a TOML dependency for this would be overkill.
 */
export function parseWranglerConfig(toml: string): WranglerOAuthConfig {
  const str = (key: string): string | undefined =>
    new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1];
  const scopesRaw = /^\s*scopes\s*=\s*\[([^\]]*)\]/m.exec(toml)?.[1] ?? "";
  const scopes = [...scopesRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return {
    oauthToken: str("oauth_token"),
    expirationTime: str("expiration_time"),
    scopes,
  };
}

/**
 * Where `wrangler login` may have written its config, most-preferred first.
 * Mirrors wrangler's getGlobalWranglerConfigPath: the legacy `~/.wrangler`
 * directory wins when it exists, otherwise the XDG config dir, which on macOS
 * is `~/Library/Preferences/.wrangler` (the gotcha from issue #3: an agent
 * shell may look in `~/.wrangler` while wrangler wrote to Preferences).
 */
export function wranglerConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const rel = join("config", "default.toml");
  const candidates = [join(home, ".wrangler", rel)];
  if (env.XDG_CONFIG_HOME) {
    candidates.push(join(env.XDG_CONFIG_HOME, ".wrangler", rel));
  }
  if (platform === "darwin") {
    candidates.push(join(home, "Library", "Preferences", ".wrangler", rel));
  }
  candidates.push(join(home, ".config", ".wrangler", rel));
  return [...new Set(candidates)];
}

/** OAuth access tokens live about an hour; treat "expires within a minute" as expired. */
export function isTokenExpired(
  expirationTime: string | undefined,
  now: number = Date.now(),
  skewMs = 60_000,
): boolean {
  if (!expirationTime) return false;
  const expiresAt = new Date(expirationTime).getTime();
  if (isNaN(expiresAt)) return false;
  return expiresAt - skewMs <= now;
}

function expiredTokenError(path: string): AxiError {
  return new AxiError(
    "The wrangler OAuth token has expired and could not be refreshed",
    "AUTH",
    [
      "Run `wrangler login` in an interactive terminal, then retry",
      "Or set CLOUDFLARE_API_TOKEN for non-interactive use",
      `Token read from ${path}`,
    ],
  );
}

export async function resolveApiCredentials(): Promise<ApiCredentials> {
  const envToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "env" };

  const path = wranglerConfigCandidates().find((p) => existsSync(p));
  if (!path) throw notAuthenticatedError();

  let config = parseWranglerConfig(readFileSync(path, "utf8"));
  if (!config.oauthToken) throw notAuthenticatedError();

  if (isTokenExpired(config.expirationTime)) {
    // wrangler refreshes an expired access token on any authenticated call
    // and rewrites its config file; `whoami` is the cheapest such call.
    await wranglerExec(["whoami"]);
    config = parseWranglerConfig(readFileSync(path, "utf8"));
    if (!config.oauthToken || isTokenExpired(config.expirationTime)) {
      throw expiredTokenError(path);
    }
  }
  return { token: config.oauthToken, source: "wrangler-oauth", path };
}
