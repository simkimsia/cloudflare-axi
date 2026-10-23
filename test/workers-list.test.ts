import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the spawn layer: these tests never run the real wrangler binary.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import { shellQuote } from "../src/config.js";
import { HOME_WORKERS_TIMEOUT_MS, homeCommand } from "../src/commands/home.js";
import { toWorkerRow, workersCommand } from "../src/commands/workers.js";
import { failure, fakeWrangler } from "./fake-wrangler.js";

const ok = (result: unknown) =>
  new Response(
    JSON.stringify({ success: true, errors: [], messages: [], result }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
const apiError = (status: number, code: number, message: string) =>
  new Response(
    JSON.stringify({
      success: false,
      errors: [{ code, message }],
      result: null,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

// Shape of GET /accounts/{a}/workers/scripts (Cloudflare API docs: Script
// objects with id, modified_on and routes [{id, pattern, script}]).
const SCRIPTS = [
  { id: "old-router", modified_on: ago(40), routes: null },
  {
    id: "family-haze-bot",
    modified_on: ago(2),
    routes: [],
    handlers: ["fetch", "scheduled"],
  },
  {
    id: "api",
    modified_on: ago(10),
    routes: [
      { id: "r1", pattern: "example.com/api/*", script: "api" },
      { id: "r2", pattern: "www.example.com/api/*", script: "api" },
    ],
  },
];

interface StubOptions {
  scripts?: unknown;
  subdomain?: () => Response;
  schedules?: Record<string, string[]>;
  workersDev?: Record<string, boolean>;
  failDetails?: string[];
}

/** Stub the REST API for account "acc"; returns the requested paths. */
function stubApi(opts: StubOptions = {}) {
  const paths: string[] = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      paths.push(path);
      const account = /^\/accounts\/([^/]+)\/workers/.exec(path)?.[1];
      if (path === `/accounts/${account}/workers/scripts`)
        return ok(opts.scripts ?? SCRIPTS);
      if (path === `/accounts/${account}/workers/subdomain`)
        return opts.subdomain
          ? opts.subdomain()
          : ok({ subdomain: "llm-powered-job-watch" });
      const m = /\/workers\/scripts\/([^/]+)\/(schedules|subdomain)$/.exec(
        path,
      );
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (opts.failDetails?.includes(name))
          return apiError(429, 971, "Please wait and consider throttling");
        if (m[2] === "schedules")
          return ok({
            schedules: (opts.schedules?.[name] ?? []).map((cron) => ({
              cron,
              created_on: ago(1),
              modified_on: ago(1),
            })),
          });
        return ok({
          enabled: opts.workersDev?.[name] ?? true,
          previews_enabled: true,
        });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return paths;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "workers-list-test-"));
  // No wrangler config anywhere above cwd.
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(execFile).mockReset();
});

describe("toWorkerRow", () => {
  const script = {
    id: "bot",
    modified_on: ago(3),
    routes: [{ pattern: "a.com/*" }, { pattern: "b.com/*" }],
  };

  it("builds the workers.dev URL from the account subdomain", () => {
    expect(
      toWorkerRow(script, "acme", { crons: ["*/5 * * * *"], workersDev: true }),
    ).toEqual({
      name: "bot",
      url: "https://bot.acme.workers.dev",
      modified: "3d ago",
      crons: "*/5 * * * *",
      routes: "a.com/*; b.com/*",
    });
  });

  it("says off, none and unknown rather than guessing", () => {
    expect(
      toWorkerRow({ id: "x" }, "acme", { crons: [], workersDev: false }),
    ).toMatchObject({ url: "off", crons: "none", routes: "none" });
    expect(
      toWorkerRow({ id: "x" }, null, { crons: [], workersDev: true }),
    ).toMatchObject({ url: "none (no account subdomain)" });
    expect(toWorkerRow({ id: "x", routes: null }, "acme", {})).toMatchObject({
      url: "unknown",
      crons: "unknown",
      modified: "unknown",
    });
  });
});

describe("workers list", () => {
  it("lists every Worker newest first with url, crons and routes, over REST only", async () => {
    const calls = fakeWrangler(() => ({}));
    const paths = stubApi({
      schedules: { "family-haze-bot": ["*/5 * * * *", "15 9 * * *"] },
      workersDev: { api: false },
    });
    const out = await workersCommand(["list"]);
    expect(calls).toHaveLength(0);
    expect(paths.slice(0, 2)).toEqual([
      "/accounts/acc/workers/scripts",
      "/accounts/acc/workers/subdomain",
    ]);
    expect(paths).toContain(
      "/accounts/acc/workers/scripts/family-haze-bot/schedules",
    );
    expect(paths).toContain("/accounts/acc/workers/scripts/api/subdomain");
    expect(paths).toHaveLength(2 + 2 * SCRIPTS.length);
    expect(out).toContain("account: acc");
    expect(out).toContain("subdomain: llm-powered-job-watch.workers.dev");
    expect(out).toContain("count: 3 Workers");
    expect(out).toContain("workers[3]{name,url,modified,crons,routes}:");
    const rows = out.split("\n").filter((l) => /^ {2}\S+,/.test(l));
    expect(rows.map((l) => l.trim().split(",")[0])).toEqual([
      "family-haze-bot",
      "api",
      "old-router",
    ]);
    expect(out).toContain(
      'family-haze-bot,"https://family-haze-bot.llm-powered-job-watch.workers.dev",2d ago,*/5 * * * *; 15 9 * * *,none',
    );
    expect(out).toContain(
      "api,off,10d ago,none,example.com/api/*; www.example.com/api/*",
    );
    expect(out).toContain(
      "changing llm-powered-job-watch.workers.dev changes the URL of all 2 Workers served on it",
    );
    expect(out).not.toContain("unknown");
  });

  it("reports an account with no workers.dev subdomain (code 10007) instead of failing", async () => {
    fakeWrangler(() => ({}));
    stubApi({
      subdomain: () =>
        apiError(404, 10007, "workers.api.error.subdomain_not_found"),
    });
    const out = await workersCommand(["list"]);
    expect(out).toContain("subdomain: none registered");
    expect(out).toContain("none (no account subdomain)");
    expect(out).not.toContain("account-wide");
  });

  it("says unknown for a Worker whose details could not be read, and why", async () => {
    fakeWrangler(() => ({}));
    stubApi({ failDetails: ["api"] });
    const out = await workersCommand(["list"]);
    expect(out).toContain("api,unknown,10d ago,unknown,");
    expect(out).toContain("crons or url are unknown for 1 Workers");
    expect(out).toContain("rate limited");
  });

  it("prints an empty account plainly", async () => {
    fakeWrangler(() => ({}));
    const paths = stubApi({ scripts: [] });
    const out = await workersCommand(["list"]);
    expect(out).toContain("workers: 0 Workers in this account");
    expect(out).toContain("subdomain: llm-powered-job-watch.workers.dev");
    expect(paths).toHaveLength(2);
  });

  it("fails on an auth error from the scripts list", async () => {
    fakeWrangler(() => ({}));
    stubApi({ scripts: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => apiError(403, 10000, "Authentication error")),
    );
    const err = await failure(workersCommand(["list"]));
    expect(err.code).toBe("AUTH");
  });

  it("uses the --config account_id and carries --config into hints", async () => {
    fakeWrangler(() => ({}));
    const config = join(dir, "wrangler.toml");
    writeFileSync(config, 'name = "x"\naccount_id = "cfgacc"\n');
    const paths = stubApi();
    const out = await workersCommand(["list", "--config", config]);
    expect(paths[0]).toBe("/accounts/cfgacc/workers/scripts");
    expect(out).toContain("account: cfgacc");
    expect(out).toContain(`--name <worker> --config ${shellQuote(config)}`);
  });

  it("refuses with nothing listed when several accounts are visible", async () => {
    fakeWrangler(() => ({}));
    stubApi();
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ok([
          { id: "a1", name: "One" },
          { id: "a2", name: "Two" },
        ]),
      ),
    );
    const err = await failure(workersCommand(["list"]));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("nothing listed");
    expect(err.suggestions.join(" ")).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("rejects stray arguments before any call", async () => {
    const paths = stubApi();
    const err = await failure(workersCommand(["list", "--name", "x"]));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("--name");
    expect(paths).toEqual([]);
  });

  it("keeps at most 6 detail requests in flight (3 Workers at a time)", async () => {
    fakeWrangler(() => ({}));
    const scripts = Array.from({ length: 10 }, (_, i) => ({
      id: `w${i}`,
      modified_on: ago(i + 1),
    }));
    stubApi({ scripts });
    const answer = vi.mocked(fetch).getMockImplementation()!;
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const detail = /\/scripts\/[^/]+\/(schedules|subdomain)$/.test(url);
        if (!detail) return answer(url);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return answer(url);
      }),
    );
    const out = await workersCommand(["list"]);
    expect(out).toContain("count: 10 Workers");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2 + 2 * scripts.length);
    expect(peak).toBe(6);
  });

  it("is in the workers help", async () => {
    const out = await workersCommand([]);
    expect(out).toContain("list, deploy, delete");
    expect(out).toContain("cloudflare-axi workers list");
  });
});

