import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assertNoArgs,
  rejectExtraArgs,
  takeBoolFlag,
  takeFlag,
  takePositional,
} from "../args.js";
import { AxiError, stripAnsi } from "../errors.js";
import { encode, renderHelp, renderList, renderOutput } from "../toon.js";
import {
  wranglerExec,
  wranglerExecWithOutput,
  wranglerJson,
  type WranglerOutputEntry,
} from "../wrangler.js";

export const WORKERS_HELP = `usage: cloudflare-axi workers [subcommand] [flags]
Cloudflare Workers: deploy the Worker in cwd and manage its secrets.
subcommands[2]:
  deploy, secret put <KEY>|list
flags{deploy}:
  --name <worker> (required unless --dry-run; must match the Worker the config deploys; never forwarded), --config <path>, --outdir <dir>, --dry-run
flags{secret}:
  --name <worker> (required for put), --config <path>
notes:
  deploy is directory-scoped like \`wrangler deploy\`: it deploys the wrangler config in cwd (or --config)
  a real deploy runs \`wrangler deploy --dry-run\` first and refuses when --name differs from the Worker name wrangler resolves
  deploy --dry-run bundles locally and uploads nothing
  secret put reads the value from stdin only; it never takes it as an argument and never prints it
  secret put refuses a Worker that does not exist (wrangler would silently create a draft Worker)
  secret list shows names and types only; Cloudflare never returns secret values
  recent deployments: \`cloudflare-axi deployments\`
  not wrapped yet: tail, secret delete, secret bulk, --env; use \`wrangler\` for those
examples:
  cloudflare-axi workers deploy --dry-run
  cloudflare-axi workers deploy --name family-haze-bot
  cloudflare-axi workers secret list --name family-haze-bot
  printf %s "$TELEGRAM_BOT_TOKEN" | cloudflare-axi workers secret put TELEGRAM_BOT_TOKEN --name family-haze-bot
`;

const USAGE = {
  deploy:
    "cloudflare-axi workers deploy --name <worker> [--config <path>] [--outdir <dir>] [--dry-run]",
  put: 'printf %s "$VALUE" | cloudflare-axi workers secret put <KEY> --name <worker> [--config <path>]',
  list: "cloudflare-axi workers secret list [--name <worker>] [--config <path>]",
};

const NOT_LINKED_SUGGESTIONS = [
  "Run from a directory with a wrangler config (wrangler.toml / wrangler.jsonc)",
  "Or pass `--config <path>` to the Worker's wrangler config",
];

// ---- pure helpers (exported for tests) ----

/**
 * Bindings from `wrangler deploy` stdout (wrangler does not put them in the
 * ND-JSON output file). Rows sit between "Your Worker has access to the
 * following bindings:" and the next blank line, after a "Binding Resource"
 * header. The parenthesized detail holds var values and ids, so it is dropped.
 * ANSI is stripped first: with FORCE_COLOR wrangler colors header and rows.
 */
export function parseBindings(
  stdout: string,
): { name: string; type: string }[] {
  const lines = stripAnsi(stdout).split("\n");
  const start = lines.findIndex((l) =>
    /has access to the following bindings:/.test(l),
  );
  if (start === -1) return [];
  const rows: { name: string; type: string }[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trimEnd();
    if (line.trim() === "") break;
    if (/^Binding\s{2,}Resource/.test(line.trim())) continue;
    const name = /^\s*(?:env\.)?([^\s(]+)/.exec(line)?.[1];
    const columns = line.trim().split(/\s{2,}/);
    if (!name || columns.length < 2) continue;
    rows.push({ name, type: columns[columns.length - 1] });
  }
  return rows;
}

/** "Total Upload: 181.11 KiB / gzip: 164.93 KiB" -> "181.11 KiB (gzip 164.93 KiB)". */
export function parseUploadSize(stdout: string): string | undefined {
  const m = /Total Upload:\s*(.+?)\s*\/\s*gzip:\s*(.+?)\s*$/m.exec(
    stripAnsi(stdout),
  );
  return m ? `${m[1]} (gzip ${m[2]})` : undefined;
}

/**
 * Split the `targets` string[] of a `deploy` output entry: workers.dev URLs,
 * routes and custom domains -> urls; "schedule: <cron>" -> crons; anything
 * else ("Producer for <queue>", "workflow: <name>", and the
 * "...and <n> more routes" marker wrangler appends past 10 routes) -> other.
 */
export function splitTargets(targets: unknown): {
  urls: string[];
  crons: string[];
  other: string[];
} {
  const out = {
    urls: [] as string[],
    crons: [] as string[],
    other: [] as string[],
  };
  if (!Array.isArray(targets)) return out;
  for (const t of targets) {
    if (typeof t !== "string") continue;
    if (t.startsWith("schedule: "))
      out.crons.push(t.slice("schedule: ".length));
    else if (/^\.\.\.and \d+ more routes?$/.test(t)) out.other.push(t);
    else if (t.startsWith("https://") || t.includes("/") || t.includes("."))
      out.urls.push(t);
    else out.other.push(t);
  }
  return out;
}

const CONFIG_NAMES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];

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

