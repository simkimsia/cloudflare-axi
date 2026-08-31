import { AxiError } from "./errors.js";

/**
 * AXI §6: fail loud on unrecognized input. Every v0 command takes no args or
 * flags, so anything left in argv is rejected by name before any wrangler call.
 */
export function assertNoArgs(command: string, args: string[]): void {
  if (args.length === 0) return;
  const kind = args[0].startsWith("-") ? "flag" : "argument";
  throw new AxiError(
    `unknown ${kind} ${args[0]} for \`${command}\``,
    "VALIDATION_ERROR",
    [
      `\`cloudflare-axi ${command}\` takes no arguments (--help always allowed)`,
    ],
  );
}
