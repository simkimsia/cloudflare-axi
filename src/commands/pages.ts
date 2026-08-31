import { assertNoArgs } from "../args.js";
import { renderHelp, renderList, renderOutput } from "../toon.js";
import { wranglerJson } from "../wrangler.js";

export const PAGES_HELP = `usage: cloudflare-axi pages
Lists all Cloudflare Pages projects in your account (name, primary domain, git, last modified).
flags: none
examples:
  cloudflare-axi pages
`;

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

export async function pagesCommand(args: string[]): Promise<string> {
  assertNoArgs("pages", args);
  const projects = await wranglerJson<PagesProjectRow[]>([
    "pages",
    "project",
    "list",
    "--json",
  ]);

  if (projects.length === 0) {
    return "projects: 0 Pages projects found in this account";
  }

  return renderOutput([
    `count: ${projects.length} Pages projects`,
    renderList("projects", toPagesRows(projects)),
    renderHelp([
      "Run `wrangler pages deployment list --project-name <name>` for a project's deployments",
      "Run `cloudflare-axi whoami` to see which account this is",
    ]),
  ]);
}