export interface WranglerSecret {
  name: string;
  type: string;
}

export function toSecretRows(
  secrets: WranglerSecret[],
): Record<string, unknown>[] {
  return secrets.map((s) => ({ name: s.name, type: s.type }));
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

/** " --config <quoted path>" when the user passed --config, else "". */
function configFlag(config: string | undefined): string {
  return config === undefined ? "" : ` --config ${shellQuote(config)}`;
}

/**
 * `deployments` has no --config (it is cwd-scoped like `wrangler deployments
 * list`), so with --config point at the config's directory instead.
 */
function deploymentsHint(config: string | undefined, purpose: string): string {
  return config === undefined
    ? `Run \`cloudflare-axi deployments\` ${purpose}`
    : `Run \`cloudflare-axi deployments\` from ${shellQuote(dirname(resolve(config)))} (the config's directory) ${purpose}`;
}

/**
 * Carry the user's --config into every `cloudflare-axi workers ...` command
 * an error suggests (mapped wrangler errors in errors.ts cannot know it), so
 * the follow-up targets the same Worker from any cwd.
 */
export function carryConfig(
  error: unknown,
  config: string | undefined,
): unknown {
  if (config === undefined || !(error instanceof AxiError)) return error;
  return new AxiError(
    error.message,
    error.code,
    error.suggestions.map((s) =>
      s.replace(/`(cloudflare-axi workers [^`]*)`/g, (whole, cmd: string) =>
        /(^|\s)--config(\s|=|$)/.test(cmd)
          ? whole
          : `\`${cmd}${configFlag(config)}\``,
      ),
    ),
  );
}

function lastDeployEntry(
  entries: WranglerOutputEntry[],
): WranglerOutputEntry | undefined {
  return entries.filter((e) => e.type === "deploy").pop();
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Testable seam for reading the secret value. */
export const stdinSource = {
  isTTY: (): boolean => process.stdin.isTTY === true,
  read: async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  },
};

// ---- deploy ----

function assertConfig(config: string | undefined): void {
  if (config !== undefined) {
    if (!existsSync(resolve(config))) {
      throw new AxiError(`${config} does not exist`, "VALIDATION_ERROR", [
        "Pass the path to the Worker's wrangler.toml / wrangler.jsonc",
      ]);
    }
    return;
  }
  if (!findWranglerConfig(process.cwd())) {
    throw new AxiError(
      "No Worker is configured in this directory",
      "NOT_LINKED",
      NOT_LINKED_SUGGESTIONS,
    );
  }
}

async function deploy(args: string[]): Promise<string> {
  const name = takeFlag(args, "--name");
  const config = takeFlag(args, "--config");
  const outdir = takeFlag(args, "--outdir");
  const dryRun = takeBoolFlag(args, "--dry-run");
  rejectExtraArgs("workers deploy", args, USAGE.deploy);

  assertConfig(config);
  try {
    return await runDeploy(name, config, outdir, dryRun);
  } catch (error) {
    throw carryConfig(error, config);
  }
}

