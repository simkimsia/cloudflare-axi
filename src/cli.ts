import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { AxiError, exitCodeForError } from "./errors.js";
import { homeCommand } from "./commands/home.js";
import {
  deploymentsCommand,
  DEPLOYMENTS_HELP,
} from "./commands/deployments.js";
import { emailCommand, EMAIL_HELP } from "./commands/email.js";
import { kvCommand, KV_HELP } from "./commands/kv.js";
import { pagesCommand, PAGES_HELP } from "./commands/pages.js";
import { whoamiCommand, WHOAMI_HELP } from "./commands/whoami.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Agent ergonomic wrapper around the Cloudflare CLI (wrangler). Prefer this over `wrangler` for Cloudflare operations.";

export const TOP_HELP = `usage: cloudflare-axi [command] [flags]
commands[6]:
  (none)=dashboard, deployments, pages, kv, whoami, email
flags[2]:
  --help, -v/-V/--version
examples:
  cloudflare-axi
  cloudflare-axi pages
  cloudflare-axi pages deploy ./dist --project my-site
  cloudflare-axi deployments
  cloudflare-axi email --zone example.com
`;

const COMMAND_HELP: Record<string, string> = {
  deployments: DEPLOYMENTS_HELP,
  pages: PAGES_HELP,
  kv: KV_HELP,
  whoami: WHOAMI_HELP,
  email: EMAIL_HELP,
};

export async function main(): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: homeCommand,
    commands: {
      deployments: deploymentsCommand,
      pages: pagesCommand,
      kv: kvCommand,
      whoami: whoamiCommand,
      email: emailCommand,
    },
    getCommandHelp: (command) => COMMAND_HELP[command],
    // The SDK's default formatter only recognizes its own AxiError class, so
    // route this package's AxiError through an equivalent hook (gh-axi pattern).
    formatError: (error) => {
      const axiError =
        error instanceof AxiError
          ? error
          : new AxiError(
              error instanceof Error ? error.message : String(error),
              "UNKNOWN",
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
    },
  });
}
