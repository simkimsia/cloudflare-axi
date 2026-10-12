import { encode } from "@toon-format/toon";
import { AxiError as SdkAxiError, runAxiCli } from "axi-sdk-js";
import { takeConfig } from "./config.js";
import { AxiError, exitCodeForError, UNKNOWN_SUGGESTION } from "./errors.js";
import { homeCommand } from "./commands/home.js";
import {
  deploymentsCommand,
  DEPLOYMENTS_HELP,
} from "./commands/deployments.js";
import { emailCommand, EMAIL_HELP } from "./commands/email.js";
import { kvCommand, KV_HELP } from "./commands/kv.js";
import { pagesCommand, PAGES_HELP } from "./commands/pages.js";
import { whoamiCommand, WHOAMI_HELP } from "./commands/whoami.js";
import { workersCommand, WORKERS_HELP } from "./commands/workers.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Agent ergonomic wrapper around the Cloudflare CLI (wrangler). Prefer this over `wrangler` for Cloudflare operations.";

export const TOP_HELP = `usage: cloudflare-axi [--config <path>] [command] [flags]
commands[7]:
  (none)=dashboard, deployments, workers, pages, kv, whoami, email
flags[3]:
  --help, -v/-V/--version, --config <path> (the Worker's wrangler config, for the dashboard, deployments and workers; works from any directory)
examples:
  cloudflare-axi
  cloudflare-axi --config ~/Projects/my-worker/wrangler.toml
  cloudflare-axi deployments --config ~/Projects/my-worker/wrangler.toml
  cloudflare-axi pages
  cloudflare-axi pages deploy ./dist --project my-site
  cloudflare-axi deployments
  cloudflare-axi workers deploy --dry-run
  cloudflare-axi email --zone example.com
`;

const COMMAND_HELP: Record<string, string> = {
  deployments: DEPLOYMENTS_HELP,
  workers: WORKERS_HELP,
  pages: PAGES_HELP,
  kv: KV_HELP,
  whoami: WHOAMI_HELP,
  email: EMAIL_HELP,
};

function formatError(error: unknown): { output: string; exitCode: number } {
  const axiError =
    error instanceof AxiError || error instanceof SdkAxiError
      ? error
      : new AxiError(
          error instanceof Error ? error.message : String(error),
          "UNKNOWN",
          [UNKNOWN_SUGGESTION],
        );
  return {
    output: `${encode({
      error: axiError.message,
      code: axiError.code,
      ...(axiError.suggestions.length > 0
        ? { help: axiError.suggestions }
        : {}),
    })}\n`,
    exitCode: exitCodeForError(axiError),
  };
}

/**
 * `--config <path>` is global: it may lead the argv (`cloudflare-axi --config
 * x deployments`), where the SDK would reject any leading flag. A leading one
 * is lifted out here. With no command left it feeds the dashboard; otherwise
 * it moves to the end of the argv, where the command's own parser takes it
 * (directory-scoped commands) or rejects it by name (account-scoped ones such
 * as `pages` and `kv`).
 */
export function liftLeadingConfig(argv: string[]): {
  argv: string[];
  homeConfig?: string;
} {
  if (argv[0] !== "--config" && !argv[0]?.startsWith("--config=")) {
    return { argv };
  }
  const width = argv[0] === "--config" ? 2 : 1;
  const flag = argv.slice(0, width);
  const rest = argv.slice(width);
  if (rest.length === 0) {
    // Validate here (VALIDATION_ERROR on a missing value or path).
    return { argv: [], homeConfig: takeConfig(flag) };
  }
  if (rest.length === 1 && rest[0] === "--help") return { argv: rest };
  // Append (not insert after the command) so subcommands stay first:
  // `--config x workers deploy` -> `workers deploy --config x`.
  return { argv: [...rest, ...flag] };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  stdout: { write: (chunk: string) => unknown } = process.stdout,
): Promise<void> {
  let lifted: ReturnType<typeof liftLeadingConfig>;
  try {
    lifted = liftLeadingConfig(argv);
  } catch (error) {
    const formatted = formatError(error);
    stdout.write(formatted.output);
    process.exitCode = formatted.exitCode;
    return;
  }
  const { homeConfig } = lifted;
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    argv: lifted.argv,
    stdout,
    home: () => homeCommand(homeConfig),
    commands: {
      deployments: deploymentsCommand,
      workers: workersCommand,
      pages: pagesCommand,
      kv: kvCommand,
      whoami: whoamiCommand,
      email: emailCommand,
    },
    getCommandHelp: (command) => COMMAND_HELP[command],
    // The SDK's default formatter only recognizes its own AxiError class, so
    // route this package's AxiError through an equivalent hook (gh-axi pattern).
    // The SDK's own AxiError (e.g. unknown flags on built-ins like `update`)
    // keeps its code and help; only foreign throws become UNKNOWN.
    formatError,
  });
}
