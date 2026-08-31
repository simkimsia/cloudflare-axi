export type ErrorCode =
  | "AUTH"
  | "NOT_CONFIGURED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "WRANGLER_NOT_INSTALLED"
  | "UNKNOWN";

export class AxiError extends Error {
  readonly code: ErrorCode;
  readonly suggestions: string[];

  constructor(message: string, code: ErrorCode, suggestions: string[] = []) {
    super(message);
    this.name = "AxiError";
    this.code = code;
    this.suggestions = suggestions;
  }
}

export function exitCodeForError(error: AxiError): number {
  return error.code === "VALIDATION_ERROR" ? 2 : 1;
}

export function wranglerNotInstalledError(): AxiError {
  return new AxiError(
    "Cloudflare CLI (wrangler) is not installed or not on PATH",
    "WRANGLER_NOT_INSTALLED",
    ["Install it: `pnpm add -g wrangler` or `npm install -g wrangler`"],
  );
}

export function notAuthenticatedError(): AxiError {
  return new AxiError("Not logged in to Cloudflare", "AUTH", [
    "Run `wrangler login` in an interactive terminal, then retry",
    "Or set CLOUDFLARE_API_TOKEN for non-interactive use",
  ]);
}

/** Wrangler colors its stderr; strip ANSI escapes before pattern matching. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

interface ErrorPattern {
  pattern: RegExp;
  code: ErrorCode;
  message?: string;
  suggestions: string[];
}

// Walked in order; first regex hit wins, so narrow patterns must sit ahead of
// broader ones (same contract as gh-axi's mapGhError). Every pattern below was
// verified against real wrangler 4.x stderr.
const patterns: ErrorPattern[] = [
  {
    // Real stderr (no stored credentials, non-interactive): "In a
    // non-interactive environment, it's necessary to set a
    // CLOUDFLARE_API_TOKEN environment variable for wrangler to work."
    pattern: /non-interactive environment.*CLOUDFLARE_API_TOKEN/is,
    code: "AUTH",
    message: "Not logged in to Cloudflare",
    suggestions: [
      "Run `wrangler login` in an interactive terminal, then retry",
      "Or set CLOUDFLARE_API_TOKEN for non-interactive use",
    ],
  },
  {
    // Real stderr (bad token): "Authentication error [code: 10000]" /
    // "Invalid request headers [code: 6003]" /
    // "Invalid format for Authorization header [code: 6111]".
    pattern:
      /Authentication error \[code: 10000\]|Invalid request headers \[code: 6003\]|Invalid format for Authorization header|not authenticated/i,
    code: "AUTH",
    message: "Cloudflare rejected the credentials",
    suggestions: [
      "Run `wrangler whoami` to inspect the active credentials",
      "Run `wrangler login`, or fix CLOUDFLARE_API_TOKEN, then retry",
    ],
  },
  {
    // Real stderr (no wrangler config in cwd): "You need to provide a name
    // for your Worker. Either pass it as a cli arg with `--name <name>` or in
    // your configuration file as `name = \"<name>\"`".
    pattern: /You need to provide a name for your Worker/i,
    code: "NOT_CONFIGURED",
    message: "No Worker is configured in this directory",
    suggestions: [
      "Run from a directory with a wrangler config (wrangler.toml / wrangler.jsonc)",
      "Run `cloudflare-axi pages` or `cloudflare-axi kv` for account-wide views",
    ],
  },
  {
    // Real stderr: "This Worker does not exist on your account.
    // [code: 10007]".
    pattern: /does not exist on your account|\[code: 10007\]|not found/i,
    code: "NOT_FOUND",
    suggestions: ["Check the Worker name in your wrangler config"],
  },
];

/** Translate raw wrangler stderr into a structured, actionable AxiError. */
export function mapWranglerError(stderr: string, exitCode: number): AxiError {
  const trimmed = stripAnsi(stderr).trim();
  for (const entry of patterns) {
    if (entry.pattern.test(trimmed)) {
      return new AxiError(
        entry.message ?? errorLine(trimmed),
        entry.code,
        entry.suggestions,
      );
    }
  }
  return new AxiError(
    errorLine(trimmed) || `wrangler exited with code ${exitCode}`,
    "UNKNOWN",
  );
}

/**
 * First meaningful line of wrangler stderr, with the "✘ [ERROR]" marker
 * dropped. Real failures look like:
 *   ✘ [ERROR] A request to the Cloudflare API (...) failed.
 *   <blank>
 *     Some detail [code: NNNN]
 * so prefer the first indented detail line when the marker line is only the
 * generic API-request preamble.
 */
function errorLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[✘✗]?\s*\[ERROR\]\s*/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("🪵"));
  if (lines.length === 0) return "";
  if (/^A request to the Cloudflare API/.test(lines[0]) && lines.length > 1) {
    return lines[1];
  }
  return lines[0];
}
