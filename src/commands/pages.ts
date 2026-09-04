import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertNoArgs,
  rejectExtraArgs,
  takeFlag,
  takePositional,
} from "../args.js";
import { AxiError } from "../errors.js";
import { encode, renderHelp, renderList, renderOutput } from "../toon.js";
import { wranglerExec, wranglerJson } from "../wrangler.js";

export const PAGES_HELP = `usage: cloudflare-axi pages [subcommand] [flags]
Cloudflare Pages: list projects, create one, deploy a static directory, list a project's deployments.
subcommands[4]:
  (none)=list all Pages projects, create <name>, deploy <dir> --project <name>, deployments <name>
flags{create}:
  --production-branch <branch> (default main)
flags{deploy}:
  --project <name> (required; never inferred), --branch <branch> (default main), --commit-message <text>
flags{deployments}:
  --environment <production|preview>, --limit <n> (default 10, newest first)
notes:
  deploy with the default --branch main deploys to PRODUCTION (main is the production branch unless the project was created with another); pass --branch <other> for a preview deployment
  deploy always passes --commit-dirty=true to wrangler, so the git state of the shell's cwd never blocks or prompts
  deploy refuses a missing or empty directory before calling wrangler (wrangler itself happily publishes 0 files)
examples:
  cloudflare-axi pages
  cloudflare-axi pages create my-site
  cloudflare-axi pages deploy ./dist --project my-site
  cloudflare-axi pages deploy ./dist --project my-site --branch preview
  cloudflare-axi pages deployments my-site --environment production
`;

const USAGE = {
  create: "cloudflare-axi pages create <name> [--production-branch <branch>]",
  deploy:
    "cloudflare-axi pages deploy <dir> --project <name> [--branch <branch>] [--commit-message <text>]",
  deployments:
    "cloudflare-axi pages deployments <name> [--environment production|preview] [--limit <n>]",
};

/**
 * Quirk: `wrangler pages project list --json` emits display-oriented keys
 * ("Project Name", "Last Modified" as pre-rendered relative time), not API
 * field names.
 */
export interface PagesProjectRow {
  "Project Name": string;
  "Project Domains": string;
  "Git Provider": string;
  "Last Modified": string;
}

export function toPagesRows(
  projects: PagesProjectRow[],
): Record<string, unknown>[] {
  return projects.map((p) => {
    const domains = (p["Project Domains"] ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    return {
      name: p["Project Name"],
      domain: domains[0] ?? "none",
      git: p["Git Provider"] === "Yes" ? "yes" : "no",
      modified: p["Last Modified"] ?? "unknown",
    };
  });
}

/**
 * Same quirk for `wrangler pages deployment list --json` (wrangler 4.x):
 * display keys, and "Status" is a pre-rendered relative time ("1 day ago"),
 * not a status.
 */
export interface PagesDeploymentRow {
  Id: string;
  Environment: string;
  Branch: string;
  Source: string;
  Deployment: string;
  Status: string;
  Build: string;
}

export function toDeploymentRows(
  deployments: PagesDeploymentRow[],
): Record<string, unknown>[] {
  return deployments.map((d) => ({
    id: d.Id.slice(0, 8),
    env: d.Environment.toLowerCase(),
    branch: d.Branch,
    source: d.Source || "-",
    url: d.Deployment,
    created: d.Status,
  }));
}

// ---- list (unchanged v0 behaviour) ----

async function listProjects(args: string[]): Promise<string> {
  assertNoArgs("pages", args);
  const projects = await wranglerJson<PagesProjectRow[]>([
    "pages",
    "project",
    "list",
    "--json",
  ]);

  if (projects.length === 0) {
    return renderOutput([
      "projects: 0 Pages projects found in this account",
      renderHelp(["Run `cloudflare-axi pages create <name>` to create one"]),
    ]);
  }

  return renderOutput([
    `count: ${projects.length} Pages projects`,
    renderList("projects", toPagesRows(projects)),
    renderHelp([
      "Run `cloudflare-axi pages deployments <name>` for a project's deployments",
      "Run `cloudflare-axi pages deploy <dir> --project <name>` to publish a static directory",
      "Run `cloudflare-axi whoami` to see which account this is",
    ]),
  ]);
}

// ---- create ----

/**
 * Parse `wrangler pages project create` stdout (text only). Real line:
 *   ✨ Successfully created the 'my-site' project. It will be available at
 *   https://my-site.pages.dev/ once you create your first deployment.
 */
export function parseCreateOutput(stdout: string): {
  name?: string;
  url?: string;
} {
  const m =
    /Successfully created the '([^']+)' project\.(?: It will be available at (\S+?)\/?(?:\s|$))?/.exec(
      stdout,
    );
  return m ? { name: m[1], url: m[2] } : {};
}

