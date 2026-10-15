import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { takeFlag } from "./args.js";
import { AxiError } from "./errors.js";
import type { RunOptions } from "./wrangler.js";

/**
 * `--config <path>` for the directory-scoped commands (`deployments`,
 * `workers ...`, and the dashboard): point at a Worker's wrangler config
 * instead of relying on the shell's cwd, so an agent never has to `cd`.
 *
 * The path is resolved to absolute against the caller's cwd, then wrangler
 * runs as if started in the config's directory: the child process gets that
 * directory as its cwd and `--config <absolute path>`. wrangler already
 * resolves `main`, `assets` and `base_dir` relative to the config file, but a
 * custom `build.command`, `.env` files and the `.wrangler/` state dir follow
 * the process cwd, so `--config` alone would build or read state in the wrong
 * directory. A child cwd (not wrangler's own `--cwd`) works on every wrangler
 * 4.x.
 */

export const CONFIG_NAMES = [
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
];

/** Walk up from startDir like wrangler's find-up; return the first config found. */
export function findWranglerConfig(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Validate a `--config` value and return it as an absolute path. A missing
 * path, or a directory, is a VALIDATION_ERROR (exit 2) before any wrangler
 * call; a directory that holds a config names the file to pass instead.
 */
export function resolveConfigPath(config: string): string {
  const absolute = resolve(config);
  if (!existsSync(absolute)) {
    throw new AxiError(
      `--config ${config} does not exist`,
      "VALIDATION_ERROR",
      ["Pass the path to the Worker's wrangler.toml / wrangler.jsonc"],
    );
  }
  if (statSync(absolute).isDirectory()) {
    const inside = CONFIG_NAMES.map((n) => join(absolute, n)).find((p) =>
      existsSync(p),
    );
    throw new AxiError(
      `--config ${config} is a directory; pass the wrangler config file`,
      "VALIDATION_ERROR",
      [
        inside
          ? `Use \`--config ${shellQuote(inside)}\``
          : "Pass the path to the Worker's wrangler.toml / wrangler.jsonc",
      ],
    );
  }
  return absolute;
}

/** Take and validate `--config` from args (mutating it); absolute path or undefined. */
export function takeConfig(args: string[]): string | undefined {
  const config = takeFlag(args, "--config");
  return config === undefined ? undefined : resolveConfigPath(config);
}

/** wrangler argv for an (already resolved) config. */
export function configArgs(config: string | undefined): string[] {
  return config ? ["--config", config] : [];
}

/** Run wrangler from the config's directory, as if started there. */
export function configRunOptions(config: string | undefined): RunOptions {
  return config ? { cwd: dirname(config) } : {};
}

/**
 * Quote one shell word for a copy-pasteable hint: left bare when every char is
 * in a safe set, else single-quoted (embedded ' becomes '\''). A leading "~"
 * is quoted too, since a shell would expand it.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=-][A-Za-z0-9_./~:@%+=-]*$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * ` --config <path>` (shell-quoted) for next-step hints, so a suggested
 * command still works without `cd`.
 */
export function configSuffix(config: string | undefined): string {
  return config ? ` --config ${shellQuote(config)}` : "";
}

/**
 * ` --cwd <dir> --config <path>` for raw `wrangler` hints: the wrapper runs
 * wrangler from the config's directory (`.env`, `build.command`), so a
 * suggested raw command must too, or it reads the caller's directory instead.
 */
export function wranglerConfigSuffix(config: string | undefined): string {
  return config
    ? ` --cwd ${shellQuote(dirname(config))}${configSuffix(config)}`
    : "";
}

/** Where the Worker comes from, for output lines. */
export function configSource(config: string | undefined): string {
  return config ?? "this directory";
}

/**
 * When `--config` was given, a NOT_LINKED from wrangler means the config
 * itself names no Worker, not that the directory has none; say so.
 */
export async function withConfigContext<T>(
  config: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (config && error instanceof AxiError && error.code === "NOT_LINKED") {
      throw new AxiError(
        `No Worker is configured in ${config} (wrangler found no Worker name in it)`,
        "NOT_LINKED",
        [
          "Set `name` (and `main`) in that wrangler config",
          "Or pass `--config <path>` to a different Worker's wrangler config",
        ],
      );
    }
    throw error;
  }
}

/** Drop `//` and `/* *\/` comments and trailing commas from JSONC, leaving strings intact. */
function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const match = end.exec(text);
      const str = match ? match[0] : text.slice(i);
      out += str;
      i += str.length - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Top-level `account_id` of a wrangler config (TOML, JSON or JSONC), or
 * undefined when it sets none. wrangler gives this precedence over
 * CLOUDFLARE_ACCOUNT_ID, so REST calls that must hit the same account as a
 * wrangler run read it first. An unreadable config is a VALIDATION_ERROR.
 */
export function configAccountId(path: string): string | undefined {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".toml")) {
    for (const line of text.split("\n")) {
      if (/^\s*\[/.test(line)) return undefined;
      const match =
        /^\s*account_id\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
      if (match) return (match[1] ?? match[2]).trim() || undefined;
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    throw new AxiError(
      `Could not parse ${path} to read its account_id`,
      "VALIDATION_ERROR",
      ["Fix the wrangler config, or pass `--config <path>` to a valid one"],
    );
  }
  const account = (parsed as { account_id?: unknown } | null)?.account_id;
  return typeof account === "string" && account.trim()
    ? account.trim()
    : undefined;
}
