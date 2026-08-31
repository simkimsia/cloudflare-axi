import { assertNoArgs } from "../args.js";
import { relativeTime, renderHelp, renderList, renderOutput } from "../toon.js";
import { wranglerJson } from "../wrangler.js";

export const DEPLOYMENTS_HELP = `usage: cloudflare-axi deployments
Lists the 10 most recent deployments of the Worker configured in the current directory
(wrangler.toml / wrangler.jsonc). Directory-scoped, like \`wrangler deployments list\`.
flags: none
examples:
  cloudflare-axi deployments
`;

/** Shape of `wrangler deployments list --json` entries (wrangler 4.x). */
export interface WranglerDeployment {
  id: string;
  source?: string;
  strategy?: string;
  author_email?: string;
  created_on: string;
  annotations?: Record<string, string>;
  versions?: { version_id: string; percentage: number }[];
}

export function toDeploymentRows(
  deployments: WranglerDeployment[],
): Record<string, unknown>[] {
  return deployments.map((d) => ({
    created: relativeTime(d.created_on),
    author: d.author_email ?? "unknown",
    source: d.source ?? "unknown",
    message: d.annotations?.["workers/message"] ?? "",
  }));
}

export async function deploymentsCommand(args: string[]): Promise<string> {
  assertNoArgs("deployments", args);
  const deployments = await wranglerJson<WranglerDeployment[]>([
    "deployments",
    "list",
    "--json",
  ]);

  if (deployments.length === 0) {
    return "deployments: 0 deployments found for this Worker";
  }

  // wrangler sorts oldest-first; newest-first reads better for agents.
  const rows = toDeploymentRows([...deployments].reverse());

  return renderOutput([
    `count: ${deployments.length} deployments (newest first)`,
    renderList("deployments", rows),
    renderHelp([
      "Run `wrangler deployments status` for the active deployment",
      "Run `wrangler versions list` for uploaded versions",
    ]),
  ]);
}