async function createProject(args: string[]): Promise<string> {
  const productionBranch = takeFlag(args, "--production-branch") ?? "main";
  const name = takePositional(args);
  if (!name) {
    throw new AxiError("project name is required", "VALIDATION_ERROR", [
      USAGE.create,
    ]);
  }
  rejectExtraArgs("pages create", args, USAGE.create);

  const stdout = await wranglerExec([
    "pages",
    "project",
    "create",
    name,
    "--production-branch",
    productionBranch,
  ]);
  const parsed = parseCreateOutput(stdout);
  return renderOutput([
    encode({
      project: parsed.name ?? name,
      production_branch: productionBranch,
      url: parsed.url ?? `https://${name}.pages.dev`,
      status: "created (no deployments yet)",
    }),
    renderHelp([
      `Run \`cloudflare-axi pages deploy <dir> --project ${name}\` to publish a directory to it`,
    ]),
  ]);
}

// ---- deploy ----

export interface DeployResult {
  url?: string;
  aliasUrl?: string;
  uploaded?: number;
  alreadyUploaded?: number;
}

/**
 * Parse `wrangler pages deploy` stdout (streams progress; no --json). Real
 * lines (wrangler 4.127.1):
 *   ✨ Success! Uploaded 1 files (1.26 sec)
 *   ✨ Success! Uploaded 0 files (1 already uploaded) (0.58 sec)
 *   ✨ Deployment complete! Take a peek over at https://361a9b59.my-site.pages.dev
 *   ✨ Deployment alias URL: https://preview-x.my-site.pages.dev
 */
export function parseDeployOutput(stdout: string): DeployResult {
  const result: DeployResult = {};
  const complete = /Deployment complete! Take a peek over at (\S+)/.exec(
    stdout,
  );
  if (complete) result.url = complete[1];
  const alias = /Deployment alias URL: (\S+)/.exec(stdout);
  if (alias) result.aliasUrl = alias[1];
  const uploaded = /Uploaded (\d+) files(?: \((\d+) already uploaded\))?/.exec(
    stdout,
  );
  if (uploaded) {
    result.uploaded = Number(uploaded[1]);
    result.alreadyUploaded = uploaded[2] ? Number(uploaded[2]) : 0;
  }
  return result;
}

/** Refuse before spawning wrangler: it publishes an empty directory without complaint. */
export function assertDeployableDir(dir: string): void {
  const abs = resolve(dir);
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new AxiError(`${dir} is not a directory`, "VALIDATION_ERROR", [
      "Pass the directory of static files to publish, e.g. ./dist or ./public",
    ]);
  }
  const entries = readdirSync(abs).filter((e) => e !== ".DS_Store");
  if (entries.length === 0) {
    throw new AxiError(
      `${dir} is empty; nothing to deploy`,
      "VALIDATION_ERROR",
      [
        "Build the site first, or point at the directory that contains index.html",
      ],
    );
  }
}