async function runDeploy(
  name: string | undefined,
  config: string | undefined,
  outdir: string | undefined,
  dryRun: boolean,
): Promise<string> {
  const cfg = configFlag(config);
  if (!dryRun && !name) {
    // VISION.md safety: a write names its target in full, never inferred.
    throw new AxiError(
      "--name is required for a real deploy",
      "VALIDATION_ERROR",
      [
        USAGE.deploy,
        `Run \`cloudflare-axi workers deploy --dry-run${cfg}\` to see the Worker name this config deploys`,
      ],
    );
  }

  const configArgs = config ? ["--config", config] : [];
  const outdirArgs = outdir ? ["--outdir", outdir] : [];

  // Read-only pass: bundle locally and learn the Worker name wrangler
  // resolves from the config. Nothing is uploaded.
  const check = await wranglerExecWithOutput([
    "deploy",
    "--dry-run",
    ...configArgs,
    ...(dryRun ? outdirArgs : []),
  ]);
  const resolved = str(lastDeployEntry(check.entries)?.worker_name);
  if (name && !resolved) {
    throw new AxiError(
      "wrangler reported no Worker name on the --dry-run, so --name cannot be checked",
      "UNKNOWN",
      [
        `Rerun \`wrangler deploy --dry-run${cfg}\` to see its full output, then report the gap at https://github.com/simkimsia/cloudflare-axi/issues`,
      ],
    );
  }
  if (name && resolved && name !== resolved) {
    throw new AxiError(
      `--name ${name} does not match the Worker this config deploys (${resolved})`,
      "VALIDATION_ERROR",
      [
        `Run \`cloudflare-axi workers deploy --name ${resolved}${cfg}\` to deploy it, or fix \`name\` in the wrangler config`,
      ],
    );
  }

  const bindings = parseBindings(check.stdout);
  if (dryRun) {
    return renderOutput([
      encode({
        worker: resolved ?? "unknown",
        dry_run: "bundled locally; nothing uploaded",
        upload: parseUploadSize(check.stdout) ?? "unknown",
        ...(outdir ? { outdir } : {}),
      }),
      bindings.length > 0 ? renderList("bindings", bindings) : "bindings: none",
      renderHelp([
        `Run \`cloudflare-axi workers deploy --name ${resolved ?? "<worker>"}${cfg}\` to upload and deploy it`,
      ]),
    ]);
  }

  // --name is deliberately NOT forwarded: wrangler would deploy under that
  // name even if it differs from the config, creating a new Worker on a typo.
  // The dry-run above already proved it matches.
  const worker = name as string;
  const started = Date.now();
  const result = await wranglerExecWithOutput([
    "deploy",
    ...configArgs,
    ...outdirArgs,
  ]);
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const entry = lastDeployEntry(result.entries);
  const version =
    str(entry?.version_id) ??
    /Current Version ID:\s*(\S+)/.exec(stripAnsi(result.stdout))?.[1];
  if (!version) {
    throw new AxiError(
      `wrangler reported no version id: ${result.stdout.trim().split("\n").pop() ?? ""}`,
      "UNKNOWN",
      [deploymentsHint(config, "to check whether it deployed")],
    );
  }
  // Without wrangler's deploy entry (or its targets) we cannot tell "no
  // routes" from "not reported": say unknown, and only say none when the
  // entry confirms an empty list.
  const targetsKnown = Array.isArray(entry?.targets);
  const targets = splitTargets(entry?.targets);
  const unknownTargets = "unknown (wrangler reported no deploy details)";
  const deployedBindings = parseBindings(result.stdout);
  const shownBindings =
    deployedBindings.length > 0 ? deployedBindings : bindings;

  return renderOutput([
    encode({
      worker: str(entry?.worker_name) ?? worker,
      version,
      urls: !targetsKnown
        ? unknownTargets
        : targets.urls.length > 0
          ? targets.urls
          : "none (workers_dev off and no routes or custom domains)",
      crons: !targetsKnown
        ? unknownTargets
        : targets.crons.length > 0
          ? targets.crons
          : "none",
      ...(targets.other.length > 0 ? { other: targets.other } : {}),
      upload:
        parseUploadSize(result.stdout) ??
        parseUploadSize(check.stdout) ??
        "unknown",
      elapsed,
    }),
    shownBindings.length > 0
      ? renderList("bindings", shownBindings)
      : "bindings: none",
    renderHelp([
      ...(targetsKnown
        ? []
        : [
            "urls and crons are unknown: wrangler wrote no deploy details to its output file; check the Worker's triggers in the Cloudflare dashboard",
          ]),
      deploymentsHint(
        config,
        targetsKnown
          ? "for the deployment history"
          : "to confirm this version is live",
      ),
      `Run \`cloudflare-axi workers secret list --name ${worker}${cfg}\` to check its secrets`,
    ]),
  ]);
}

