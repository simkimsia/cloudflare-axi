export type ErrorCode =
  | "AUTH"
  | "NOT_LINKED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "UNVERIFIED"
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

export function exitCodeForError(error: { code: string }): number {
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
      "Already logged in? wrangler stores its login under ~/.wrangler or, on macOS, ~/Library/Preferences/.wrangler; a shell with a different HOME will not see it",
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
      "A CLOUDFLARE_API_TOKEN also needs the permission for this operation (e.g. Pages:Edit to create or deploy a Pages project)",
    ],
  },
  {
    // Real stderr (`wrangler pages deploy` to an unknown project): 'The
    // Pages project "x" does not exist.' followed by Workers upsell text.
    // `wrangler pages deployment list` says instead: "Project not found. The
    // specified project name does not match any of your existing projects.
    // [code: 8000007]".
    pattern:
      /Pages project "[^"]+" does not exist|\[code: 8000007\]|Project not found\./i,
    code: "NOT_FOUND",
    suggestions: [
      "Run `cloudflare-axi pages` to list the projects in this account",
      "Run `cloudflare-axi pages create <name>` to create it first",
    ],
  },
  {
    // Real stderr (`wrangler pages project create` with a taken name): "A
    // project with this name already exists. Choose a different project
    // name. [code: 8000002]".
    pattern: /\[code: 8000002\]|A project with this name already exists/i,
    code: "ALREADY_EXISTS",
    message: "A Pages project with this name already exists in this account",
    suggestions: [
      "Run `cloudflare-axi pages deploy <dir> --project <name>` to deploy to the existing project",
      "Or pick a different name",
    ],
  },
  {
    // Real stderr (no wrangler config in cwd): "You need to provide a name
    // for your Worker. Either pass it as a cli arg with `--name <name>` or in
    // your configuration file as `name = \"<name>\"`".
    pattern: /You need to provide a name for your Worker/i,
    code: "NOT_LINKED",
    message: "No Worker is configured in this directory",
    suggestions: [
      "Run from a directory with a wrangler config (wrangler.toml / wrangler.jsonc)",
      "Run `cloudflare-axi pages` or `cloudflare-axi kv` for account-wide views",
    ],
  },
  {
    // Real stderr (`wrangler kv key get` for a missing key, captured
    // 2026-10-09): "Failed to fetch https://api.cloudflare.com/client/v4/
    // accounts/<a>/storage/kv/namespaces/<ns>/values/<key> - 404: Not Found".
    // A missing namespace gives the same 404. Only `kv get --binding` reads
    // through wrangler, and kv.ts rewrites its NOT_FOUND to name both causes
    // (missing key, or a binding whose namespace was deleted).
    pattern: /\/storage\/kv\/namespaces\/[^/\s]+\/values\/\S* - 404/i,
    code: "NOT_FOUND",
    message: "KV key not found in this namespace",
    suggestions: [
      "Run `cloudflare-axi kv keys <namespace> --prefix <start of key>` to check the exact key name (case-sensitive)",
      "A key written in the last 60s may not be visible yet",
    ],
  },
  {
    // Real stderr (`wrangler kv key list --namespace-id <unknown>`):
    // "get namespace: 'namespace not found' [code: 10013]".
    pattern: /\[code: 10013\]|'namespace not found'/i,
    code: "NOT_FOUND",
    message: "KV namespace not found in this account",
    suggestions: ["Run `cloudflare-axi kv` to list namespaces (title, id)"],
  },
  {
    // Real stderr (`--binding` with no matching config, captured
    // 2026-10-09): 'No KV namespace with binding "X" was found in the
    // "kv_namespaces" section of your wrangler config.' / "No KV namespaces
    // are configured in your wrangler config file."
    pattern:
      /No KV namespace with binding "[^"]+" was found|No KV namespaces are configured/i,
    code: "NOT_LINKED",
    message:
      "--binding matched no kv_namespaces entry in the wrangler config in cwd",
    suggestions: [
      "--binding reads the wrangler config in cwd; run from the Worker's directory",
      "Or pass --namespace <title|id>; `cloudflare-axi kv` lists them",
    ],
  },
  {
    // wrangler 4.127.1 source (kv namespace create, API code 10014): 'A KV
    // namespace with the title "x" already exists.'
    pattern: /A KV namespace with the title "[^"]+" already exists/i,
    code: "ALREADY_EXISTS",
    message: "A KV namespace with this title already exists in this account",
    suggestions: [
      "Run `cloudflare-axi kv` to see its id",
      "Or pick a different title",
    ],
  },
  {
    // Real stderr (`wrangler secret list` with no config and no --name,
    // captured 2026-10-09): "Required Worker name missing. Please specify
    // the Worker name in your Wrangler configuration file, or pass it as an
    // argument with `--name <worker-name>`".
    pattern: /Required Worker name missing/i,
    code: "NOT_LINKED",
    message: "No Worker is configured in this directory",
    suggestions: [
      "Run from a directory with a wrangler config (wrangler.toml / wrangler.jsonc)",
      "Or pass `--name <worker>`",
    ],
  },
  {
    // Real stderr (`wrangler secret list --name x` for a missing Worker,
    // captured 2026-10-09): 'Worker "x" not found.' then "If this is a new
    // Worker, run `wrangler deploy` first to create it."
    pattern: /Worker "[^"]+" not found\./i,
    code: "NOT_FOUND",
    suggestions: [
      "Run `cloudflare-axi workers deploy --dry-run` in the Worker's directory to see the name its config deploys",
      "cloudflare-axi cannot list the account's Workers yet; check the exact name under Workers & Pages in the Cloudflare dashboard",
      "A new Worker must be deployed first: `cloudflare-axi workers deploy --name <worker>`",
    ],
  },
  {
    // Real stderr (`wrangler deploy` with no config in cwd): autoconfig on
    // (default) says "Could not detect a directory containing static files";
    // --autoconfig=false says "Missing entry-point to Worker script or to
    // assets directory". `workers deploy` prechecks for a config first, so
    // this is a backstop.
    pattern:
      /Missing entry-point to Worker script|Could not detect a directory containing static files/i,
    code: "NOT_LINKED",
    message: "No Worker is configured in this directory",
    suggestions: [
      "Run from a directory with a wrangler config (wrangler.toml / wrangler.jsonc)",
      "Or pass `--config <path>` to the Worker's wrangler config",
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
    [UNKNOWN_SUGGESTION],
  );
}

