import { renderHelp, renderList, renderOutput } from "../toon.js";
import { wranglerJson } from "../wrangler.js";
import { toDeploymentRows, type WranglerDeployment } from "./deployments.js";
import { toPagesRows, type PagesProjectRow } from "./pages.js";

const HOME_ROW_LIMIT = 3;

export async function homeCommand(): Promise<string> {
  // Content first (AXI §8): show the Worker configured in this directory if
  // there is one, otherwise the account's Pages projects — never a usage manual.
  const deployments = await wranglerJson<WranglerDeployment[]>([
    "deployments",
    "list",
    "--json",
  ]).catch(() => undefined);

  if (deployments) {
    const rows = toDeploymentRows([...deployments].reverse()).slice(
      0,
      HOME_ROW_LIMIT,
    );
    return renderOutput([
      `worker: configured in this directory (${deployments.length} deployments)`,
      renderList("deployments", rows),
      renderHelp([
        "Run `cloudflare-axi deployments` for the full deployment list",
        "Run `cloudflare-axi pages` or `cloudflare-axi kv` for account-wide views",
      ]),
    ]);
  }

  const projects = await wranglerJson<PagesProjectRow[]>([
    "pages",
    "project",
    "list",
    "--json",
  ]).catch(() => [] as PagesProjectRow[]);

  const blocks: string[] = ["worker: none configured in this directory"];
  const hints: string[] = [];

  if (projects.length === 0) {
    blocks.push("projects: 0 Pages projects found in this account");
  } else {
    blocks.push(
      renderList("projects", toPagesRows(projects).slice(0, HOME_ROW_LIMIT)),
    );
    if (projects.length > HOME_ROW_LIMIT) {
      hints.push(
        `Run \`cloudflare-axi pages\` for all ${projects.length} Pages projects`,
      );
    }
  }

  hints.push("Run `cloudflare-axi whoami` to see the logged-in account");
  blocks.push(renderHelp(hints));
  return renderOutput(blocks);
}