// ---- secret list ----

async function listSecrets(
  name: string | undefined,
  config: string | undefined,
): Promise<WranglerSecret[]> {
  return wranglerJson<WranglerSecret[]>([
    "secret",
    "list",
    "--format",
    "json",
    ...(name ? ["--name", name] : []),
    ...(config ? ["--config", config] : []),
  ]);
}

async function secretList(args: string[]): Promise<string> {
  const name = takeFlag(args, "--name");
  const config = takeFlag(args, "--config");
  rejectExtraArgs("workers secret list", args, USAGE.list);

  let secrets: WranglerSecret[];
  try {
    secrets = await listSecrets(name, config);
  } catch (error) {
    throw carryConfig(error, config);
  }
  const cfg = configFlag(config);
  const worker = name ?? "<worker>";
  // wrangler's secret list JSON does not name the Worker it resolved, so
  // without --name point at a command that shows it.
  const findName = name
    ? []
    : [
        `Run \`cloudflare-axi workers deploy --dry-run${cfg}\` to see the Worker name this config deploys`,
      ];
  if (secrets.length === 0) {
    return renderOutput([
      `secrets: 0 secrets on ${name ?? "the Worker configured in this directory"}`,
      renderHelp([
        ...findName,
        `Run \`printf %s "$VALUE" | cloudflare-axi workers secret put <KEY> --name ${worker}${cfg}\` to add one`,
      ]),
    ]);
  }
  return renderOutput([
    `count: ${secrets.length} secrets${name ? ` on ${name}` : ""}`,
    renderList("secrets", toSecretRows(secrets)),
    renderHelp([
      "Values are write-only; Cloudflare never returns them",
      ...findName,
      `Run \`printf %s "$VALUE" | cloudflare-axi workers secret put <KEY> --name ${worker}${cfg}\` to add or rotate one`,
    ]),
  ]);
}

// ---- secret put ----

/**
 * Replace the secret value in an error string (defense in depth; wrangler is
 * not known to echo it). Values of 8+ chars are replaced wherever they appear;
 * shorter ones only as a whole token, so a value like "x" cannot mangle
 * unrelated words in the message.
 */
export function redactValue(text: string, value: string): string {
  let out = text;
  for (const v of new Set([value, value.trimEnd(), value.trim()])) {
    if (!v) continue;
    if (v.length >= 8) {
      out = out.split(v).join("<redacted>");
    } else {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g"),
        "<redacted>",
      );
    }
  }
  return out;
}

const KNOWN_PUT_FLAGS = new Set(["--name", "--config", "--env", "--help"]);