export const UNKNOWN_SUGGESTION =
  "Rerun the same command with plain `wrangler` to see its full output, then report the gap at https://github.com/simkimsia/cloudflare-axi/issues";

/** For REST API failures, which have no plain `wrangler` command to rerun. */
export const REPORT_SUGGESTION =
  "Report the gap at https://github.com/simkimsia/cloudflare-axi/issues";

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

/** One entry of the `errors[]` array in a Cloudflare REST API envelope. */
export interface ApiErrorEntry {
  code: number;
  message: string;
}

// Cloudflare API error codes seen live (2026-09-04) that mean "bad or
// insufficient credentials": 10000 Authentication error (also returned for a
// zone id the token cannot see), 6003 Invalid request headers, 6111 Invalid
// format for Authorization header, 10001 Unable to authenticate request.
const API_AUTH_CODES = new Set([10000, 6003, 6111, 10001]);
// 7003 Could not route to <path>, 1001 resource not found, 9109 Invalid zone
// identifier (a 32-hex id that matches no zone). KV (seen live 2026-10-09,
// all HTTP 404): 10009 "get: 'key not found'" / "metadata: 'key not found'",
// 10013 "get namespace: 'namespace not found'".
export const API_KV_KEY_NOT_FOUND = 10009;
const API_KV_NAMESPACE_NOT_FOUND = 10013;
const API_NOT_FOUND_CODES = new Set([
  7003,
  1001,
  9109,
  API_KV_KEY_NOT_FOUND,
  API_KV_NAMESPACE_NOT_FOUND,
]);
// 2054 "Destination address is not verified" (seen live 2026-09-03 when
// creating a forward rule before the destination clicked its link).
const API_UNVERIFIED_CODES = new Set([2054]);

/** An AxiError from a REST call, keeping the API's numeric codes for callers that branch on them. */
export class CloudflareApiError extends AxiError {
  readonly status: number;
  readonly apiCodes: number[];

  constructor(
    message: string,
    code: ErrorCode,
    suggestions: string[],
    status: number,
    apiCodes: number[],
  ) {
    super(message, code, suggestions);
    this.status = status;
    this.apiCodes = apiCodes;
  }
}

/**
 * Translate a Cloudflare REST API failure into the same AxiError codes the
 * wrangler path uses. Separate from mapWranglerError because API JSON has
 * numeric codes rather than colored stderr text.
 */
export function mapApiError(
  status: number,
  errors: ApiErrorEntry[],
  path?: string,
): CloudflareApiError {
  const first = errors[0];
  const detail = first
    ? `${first.message} [code: ${first.code}]`
    : `HTTP ${status}${path ? ` from ${path}` : ""}`;
  const codes = errors.map((e) => e.code);

  // Cloudflare's numeric codes are more specific than its HTTP status (an
  // invalid zone id comes back 403), so match codes before falling back to
  // the status line.
  const isNotFound =
    codes.some((c) => API_NOT_FOUND_CODES.has(c)) ||
    (codes.length === 0 && status === 404);
  const isAuth =
    codes.some((c) => API_AUTH_CODES.has(c)) ||
    (!isNotFound && (status === 401 || status === 403));

  const make = (message: string, code: ErrorCode, suggestions: string[]) =>
    new CloudflareApiError(message, code, suggestions, status, codes);

  if (codes.some((c) => API_UNVERIFIED_CODES.has(c))) {
    return make(detail, "UNVERIFIED", [
      "Click the verification link Cloudflare emailed to the destination, then re-run",
      "Run `cloudflare-axi email addresses` to check which destinations are verified",
    ]);
  }
  if (codes.includes(API_KV_NAMESPACE_NOT_FOUND)) {
    return make(detail, "NOT_FOUND", [
      "Run `cloudflare-axi kv` to list namespaces (title, id)",
    ]);
  }
  if (codes.includes(API_KV_KEY_NOT_FOUND)) {
    return make(detail, "NOT_FOUND", [
      "Run `cloudflare-axi kv keys <namespace> --prefix <start of key>` to check the exact key name (case-sensitive)",
    ]);
  }
  if (isNotFound) {
    return make(detail, "NOT_FOUND", [
      "Check the zone name / id and that this account owns it",
    ]);
  }
  if (isAuth) {
    return make(`Cloudflare API rejected the credentials: ${detail}`, "AUTH", [
      "Run `wrangler whoami` to see the active token's scopes; re-run `wrangler login` to widen them",
      "Or set CLOUDFLARE_API_TOKEN to a token scoped for this resource",
      "A zone or account id these credentials cannot see reports as an authentication error too",
    ]);
  }
  if (status === 429) {
    return make(`Cloudflare API rate limited: ${detail}`, "UNKNOWN", [
      "Wait a moment and retry",
    ]);
  }
  return make(detail, "UNKNOWN", [REPORT_SUGGESTION]);
}
