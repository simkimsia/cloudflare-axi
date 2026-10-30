import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { readNearestPackageJson, runUpdate } from "axi-sdk-js";
import type { RunUpdateOptions } from "axi-sdk-js";
import { rejectExtraArgs, takeBoolFlag } from "../args.js";
import { shellQuote } from "../config.js";
import { encode, renderHelp, renderOutput } from "../toon.js";
import { VERSION } from "../version.js";

export const UPDATE_HELP = `usage: cloudflare-axi update [--check]
Upgrades cloudflare-axi to the latest published npm version. A copy linked
from a git checkout (pnpm link / pnpm add -g link:) is never npm-installed
over: update names the checkout and branch and the git pull + build to run.
Warns when more than one cloudflare-axi is on PATH and says which one runs.
flags[1]:
  --check (alias --dry-run): report current vs latest without installing
examples:
  cloudflare-axi update --check
  cloudflare-axi update
`;

const BIN = "cloudflare-axi";
const USAGE = "usage: cloudflare-axi update [--check]";

type AxiRenderable = Awaited<ReturnType<typeof runUpdate>>;

/** Filesystem and process seams; tests replace them. */
export interface UpdateDeps {
  /** The running entrypoint, normally `process.argv[1]`. */
  invokedAs: string | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  existsSync: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf-8") => string;
  realpath: (path: string) => string;
  runUpdate: (options: RunUpdateOptions) => Promise<AxiRenderable>;
  stdout: { write: (chunk: string) => unknown };
}

const defaultDeps = (): UpdateDeps => ({
  invokedAs: process.argv[1],
  env: process.env,
  platform: process.platform,
  existsSync,
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  realpath: (path) => realpathSync(path),
  runUpdate,
  stdout: process.stdout,
});

/** A git checkout the running copy is linked from. */
export interface LinkedCheckout {
  path: string;
  /** Branch name, or `detached <sha>`, or `unknown`. */
  branch: string;
}

/** One `cloudflare-axi` found on PATH, in PATH order. */
export interface PathCopy {
  /** The executable as found on PATH. */
  path: string;
  /** The JS entry it runs (symlinks and pnpm/npm shell shims followed). */
  target: string;
  version: string;
}

function safeRealpath(deps: UpdateDeps, path: string): string {
  try {
    return deps.realpath(path);
  } catch {
    return path;
  }
}

/**
 * The running copy is a linked checkout when its package root holds `.git`
 * and is not inside a node_modules tree (an npm/pnpm install never ships
 * `.git`). That is what `pnpm link --global` and `pnpm add -g link:<dir>`
 * leave behind, and the SDK's install detection reports it as unknown.
 */
export function detectLinkedCheckout(
  entry: string,
  deps: UpdateDeps,
): LinkedCheckout | undefined {
  const { packageJsonPath } = readNearestPackageJson(entry, deps);
  if (!packageJsonPath) return undefined;
  const root = dirname(packageJsonPath);
  if (root.replaceAll("\\", "/").split("/").includes("node_modules")) {
    return undefined;
  }
  const dotGit = join(root, ".git");
  if (!deps.existsSync(dotGit)) return undefined;
  return { path: root, branch: readBranch(dotGit, deps) };
}