async function deployDirectory(args: string[]): Promise<string> {
  const project = takeFlag(args, "--project");
  const branch = takeFlag(args, "--branch") ?? "main";
  const commitMessage = takeFlag(args, "--commit-message");
  const dir = takePositional(args);
  if (!dir) {
    throw new AxiError("directory is required", "VALIDATION_ERROR", [
      USAGE.deploy,
    ]);
  }
  if (!project) {
    // VISION.md safety: a write names its target in full, never inferred.
    throw new AxiError("--project is required", "VALIDATION_ERROR", [
      USAGE.deploy,
      "Run `cloudflare-axi pages` to list project names",
    ]);
  }
  rejectExtraArgs("pages deploy", args, USAGE.deploy);
  assertDeployableDir(dir);

  const started = Date.now();
  const stdout = await wranglerExec([
    "pages",
    "deploy",
    dir,
    "--project-name",
    project,
    "--branch",
    branch,
    "--commit-dirty=true",
    ...(commitMessage ? ["--commit-message", commitMessage] : []),
  ]);
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const parsed = parseDeployOutput(stdout);
  if (!parsed.url) {
    throw new AxiError(
      `wrangler reported no deployment URL: ${stdout.trim().split("\n").pop() ?? ""}`,
      "UNKNOWN",
      [
        `Run \`cloudflare-axi pages deployments ${project}\` to check whether it deployed`,
      ],
    );
  }

  // The deploy output has no id or environment; the newest deployment row
  // for this URL does. Best effort: a lookup failure must not fail a deploy
  // that already succeeded.
  const match = await wranglerJson<PagesDeploymentRow[]>([
    "pages",
    "deployment",
    "list",
    "--project-name",
    project,
    "--json",
  ])
    .then((rows) => rows.find((r) => r.Deployment === parsed.url))
    .catch(() => undefined);
  const environment = match?.Environment.toLowerCase();
  const isProduction = environment === "production";

  return renderOutput([
    encode({
      project,
      deployment: match?.Id ?? "unknown",
      environment: environment ?? "unknown",
      branch,
      url: parsed.url,
      ...(parsed.aliasUrl ? { alias: parsed.aliasUrl } : {}),
      ...(isProduction ? { production: `https://${project}.pages.dev` } : {}),
      uploaded: `${parsed.uploaded ?? "?"} files (${parsed.alreadyUploaded ?? 0} already uploaded)`,
      elapsed,
    }),
    renderHelp([
      isProduction
        ? `Live on production; custom domains attached to ${project} serve this deployment`
        : `Preview only; deploy with --branch main (or the project's production branch) to go live`,
      `Run \`cloudflare-axi pages deployments ${project}\` for the deployment history`,
    ]),
  ]);
}

// ---- deployments ----

async function listDeployments(args: string[]): Promise<string> {
  const environment = takeFlag(args, "--environment");
  const limitRaw = takeFlag(args, "--limit");
  const name = takePositional(args);
  if (!name) {
    throw new AxiError("project name is required", "VALIDATION_ERROR", [
      USAGE.deployments,
      "Run `cloudflare-axi pages` to list project names",
    ]);
  }
  rejectExtraArgs("pages deployments", args, USAGE.deployments);
  if (
    environment &&
    environment !== "production" &&
    environment !== "preview"
  ) {
    throw new AxiError(
      `--environment must be production or preview, got ${environment}`,
      "VALIDATION_ERROR",
      [USAGE.deployments],
    );
  }
  const limit = limitRaw === undefined ? 10 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AxiError(
      `--limit must be a positive integer, got ${limitRaw}`,
      "VALIDATION_ERROR",
      [USAGE.deployments],
    );
  }

  const deployments = await wranglerJson<PagesDeploymentRow[]>([
    "pages",
    "deployment",
    "list",
    "--project-name",
    name,
    "--json",
    ...(environment ? ["--environment", environment] : []),
  ]);
  if (deployments.length === 0) {
    return renderOutput([
      `deployments: 0 ${environment ?? ""} deployments for ${name}`.replace(
        "  ",
        " ",
      ),
      renderHelp([
        `Run \`cloudflare-axi pages deploy <dir> --project ${name}\` to create one`,
      ]),
    ]);
  }

  // wrangler returns newest first.
  const shown = deployments.slice(0, limit);
  return renderOutput([
    `count: ${shown.length} of ${deployments.length} deployments for ${name} (newest first)`,
    renderList("deployments", toDeploymentRows(shown)),
    renderHelp([
      ...(deployments.length > limit
        ? [
            `Run \`cloudflare-axi pages deployments ${name} --limit ${deployments.length}\` for all`,
          ]
        : []),
      "The newest production row is what the project's domains serve",
    ]),
  ]);
}

// ---- dispatch ----

const SUBCOMMANDS = ["create", "deploy", "deployments"] as const;

export async function pagesCommand(args: string[]): Promise<string> {
  const rest = [...args];
  const first = rest[0];
  if (first === undefined || first.startsWith("-")) {
    return listProjects(rest);
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
    throw new AxiError(
      `unknown subcommand ${first} for \`pages\``,
      "VALIDATION_ERROR",
      [
        `subcommands: ${SUBCOMMANDS.join(", ")} (or none to list projects)`,
        "cloudflare-axi pages --help",
      ],
    );
  }
  rest.shift();
  switch (first as (typeof SUBCOMMANDS)[number]) {
    case "create":
      return createProject(rest);
    case "deploy":
      return deployDirectory(rest);
    case "deployments":
      return listDeployments(rest);
  }
}
