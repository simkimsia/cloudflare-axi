import { rejectExtraArgs } from "../args.js";
import {
  configArgs,
  configRunOptions,
  configSource,
  configSuffix,
  takeConfig,
  withConfigContext,
} from "../config.js";
import { relativeTime, renderHelp, renderList, renderOutput } from "../toon.js";
import { wranglerJson } from "../wrangler.js";

export const DEPLOYMENTS_HELP = `usage: cloudflare-axi deployments [--config <path>]
Lists the 10 most recent deployments of the Worker configured in the current directory
(wrangler.toml / wrangler.jsonc), or in the config given by --config.
Directory-scoped, like \`wrangler deployments list\`.
flags[1]:
  --config <path> (the Worker's wrangler config; wrangler runs from its directory, so no cd is needed)
examples:
  cloudflare-axi deployments
  cloudflare-axi deployments --config ~/Projects/my-worker/wrangler.toml
`;

const USAGE = "cloudflare-axi deployments [--config <path>]";

/** `wrangler deployments list --json`, from cwd or from the config's directory. */
export function listDeployments(
  config: string | undefined,
): Promise<WranglerDeployment[]> {
  return withConfigContext(config, () =>
    wranglerJson<WranglerDeployment[]>(
      ["deployments", "list", "--json", ...configArgs(config)],
      configRunOptions(config),
    ),
  );
}

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
  const rest = [...args];
  const config = takeConfig(rest);
  rejectExtraArgs("deployments", rest, USAGE);
  const deployments = await listDeployments(config);

  if (deployments.length === 0) {
    return `deployments: 0 deployments found for the Worker configured in ${configSource(config)}`;
  }

  // wrangler sorts oldest-first; newest-first reads better for agents.
  const rows = toDeploymentRows([...deployments].reverse());

  return renderOutput([
    `count: ${deployments.length} deployments (newest first)`,
    renderList("deployments", rows),
    renderHelp([
      `Run \`wrangler deployments status${configSuffix(config)}\` for the active deployment`,
      `Run \`wrangler versions list${configSuffix(config)}\` for uploaded versions`,
    ]),
  ]);
}