describe("dashboard workers block", () => {
  // No config in cwd: `wrangler deployments list` fails, Pages lists one project.
  const PAGES = JSON.stringify([
    {
      "Project Name": "site",
      "Project Domains": "site.pages.dev",
      "Git Provider": "No",
      "Last Modified": "1 day ago",
    },
  ]);
  const wrangler = () =>
    fakeWrangler((args) =>
      args[0] === "pages"
        ? { stdout: PAGES }
        : {
            stderr: "You need to provide a name for your Worker",
            exitCode: 1,
          },
    );

  it("shows the account's Workers next to the Pages projects", async () => {
    wrangler();
    const paths = stubApi({
      scripts: [...SCRIPTS, { id: "fourth", modified_on: ago(50) }],
    });
    const out = await homeCommand();
    expect(out).toContain("projects[1]");
    expect(out).toContain("workers[3]{name,modified}:");
    expect(out).toContain("family-haze-bot,2d ago");
    expect(out).not.toContain("fourth");
    expect(out).toContain("for all 4 Workers with its workers.dev URL");
    // The dashboard reads only the scripts list, not per-Worker details.
    expect(paths).toEqual(["/accounts/acc/workers/scripts"]);
  });

  it("says it could not list Workers rather than showing an empty account", async () => {
    wrangler();
    stubApi();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => apiError(403, 10000, "Authentication error")),
    );
    const out = await homeCommand();
    expect(out).toContain("workers: could not list (AUTH)");
    expect(out).toContain("projects[1]");
  });

  it("says an empty account has 0 Workers", async () => {
    wrangler();
    const paths = stubApi({ scripts: [] });
    const out = await homeCommand();
    expect(out).toContain("workers: 0 Workers in this account");
    expect(out).not.toContain("could not list");
    expect(out).not.toContain("cloudflare-axi workers list` for");
    expect(paths).toEqual(["/accounts/acc/workers/scripts"]);
  });

  it("gives up on a hung API after a short timeout and says it could not list", async () => {
    wrangler();
    stubApi();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() =>
        AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) reject(signal.reason);
            signal?.addEventListener("abort", () => reject(signal.reason));
          }),
      ),
    );
    const out = await homeCommand();
    expect(timeout).toHaveBeenCalledWith(HOME_WORKERS_TIMEOUT_MS);
    expect(HOME_WORKERS_TIMEOUT_MS).toBe(10_000);
    expect(out).toContain("workers: could not list (UNKNOWN)");
    expect(out).toContain("projects[1]");
  });
});
