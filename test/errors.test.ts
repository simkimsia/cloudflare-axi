import { describe, expect, it } from "vitest";
import {
  exitCodeForError,
  mapWranglerError,
  stripAnsi,
} from "../src/errors.js";

// Real wrangler 4.127.1 stderr, ANSI escapes included, captured live.
const ERR = (body: string) =>
  `[31m✘ [41;31m[[41;97mERROR[41;31m][0m [1m${body}[0m`;

const NO_CREDENTIALS_STDERR = `${ERR(
  "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work. Please go to https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ for instructions on how to create an api token, and assign its value to CLOUDFLARE_API_TOKEN.",
)}

  To continue without logging in, rerun this command with \`--temporary\`.

🪵  Logs were written to "/Users/me/.wrangler/logs/wrangler-2026-08-31.log"`;

const BAD_TOKEN_STDERR = `${ERR("A request to the Cloudflare API failed.")}

  Authentication error [code: 10000]

  If you think this is a bug, please open an issue`;

const BAD_HEADER_STDERR = `${ERR(
  "A request to the Cloudflare API (/user/tokens/verify) failed.",
)}

  Invalid request headers [code: 6003]

  - Invalid format for Authorization header [code: 6111]`;

const NO_WORKER_NAME_STDERR = ERR(
  'You need to provide a name for your Worker. Either pass it as a cli arg with `--name <name>` or in your configuration file as `name = "<name>"`',
);

const WORKER_NOT_FOUND_STDERR = `${ERR(
  "A request to the Cloudflare API (/accounts/abc/workers/scripts/no-such-worker/deployments) failed.",
)}

  This Worker does not exist on your account. [code: 10007]`;

describe("stripAnsi", () => {
  it("removes wrangler's color escapes", () => {
    expect(stripAnsi("[31m✘ [1mboom[0m")).toBe("✘ boom");
  });
});

describe("mapWranglerError", () => {
  it("maps a missing-credentials failure to AUTH with a login suggestion", () => {
    const err = mapWranglerError(NO_CREDENTIALS_STDERR, 1);
    expect(err.code).toBe("AUTH");
    expect(err.suggestions.join(" ")).toContain("wrangler login");
    expect(exitCodeForError(err)).toBe(1);
  });

  it("maps an invalid API token (code 10000) to AUTH", () => {
    const err = mapWranglerError(BAD_TOKEN_STDERR, 1);
    expect(err.code).toBe("AUTH");
    expect(err.suggestions.join(" ")).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("maps a malformed Authorization header (codes 6003/6111) to AUTH", () => {
    const err = mapWranglerError(BAD_HEADER_STDERR, 1);
    expect(err.code).toBe("AUTH");
  });

  it("maps a missing Worker name to NOT_CONFIGURED with a config suggestion", () => {
    const err = mapWranglerError(NO_WORKER_NAME_STDERR, 1);
    expect(err.code).toBe("NOT_CONFIGURED");
    expect(err.suggestions.join(" ")).toContain("wrangler config");
  });

  it("maps a nonexistent Worker (code 10007) to NOT_FOUND", () => {
    const err = mapWranglerError(WORKER_NOT_FOUND_STDERR, 1);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("falls back to UNKNOWN with the detail line, ANSI and [ERROR] stripped", () => {
    const err = mapWranglerError(ERR("Something exploded") + "\nstack line", 1);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("Something exploded");
  });

  it("prefers the API detail line over the generic request preamble", () => {
    const err = mapWranglerError(
      `${ERR("A request to the Cloudflare API (/zones) failed.")}\n\n  Rate limited [code: 971]`,
      1,
    );
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("Rate limited [code: 971]");
  });

  it("reports the exit code when stderr is empty", () => {
    const err = mapWranglerError("", 3);
    expect(err.message).toBe("wrangler exited with code 3");
  });
});