function readBranch(dotGit: string, deps: UpdateDeps): string {
  try {
    let gitDir = dotGit;
    if (!deps.isDirectory(dotGit)) {
      // A worktree or submodule: `.git` is a file with `gitdir: <path>`.
      const pointer = /^gitdir:\s*(.+)$/m.exec(
        deps.readFileSync(dotGit, "utf-8"),
      );
      if (!pointer) return "unknown";
      gitDir = resolve(dirname(dotGit), pointer[1].trim());
    }
    const head = deps.readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    return /^[0-9a-f]{7,}$/.test(head)
      ? `detached ${head.slice(0, 7)}`
      : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Follow a PATH entry to the JS file it runs. npm links bins as symlinks;
 * pnpm writes a shell shim whose `exec node "<path>"` line names the target,
 * relative to `$basedir` (the shim's directory) or absolute.
 */
export function resolveBinTarget(path: string, deps: UpdateDeps): string {
  const real = safeRealpath(deps, path);
  let text: string;
  try {
    text = deps.readFileSync(real, "utf-8");
  } catch {
    return real;
  }
  if (!text.startsWith("#!/bin/sh")) return real;
  const exec = /exec\s+\S*node"?\s+"([^"]+\.[cm]?js)"/.exec(text);
  if (!exec) return real;
  const target = exec[1].replace(/^\$basedir/, dirname(real));
  return isAbsolute(target) ? safeRealpath(deps, target) : real;
}

/** Every distinct `cloudflare-axi` on PATH, first (the one that runs) first. */
export function findPathCopies(deps: UpdateDeps): PathCopy[] {
  const names =
    deps.platform === "win32" ? [BIN, `${BIN}.cmd`, `${BIN}.ps1`] : [BIN];
  const pathVar = deps.env.PATH ?? deps.env.Path ?? "";
  const seen = new Set<string>();
  const copies: PathCopy[] = [];
  for (const dir of pathVar.split(
    deps.platform === "win32" ? ";" : delimiter,
  )) {
    if (!dir) continue;
    const found = names
      .map((name) => join(dir, name))
      .find((candidate) => deps.existsSync(candidate));
    if (!found) continue;
    const target = resolveBinTarget(found, deps);
    // The same directory listed twice, or two shims for one install.
    if (seen.has(found) || seen.has(target)) continue;
    seen.add(found);
    seen.add(target);
    copies.push({
      path: found,
      target,
      version: readNearestPackageJson(target, deps).version ?? "unknown",
    });
  }
  return copies;
}

function rebuildCommand(checkout: string): string {
  const dir = shellQuote(checkout);
  return `git -C ${dir} pull --ff-only && pnpm -C ${dir} install && pnpm -C ${dir} run build`;
}

interface CheckResult {
  package: string;
  current: string;
  latest: string;
  available: boolean;
}

function asCheckResult(output: AxiRenderable): CheckResult | undefined {
  if (typeof output === "string") return undefined;
  const update = output.update as Partial<CheckResult> | undefined;
  return update && typeof update.latest === "string"
    ? (update as CheckResult)
    : undefined;
}

export async function updateCommand(
  args: string[],
  deps: UpdateDeps = defaultDeps(),
): Promise<string> {
  const rest = [...args];
  const check =
    takeBoolFlag(rest, "--check") || takeBoolFlag(rest, "--dry-run");
  rejectExtraArgs("update", rest, USAGE);

  const entry = deps.invokedAs ? safeRealpath(deps, deps.invokedAs) : undefined;
  const linked = entry ? detectLinkedCheckout(entry, deps) : undefined;
  const copies = findPathCopies(deps);
  const shadowed =
    copies.length > 1 && entry !== undefined && copies[0].target !== entry;
  const sdkOptions = {
    stdout: deps.stdout,
    version: VERSION,
    invokedAs: deps.invokedAs,
    env: deps.env,
    platform: deps.platform,
  };

  const help: string[] = [];
  let output: Record<string, unknown>;

  if (linked) {
    // Never npm-install over a linked checkout: it would install a second
    // copy that the link keeps shadowing (issue #56).
    const result = asCheckResult(
      await deps.runUpdate({ ...sdkOptions, args: ["--check"] }),
    );
    const run = rebuildCommand(linked.path);
    output = {
      update: {
        ...(result ?? { current: VERSION }),
        install: "linked checkout",
        checkout: linked.path,
        branch: linked.branch,
        ...(result?.available && !shadowed ? { action: "manual", run } : {}),
      },
    };
    if (result?.available && !shadowed) {
      help.push(
        `This copy is linked to ${linked.path}; update that checkout (\`${run}\`) instead of \`npm install -g\`, which would not change the copy that runs`,
      );
    }
  } else {
    const sdkOutput = await deps.runUpdate({
      ...sdkOptions,
      args: check ? ["--check"] : [],
    });
    if (typeof sdkOutput === "string") {
      output = { update: sdkOutput };
    } else {
      const { help: sdkHelp, ...restOutput } = sdkOutput;
      output = restOutput;
      if (!shadowed) {
        if (Array.isArray(sdkHelp)) help.push(...(sdkHelp as string[]));
      } else if (restOutput.update && typeof restOutput.update === "object") {
        const update = { ...(restOutput.update as Record<string, unknown>) };
        delete update.action;
        delete update.run;
        output.update = update;
      }
    }
  }

  if (copies.length > 1) {
    output.path = copies.map((copy, index) => ({
      bin: copy.path,
      version: copy.version,
      runs: index === 0 ? "yes" : "no (shadowed)",
      this: entry !== undefined && copy.target === entry ? "yes" : "no",
    }));
    const winner = copies[0];
    help.push(
      `${copies.length} copies of ${BIN} are on PATH; \`${BIN}\` runs ${winner.path} (${winner.version}). Remove the ones you do not use, or call a copy by its full path`,
    );
    if (shadowed) {
      help.push(
        `This copy is not the one \`${BIN}\` runs, so updating it does not change what \`${BIN}\` runs`,
      );
      const winnerLinked = detectLinkedCheckout(winner.target, deps);
      if (winnerLinked) {
        help.push(
          `${winner.path} is linked to ${winnerLinked.path} (branch ${winnerLinked.branch}); update it with \`${rebuildCommand(winnerLinked.path)}\``,
        );
      }
    }
  }

  return renderOutput([encode(output), renderHelp(help)]);
}
