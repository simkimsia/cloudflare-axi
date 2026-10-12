import { configSource, configSuffix } from "../config.js";
import { renderHelp, renderList, renderOutput } from "../toon.js";
import { wranglerJson } from "../wrangler.js";
import { listDeployments, toDeploymentRows } from "./deployments.js";
import { toPagesRows, type PagesProjectRow } from "./pages.js";

const HOME_ROW_LIMIT = 3;

/**
 * `config` is the resolved `--config` path from `cloudflare-axi --config <path>`
 * (parsed in src/cli.ts). With it, the Worker section is required: a failure
 * is reported, not swapped for the Pages fallback.
 */
export async function homeCommand(config?: string): Promise<string> {
  // Content first (AXI §8): show the Worker configured in this directory if
  // there is one, otherwise the account's Pages projects — never a usage manual.
  const deployments = config
    ? await listDeployments(config)
    : await listDeployments(undefined).catch(() => undefined);

  if (deployments) {
    const rows = toDeploymentRows([...deployments].reverse()).slice(
      0,
      HOME_ROW_LIMIT,
    );
    const suffix = configSuffix(config);
    return renderOutput([
      `worker: configured in ${configSource(config)} (${deployments.length} deployments)`,
      renderList("deployments", rows),
      renderHelp([
        `Run \`cloudflare-axi deployments${suffix}\` for the full deployment list`,
        `Run \`cloudflare-axi workers deploy --dry-run${suffix}\` to bundle-check it`,
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

  hints.push(
    "Run `cloudflare-axi --config <path>` to show a Worker's deployments from any directory",
  );
  hints.push("Run `cloudflare-axi whoami` to see the logged-in account");
  blocks.push(renderHelp(hints));
  return renderOutput(blocks);
}
