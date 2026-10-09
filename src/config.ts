import { existsSync, statSync } from "node:fs";
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
          ? `Use \`--config ${inside}\``
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

/** ` --config <path>` for next-step hints, so a suggested command still works without `cd`. */
export function configSuffix(config: string | undefined): string {
  return config ? ` --config ${config}` : "";
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