async function secretPut(args: string[]): Promise<string> {
  const name = takeFlag(args, "--name");
  const config = takeFlag(args, "--config");
  const key = takePositional(args);
  if (args.length > 0) {
    // Never echo leftovers: a stray token is most likely the secret value,
    // and a value can start with "-". Only exact known flag names are named.
    const flags = args
      .map((a) => a.split("=")[0])
      .filter((a) => KNOWN_PUT_FLAGS.has(a));
    throw new AxiError(
      `secret put takes the value on stdin only; unexpected input was not echoed${
        flags.length > 0 ? ` (flags: ${[...new Set(flags)].join(", ")})` : ""
      }`,
      "VALIDATION_ERROR",
      [USAGE.put],
    );
  }
  if (!key) {
    throw new AxiError("secret name <KEY> is required", "VALIDATION_ERROR", [
      USAGE.put,
    ]);
  }
  if (/[=\s]/.test(key)) {
    throw new AxiError(
      "secret name must not contain '=' or whitespace (pass the value on stdin, not as KEY=value); the input was not echoed",
      "VALIDATION_ERROR",
      [USAGE.put],
    );
  }
  if (!name) {
    // VISION.md safety: the Worker is named in full, never inferred.
    throw new AxiError("--name is required", "VALIDATION_ERROR", [
      USAGE.put,
      config === undefined
        ? "Run `cloudflare-axi workers deploy --dry-run` to see the Worker name in this directory"
        : `Run \`cloudflare-axi workers deploy --dry-run${configFlag(config)}\` to see the Worker name this config deploys`,
    ]);
  }
  if (stdinSource.isTTY()) {
    throw new AxiError(
      "secret value must be piped on stdin",
      "VALIDATION_ERROR",
      [USAGE.put],
    );
  }
  const value = await stdinSource.read();
  if (value.trimEnd() === "") {
    throw new AxiError("secret value on stdin is empty", "VALIDATION_ERROR", [
      USAGE.put,
    ]);
  }

  try {
    // Read-only precheck: wrangler's `secret put` silently creates a draft
    // Worker when the name does not exist. A missing Worker is NOT_FOUND here.
    const existing = await listSecrets(name, config);
    const status = existing.some((s) => s.name === key) ? "updated" : "created";
    await wranglerExec(
      [
        "secret",
        "put",
        key,
        "--name",
        name,
        ...(config ? ["--config", config] : []),
      ],
      { input: value },
    );
    return renderOutput([
      encode({
        worker: name,
        secret: key,
        status,
        note: "applies immediately as a new deployed Worker version",
      }),
      renderHelp([
        `Run \`cloudflare-axi workers secret list --name ${name}${configFlag(config)}\` to confirm`,
      ]),
    ]);
  } catch (caught) {
    const error = carryConfig(caught, config);
    if (error instanceof AxiError) {
      throw new AxiError(
        redactValue(error.message, value),
        error.code,
        error.suggestions.map((s) => redactValue(s, value)),
      );
    }
    throw new Error(
      redactValue(
        error instanceof Error ? error.message : String(error),
        value,
      ),
    );
  }
}

// ---- dispatch ----

const SUBCOMMANDS = ["deploy", "secret"] as const;
const SECRET_SUBCOMMANDS = ["put", "list"] as const;

async function secretCommand(args: string[]): Promise<string> {
  const sub = args[0];
  if (
    sub === undefined ||
    !(SECRET_SUBCOMMANDS as readonly string[]).includes(sub)
  ) {
    // Do not echo: a stray token here could be a secret value.
    throw new AxiError(
      sub === undefined || sub.startsWith("-")
        ? "`workers secret` needs a subcommand"
        : "unknown subcommand for `workers secret`",
      "VALIDATION_ERROR",
      [
        `subcommands: ${SECRET_SUBCOMMANDS.join(", ")}`,
        "cloudflare-axi workers --help",
      ],
    );
  }
  const rest = args.slice(1);
  return sub === "put" ? secretPut(rest) : secretList(rest);
}

export async function workersCommand(args: string[]): Promise<string> {
  const rest = [...args];
  const first = rest[0];
  if (first === undefined || first.startsWith("-")) {
    assertNoArgs("workers", rest);
    return renderOutput([
      WORKERS_HELP.trimEnd(),
      renderHelp([
        "Run `cloudflare-axi deployments` for recent deployments of the Worker in cwd",
      ]),
    ]);
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
    throw new AxiError(
      `unknown subcommand ${first} for \`workers\``,
      "VALIDATION_ERROR",
      [
        `subcommands: ${SUBCOMMANDS.join(", ")}`,
        "cloudflare-axi workers --help",
      ],
    );
  }
  rest.shift();
  switch (first as (typeof SUBCOMMANDS)[number]) {
    case "deploy":
      return deploy(rest);
    case "secret":
      return secretCommand(rest);
  }
}
