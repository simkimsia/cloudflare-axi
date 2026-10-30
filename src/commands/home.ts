import { configSource, configSuffix } from "../config.js";
import { AxiError } from "../errors.js";
import { relativeTime, renderHelp, renderList, renderOutput } from "../toon.js";
import { WranglerTimeoutError, wranglerJson } from "../wrangler.js";
import { listDeployments, toDeploymentRows } from "./deployments.js";
import { toPagesRows, type PagesProjectRow } from "./pages.js";
import { listWorkerScripts } from "./workers.js";

const HOME_ROW_LIMIT = 3;

/**
 * Keep the optional Workers overview responsive with a shorter per-request
 * budget than the REST default. Account lookup and scripts listing each get
 * this budget; a credential refresh is bounded by WRANGLER_READ_TIMEOUT_MS.
 */
export const HOME_WORKERS_TIMEOUT_MS = 10_000;

/**
 * Budget for each wrangler spawn on the dashboard (`deployments list`,
 * `pages project list`). Longer than the REST one: it includes wrangler's own
 * start-up, and it may page through the API.
 */
export const HOME_WRANGLER_TIMEOUT_MS = 20_000;

/**
 * `config` is the resolved `--config` path from `cloudflare-axi --config <path>`
 * (parsed in src/cli.ts). With it, the Worker section is required: a failure
 * is reported, not swapped for the Pages fallback.
 */
export async function homeCommand(config?: string): Promise<string> {
  // Content first (AXI §8): show the Worker configured in this directory if
  // there is one, otherwise the account's Pages projects — never a usage manual.
  const bounded = { timeoutMs: HOME_WRANGLER_TIMEOUT_MS };
  let deploymentsTimedOut = false;
  const deployments = config
    ? await listDeployments(config, bounded)
    : await listDeployments(undefined, bounded).catch((error: unknown) => {
        deploymentsTimedOut = error instanceof WranglerTimeoutError;
        return undefined;
      });

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
        "Run `cloudflare-axi workers list`, `cloudflare-axi pages` or `cloudflare-axi kv` for account-wide views",
      ]),
    ]);
  }

  const [projects, workers] = await Promise.all([
    wranglerJson<PagesProjectRow[]>(
      ["pages", "project", "list", "--json"],
      bounded,
    ).catch((error: unknown) => error),
    listWorkerScripts(undefined, {
      timeoutMs: HOME_WORKERS_TIMEOUT_MS,
    }).then(
      (r) => r.scripts,
      (error: unknown) => error,
    ),
  ]);

  // A timeout is not "no Worker here": say it is unknown, and how to retry.
  const blocks: string[] = [
    deploymentsTimedOut
      ? `worker: unknown (wrangler deployments list did not answer within ${HOME_WRANGLER_TIMEOUT_MS / 1000}s)`
      : "worker: none configured in this directory",
  ];
  const hints: string[] = [];
  if (deploymentsTimedOut) {
    hints.push(
      "Run `cloudflare-axi deployments` to retry this directory's Worker deployments",
    );
  }

  if (!Array.isArray(projects)) {
    // Same as the Workers block: a failed or timed-out listing is not "0".
    const code = projects instanceof AxiError ? projects.code : "UNKNOWN";
    blocks.push(`projects: could not list (${code})`);
    hints.push(
      "Run `cloudflare-axi pages` to see why the account's Pages projects could not be listed",
    );
  } else if (projects.length === 0) {
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

  if (!Array.isArray(workers)) {
    // Not swallowed as "0 Workers": that would read as an empty account.
    const code = workers instanceof AxiError ? workers.code : "UNKNOWN";
    blocks.push(`workers: could not list (${code})`);
    hints.push(
      "Run `cloudflare-axi workers list` to see why the account's Workers could not be listed",
    );
  } else if (workers.length === 0) {
    blocks.push("workers: 0 Workers in this account");
  } else {
    blocks.push(
      renderList(
        "workers",
        workers.slice(0, HOME_ROW_LIMIT).map((w) => ({
          name: w.id,
          modified: relativeTime(w.modified_on),
        })),
      ),
    );
    hints.push(
      `Run \`cloudflare-axi workers list\` for ${
        workers.length > HOME_ROW_LIMIT
          ? `all ${workers.length} Workers`
          : "each Worker"
      } with its workers.dev URL, crons and routes`,
    );
  }

  hints.push(
    "Run `cloudflare-axi --config <path>` to show a Worker's deployments from any directory",
  );
  hints.push("Run `cloudflare-axi whoami` to see the logged-in account");
  blocks.push(renderHelp(hints));
  return renderOutput(blocks);
}
