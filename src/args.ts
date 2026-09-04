import { AxiError } from "./errors.js";

/**
 * AXI §6: fail loud on unrecognized input. Commands that take no args or
 * flags call this so anything left in argv is rejected by name before any
 * wrangler or API call.
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

/**
 * Pull `--flag value` or `--flag=value` out of args (mutating it) and return
 * the value. A flag with no value, a blank value, or another flag where the
 * value should be is a VALIDATION_ERROR rather than a silent undefined.
 */
export function takeFlag(args: string[], flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const value = args[i + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("-")) {
        throw new AxiError(`${flag} requires a value`, "VALIDATION_ERROR");
      }
      args.splice(i, 2);
      return value;
    }
    if (arg.startsWith(equalsPrefix)) {
      const value = arg.slice(equalsPrefix.length);
      if (value.trim() === "") {
        throw new AxiError(`${flag} requires a value`, "VALIDATION_ERROR");
      }
      args.splice(i, 1);
      return value;
    }
  }
  return undefined;
}

/** Pull a boolean `--flag` (or `--flag=true|false`) out of args (mutating it). */
export function takeBoolFlag(args: string[], flag: string): boolean {
  const equalsPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      args.splice(i, 1);
      return true;
    }
    if (arg.startsWith(equalsPrefix)) {
      const value = arg.slice(equalsPrefix.length).toLowerCase();
      if (value !== "true" && value !== "false") {
        throw new AxiError(
          `${flag} accepts true or false, got ${value}`,
          "VALIDATION_ERROR",
        );
      }
      args.splice(i, 1);
      return value === "true";
    }
  }
  return false;
}

/** Pull the first positional (non-flag) token out of args (mutating it). */
export function takePositional(args: string[]): string | undefined {
  const index = args.findIndex((a) => !a.startsWith("-"));
  if (index === -1) return undefined;
  return args.splice(index, 1)[0];
}

/**
 * Call after a command has taken every flag and positional it understands.
 * Whatever is left is unknown; reject it by name with exit code 2 and a
 * one-turn self-correction hint (usage + --help), per AXI §6.
 */
export function rejectExtraArgs(
  command: string,
  args: string[],
  usage: string,
): void {
  if (args.length === 0) return;
  const flags = args.filter((a) => a.startsWith("-"));
  const positionals = args.filter((a) => !a.startsWith("-"));
  const parts: string[] = [];
  if (flags.length > 0) {
    parts.push(
      `unknown flag${flags.length > 1 ? "s" : ""} ${flags.join(", ")}`,
    );
  }
  if (positionals.length > 0) {
    parts.push(
      `unexpected argument${positionals.length > 1 ? "s" : ""} ${positionals.join(", ")}`,
    );
  }
  throw new AxiError(
    `${parts.join("; ")} for \`${command}\``,
    "VALIDATION_ERROR",
    [usage, `cloudflare-axi ${command.split(" ")[0]} --help`],
  );
}
