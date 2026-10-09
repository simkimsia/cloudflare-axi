import { describe, expect, it } from "vitest";
import {
  exitCodeForError,
  mapWranglerError,
  stripAnsi,
  UNKNOWN_SUGGESTION,
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

// Real wrangler 4.127.1 stderr from the Pages write path, captured live
// 2026-09-04.
const PAGES_PROJECT_MISSING_STDERR = `${ERR(
  'The Pages project "no-such-project-xyz" does not exist.',
)}

  Maybe you intended to deploy a Worker project instead? Workers are the recommended way to deploy all new projects. If so, run \`wrangler deploy\`.`;

const PAGES_DEPLOYMENTS_MISSING_STDERR = `${ERR(
  "A request to the Cloudflare API (/accounts/abc/pages/projects/no-such-project-xyz/deployments) failed.",
)}

  Project not found. The specified project name does not match any of your existing projects. [code: 8000007]`;

const PAGES_PROJECT_EXISTS_STDERR = `${ERR(
  "A request to the Cloudflare API (/accounts/abc/pages/projects) failed.",
)}

  A project with this name already exists. Choose a different project name. [code: 8000002]`;

// Real wrangler 4.127.1 stderr from the Workers secret/deploy paths,
// captured live 2026-10-09.
const REQUIRED_NAME_MISSING_STDERR = ERR(
  "Required Worker name missing. Please specify the Worker name in your Wrangler configuration file, or pass it as an argument with `--name <worker-name>`",
);

const SECRET_WORKER_NOT_FOUND_STDERR = `${ERR(
  'Worker "no-such-worker-xyz-axi" not found.',
)}

  If this is a new Worker, run \`wrangler deploy\` first to create it.
  Otherwise, check that the Worker name is correct and you're logged into the right account.`;

const NO_ENTRY_POINT_STDERR = ERR(
  "Missing entry-point to Worker script or to assets directory",
);

const NO_STATIC_DIR_STDERR = ERR(
  "Could not detect a directory containing static files (e.g. html, css and js) for the project",
);

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

  it("maps a missing Worker name to NOT_LINKED with a config suggestion", () => {
    const err = mapWranglerError(NO_WORKER_NAME_STDERR, 1);
    expect(err.code).toBe("NOT_LINKED");
    expect(err.suggestions.join(" ")).toContain("wrangler config");
  });

  it("maps a nonexistent Worker (code 10007) to NOT_FOUND", () => {
    const err = mapWranglerError(WORKER_NOT_FOUND_STDERR, 1);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("maps 'Required Worker name missing' to NOT_LINKED with a --name hint", () => {
    const err = mapWranglerError(REQUIRED_NAME_MISSING_STDERR, 1);
    expect(err.code).toBe("NOT_LINKED");
    expect(err.suggestions.join(" ")).toContain("--name <worker>");
  });

  it("maps 'Worker \"x\" not found.' to NOT_FOUND with the workers suggestion, not the generic one", () => {
    const err = mapWranglerError(SECRET_WORKER_NOT_FOUND_STDERR, 1);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('Worker "no-such-worker-xyz-axi" not found.');
    expect(err.suggestions.join(" ")).toContain("workers deploy --dry-run");
    expect(err.suggestions).not.toContain(
      "Check the Worker name in your wrangler config",
    );
  });

  it("maps the no-config deploy errors to NOT_LINKED", () => {
    expect(mapWranglerError(NO_ENTRY_POINT_STDERR, 1).code).toBe("NOT_LINKED");
    expect(mapWranglerError(NO_STATIC_DIR_STDERR, 1).code).toBe("NOT_LINKED");
  });

  it("maps a missing Pages project (deploy and deployment list shapes) to NOT_FOUND with a create hint", () => {
    const deploy = mapWranglerError(PAGES_PROJECT_MISSING_STDERR, 1);
    expect(deploy.code).toBe("NOT_FOUND");
    expect(deploy.message).toBe(
      'The Pages project "no-such-project-xyz" does not exist.',
    );
    expect(deploy.suggestions.join(" ")).toContain("pages create");
    expect(mapWranglerError(PAGES_DEPLOYMENTS_MISSING_STDERR, 1).code).toBe(
      "NOT_FOUND",
    );
  });

  it("maps a duplicate Pages project name (code 8000002) to ALREADY_EXISTS", () => {
    const err = mapWranglerError(PAGES_PROJECT_EXISTS_STDERR, 1);
    expect(err.code).toBe("ALREADY_EXISTS");
    expect(err.suggestions.join(" ")).toContain("pages deploy");
  });

  it("falls back to UNKNOWN with the detail line, ANSI and [ERROR] stripped", () => {
    const err = mapWranglerError(ERR("Something exploded") + "\nstack line", 1);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("Something exploded");
    expect(err.suggestions).toEqual([UNKNOWN_SUGGESTION]);
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
