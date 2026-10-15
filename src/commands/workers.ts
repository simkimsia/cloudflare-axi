import { resolve } from "node:path";
import {
  assertNoArgs,
  rejectExtraArgs,
  takeBoolFlag,
  takeFlag,
  takePositional,
} from "../args.js";
import {
  configArgs,
  configRunOptions,
  configSource,
  configSuffix,
  findWranglerConfig,
  resolveConfigPath,
  takeConfig,
  withConfigContext,
  wranglerConfigSuffix,
} from "../config.js";
import { cfGet } from "../api.js";
import { AxiError, NOT_LINKED_SUGGESTIONS, stripAnsi } from "../errors.js";
import { encode, renderHelp, renderList, renderOutput } from "../toon.js";
import {
  wranglerExec,
  wranglerExecWithOutput,
  wranglerJson,
  type WranglerOutputEntry,
} from "../wrangler.js";
import { resolveAccountId } from "../zones.js";

export const WORKERS_HELP = `usage: cloudflare-axi workers [subcommand] [flags]
Cloudflare Workers: deploy or delete a Worker and manage its secrets.
subcommands[3]:
  deploy, delete, secret put <KEY>|list|delete <KEY>
flags{deploy}:
  --name <worker> (required unless --dry-run; must match the Worker the config deploys; never forwarded), --config <path>, --outdir <dir>, --dry-run
flags{delete}:
  --name <worker> (required), --force (delete even when other Workers depend on it; they break), --config <path>
flags{secret}:
  --name <worker> (required for put and delete), --config <path>
notes:
  deploy is directory-scoped like \`wrangler deploy\`: it deploys the wrangler config in cwd (or --config)
  --config <path> works from any directory: wrangler runs from the config's directory (relative --outdir still resolves against your cwd)
  a real deploy runs \`wrangler deploy --dry-run\` first and refuses when --name differs from the Worker name wrangler resolves
  deploy --dry-run bundles locally and uploads nothing
  delete removes the Worker irreversibly, with its secrets, cron triggers, routes, custom domains and workers.dev URL; it needs --name (never inferred from cwd) and refuses a Worker other Workers depend on unless --force
  secret put reads the value from stdin only; it never takes it as an argument and never prints it
  secret put refuses a Worker that does not exist (wrangler would silently create a draft Worker)
  secret delete needs the Worker and the secret named exactly; an unknown Worker or secret is NOT_FOUND and nothing is deleted
  secret list shows names and types only; Cloudflare never returns secret values
  recent deployments: \`cloudflare-axi deployments\`
  not wrapped yet: tail, secret bulk, --env; use \`wrangler\` for those
examples:
  cloudflare-axi workers deploy --dry-run
  cloudflare-axi workers deploy --dry-run --config ~/Projects/family-haze-bot/wrangler.toml
  cloudflare-axi workers deploy --name family-haze-bot
  cloudflare-axi workers secret list --name family-haze-bot
  printf %s "$TELEGRAM_BOT_TOKEN" | cloudflare-axi workers secret put TELEGRAM_BOT_TOKEN --name family-haze-bot
  cloudflare-axi workers secret delete TELEGRAM_BOT_TOKEN --name family-haze-bot
  cloudflare-axi workers delete --name axi-smoke-20261012-worker
`;

const USAGE = {
  deploy:
    "cloudflare-axi workers deploy --name <worker> [--config <path>] [--outdir <dir>] [--dry-run]",
  put: 'printf %s "$VALUE" | cloudflare-axi workers secret put <KEY> --name <worker> [--config <path>]',
  list: "cloudflare-axi workers secret list [--name <worker>] [--config <path>]",
  delete:
    "cloudflare-axi workers delete --name <worker> [--force] [--config <path>]",
  secretDelete:
    "cloudflare-axi workers secret delete <KEY> --name <worker> [--config <path>]",
};

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
 * Carry the user's --config into every `cloudflare-axi workers ...` or
 * `cloudflare-axi deployments` command an error suggests (mapped wrangler
 * errors in errors.ts cannot know it), so the follow-up targets the same
 * Worker from any cwd.
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
      s.replace(
        /`(cloudflare-axi (?:workers [^`]*|deployments(?: [^`]*)?))`/g,
        (whole, cmd: string) =>
          /(^|\s)--config(\s|=|$)/.test(cmd)
            ? whole
            : `\`${cmd}${configSuffix(config)}\``,
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

/** Without --config, require a wrangler config in cwd or a parent (--config is validated by takeConfig). */
function assertLinked(config: string | undefined): void {
  if (config === undefined && !findWranglerConfig(process.cwd())) {
    throw new AxiError(
      "No Worker is configured in this directory",
      "NOT_LINKED",
      NOT_LINKED_SUGGESTIONS,
    );
  }
}

async function deploy(args: string[]): Promise<string> {
  const name = takeFlag(args, "--name");
  const config = takeConfig(args);
  const outdirFlag = takeFlag(args, "--outdir");
  const dryRun = takeBoolFlag(args, "--dry-run");
  rejectExtraArgs("workers deploy", args, USAGE.deploy);

  assertLinked(config);
  // wrangler resolves --outdir against its own cwd, which is the config's
  // directory under --config; resolve it against the caller's cwd first.
  const outdir = outdirFlag === undefined ? undefined : resolve(outdirFlag);
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
  const suffix = configSuffix(config);
  if (!dryRun && !name) {
    // VISION.md safety: a write names its target in full, never inferred.
    throw new AxiError(
      "--name is required for a real deploy",
      "VALIDATION_ERROR",
      [
        USAGE.deploy,
        `Run \`cloudflare-axi workers deploy --dry-run${suffix}\` to see the Worker name this config deploys`,
      ],
    );
  }

  const outdirArgs = outdir ? ["--outdir", outdir] : [];
  const runOptions = configRunOptions(config);

  // Read-only pass: bundle locally and learn the Worker name wrangler
  // resolves from the config. Nothing is uploaded.
  const check = await withConfigContext(config, () =>
    wranglerExecWithOutput(
      [
        "deploy",
        "--dry-run",
        ...configArgs(config),
        ...(dryRun ? outdirArgs : []),
      ],
      runOptions,
    ),
  );
  const resolved = str(lastDeployEntry(check.entries)?.worker_name);
  if (name && !resolved) {
    throw new AxiError(
      "wrangler reported no Worker name on the --dry-run, so --name cannot be checked",
      "UNKNOWN",
      [
        `Rerun \`wrangler deploy --dry-run${wranglerConfigSuffix(config)}\` to see its full output, then report the gap at https://github.com/simkimsia/cloudflare-axi/issues`,
      ],
    );
  }
  if (name && resolved && name !== resolved) {
    throw new AxiError(
      `--name ${name} does not match the Worker this config deploys (${resolved})`,
      "VALIDATION_ERROR",
      [
        `Run \`cloudflare-axi workers deploy --name ${resolved}${suffix}\` to deploy it, or fix \`name\` in ${config ?? "the wrangler config"}`,
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
        `Run \`cloudflare-axi workers deploy --name ${resolved ?? "<worker>"}${suffix}\` to upload and deploy it`,
      ]),
    ]);
  }

  // --name is deliberately NOT forwarded: wrangler would deploy under that
  // name even if it differs from the config, creating a new Worker on a typo.
  // The dry-run above already proved it matches.
  const worker = name as string;
  const started = Date.now();
  const result = await wranglerExecWithOutput(
    ["deploy", ...configArgs(config), ...outdirArgs],
    runOptions,
  );
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const entry = lastDeployEntry(result.entries);
  const version =
    str(entry?.version_id) ??
    /Current Version ID:\s*(\S+)/.exec(stripAnsi(result.stdout))?.[1];
  if (!version) {
    throw new AxiError(
      `wrangler reported no version id: ${result.stdout.trim().split("\n").pop() ?? ""}`,
      "UNKNOWN",
      [
        `Run \`cloudflare-axi deployments${suffix}\` to check whether it deployed`,
      ],
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
      `Run \`cloudflare-axi deployments${suffix}\` ${
        targetsKnown
          ? "for the deployment history"
          : "to confirm this version is live"
      }`,
      `Run \`cloudflare-axi workers secret list --name ${worker}${suffix}\` to check its secrets`,
    ]),
  ]);
}

// ---- secret list ----

async function listSecrets(
  name: string | undefined,
  config: string | undefined,
): Promise<WranglerSecret[]> {
  return withConfigContext(config, () =>
    wranglerJson<WranglerSecret[]>(
      [
        "secret",
        "list",
        "--format",
        "json",
        ...(name ? ["--name", name] : []),
        ...configArgs(config),
      ],
      configRunOptions(config),
    ),
  );
}

async function secretList(args: string[]): Promise<string> {
  const name = takeFlag(args, "--name");
  const config = takeConfig(args);
  rejectExtraArgs("workers secret list", args, USAGE.list);

  let secrets: WranglerSecret[];
  try {
    secrets = await listSecrets(name, config);
  } catch (error) {
    throw carryConfig(error, config);
  }
  const worker = name ?? "<worker>";
  const suffix = configSuffix(config);
  // wrangler's secret list JSON does not name the Worker it resolved, so
  // without --name point at a command that shows it.
  const findName = name
    ? []
    : [
        `Run \`cloudflare-axi workers deploy --dry-run${suffix}\` to see the Worker name this config deploys`,
      ];
  if (secrets.length === 0) {
    return renderOutput([
      `secrets: 0 secrets on ${name ?? `the Worker configured in ${configSource(config)}`}`,
      renderHelp([
        ...findName,
        `Run \`printf %s "$VALUE" | cloudflare-axi workers secret put <KEY> --name ${worker}${suffix}\` to add one`,
      ]),
    ]);
  }
  return renderOutput([
    `count: ${secrets.length} secrets${name ? ` on ${name}` : ""}`,
    renderList("secrets", toSecretRows(secrets)),
    renderHelp([
      "Values are write-only; Cloudflare never returns them",
      ...findName,
      `Run \`printf %s "$VALUE" | cloudflare-axi workers secret put <KEY> --name ${worker}${suffix}\` to add or rotate one`,
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
  const rawConfig = takeFlag(args, "--config");
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
      `Run \`cloudflare-axi workers deploy --dry-run${configSuffix(rawConfig === undefined ? undefined : resolve(rawConfig))}\` to see the Worker name ${rawConfig === undefined ? "in this directory" : "this config deploys"}`,
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

  let config: string | undefined;
  try {
    // Validated inside the try so its error passes through redactValue too.
    config = rawConfig === undefined ? undefined : resolveConfigPath(rawConfig);
    // Read-only precheck: wrangler's `secret put` silently creates a draft
    // Worker when the name does not exist. A missing Worker is NOT_FOUND here.
    const existing = await listSecrets(name, config);
    const status = existing.some((s) => s.name === key) ? "updated" : "created";
    await wranglerExec(
      ["secret", "put", key, "--name", name, ...configArgs(config)],
      { ...configRunOptions(config), input: value },
    );
    return renderOutput([
      encode({
        worker: name,
        secret: key,
        status,
        note: "applies immediately as a new deployed Worker version",
      }),
      renderHelp([
        `Run \`cloudflare-axi workers secret list --name ${name}${configSuffix(config)}\` to confirm`,
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

// ---- delete ----

/** A Worker as Cloudflare names it in references (`script`, or `service` + `environment`). */
export interface ScriptRef {
  script?: string;
  service?: string;
  environment?: string;
}

/** `GET /accounts/{a}/workers/scripts/{name}/references` (shape from wrangler 4.127.1 `src/delete.ts`). */
export interface WorkerReferences {
  services?: { incoming?: ScriptRef[]; pages_function?: boolean };
  durable_objects?: (ScriptRef & { durable_object_namespace_name?: string })[];
  dispatch_outbounds?: (ScriptRef & { namespace?: string })[];
}

/** One row of `GET /accounts/{a}/workers/tails/by-consumer/{name}`. */
export interface TailProducer {
  producer: ScriptRef;
}

/** Same rendering as wrangler's `renderScriptName`. */
function scriptLabel(ref: ScriptRef): string {
  if (ref.script !== undefined) return ref.script;
  const service = ref.service ?? "unknown";
  return ref.environment ? `${service} (${ref.environment})` : service;
}

/**
 * What breaks if Worker `name` is deleted, one line per dependent. Mirrors
 * the checks `wrangler delete` makes before it asks to force the delete:
 * service bindings, a Pages Function binding, Durable Object namespaces it
 * implements for other Workers, dispatch outbounds and tail consumers.
 */
export function listDependents(
  name: string,
  references: WorkerReferences,
  tails: TailProducer[],
): string[] {
  const out: string[] = [];
  for (const ref of references.services?.incoming ?? []) {
    out.push(`Worker ${scriptLabel(ref)} uses it as a Service Binding`);
  }
  if (references.services?.pages_function === true) {
    out.push("A Pages project has a Service Binding to it");
  }
  for (const ref of references.durable_objects ?? []) {
    if (ref.service === name) continue;
    out.push(
      `Worker ${scriptLabel(ref)} binds the Durable Object namespace "${ref.durable_object_namespace_name ?? "unknown"}" it implements`,
    );
  }
  for (const ref of references.dispatch_outbounds ?? []) {
    out.push(
      `Worker ${scriptLabel(ref)} uses it as the Outbound Worker of dispatch namespace "${ref.namespace ?? "unknown"}"`,
    );
  }
  for (const tail of tails) {
    out.push(`Worker ${scriptLabel(tail.producer)} uses it as a Tail Worker`);
  }
  return out;
}

/** Workers Sites asset namespaces `wrangler delete` reports removing with the Worker. */
export function parseDeletedSiteNamespaces(stdout: string): string[] {
  return [
    ...stripAnsi(stdout).matchAll(
      /Deleted asset namespace for Workers Site "([^"]+)"/g,
    ),
  ].map((m) => m[1]);
}

/** Account for the dependents check (CLOUDFLARE_ACCOUNT_ID, else the token's sole account). */
async function workersAccountId(): Promise<string> {
  try {
    return await resolveAccountId();
  } catch (error) {
    if (error instanceof AxiError && error.code === "VALIDATION_ERROR") {
      throw new AxiError(`${error.message}; nothing deleted`, error.code, [
        "Set CLOUDFLARE_ACCOUNT_ID=<id> to the account that owns the Worker",
      ]);
    }
    throw error;
  }
}

/** Say "nothing deleted" on a NOT_FOUND from a read-only precheck. */
function nothingDeleted(error: unknown): unknown {
  if (error instanceof AxiError && error.code === "NOT_FOUND") {
    return new AxiError(
      `${error.message.replace(/\.$/, "")}; nothing deleted`,
      error.code,
      error.suggestions,
    );
  }
  return error;
}

function nameHint(config: string | undefined): string {
  return `Run \`cloudflare-axi workers deploy --dry-run${configSuffix(config)}\` to see the Worker name ${config === undefined ? "in this directory" : "this config deploys"}`;
}

async function deleteWorker(args: string[]): Promise<string> {
  const name = takeFlag(args, "--name");
  const config = takeConfig(args);
  const force = takeBoolFlag(args, "--force");
  rejectExtraArgs("workers delete", args, USAGE.delete);
  if (!name) {
    // VISION.md safety: a delete names its target in full. Never inferred
    // from the wrangler config in cwd (wrangler delete would fall back to it).
    throw new AxiError("--name is required", "VALIDATION_ERROR", [
      USAGE.delete,
      nameHint(config),
    ]);
  }
  try {
    return await runDeleteWorker(name, config, force);
  } catch (error) {
    throw carryConfig(error, config);
  }
}

async function runDeleteWorker(
  name: string,
  config: string | undefined,
  force: boolean,
): Promise<string> {
  const suffix = configSuffix(config);
  // Read-only existence check: `secret list --name` of a missing Worker is
  // NOT_FOUND (verified live, #45). Its count says which secrets go with it.
  let secrets: WranglerSecret[];
  try {
    secrets = await listSecrets(name, config);
  } catch (error) {
    throw nothingDeleted(error);
  }

  // wrangler delete has no skip-confirmation flag. Its --force skips both
  // prompts AND its check for Workers that depend on this one; without
  // --force a non-interactive run auto-confirms both prompts, so it would
  // break dependents silently either way. Make that check here (the same two
  // endpoints wrangler reads), then always pass --force so it never prompts.
  if (!force) {
    const account = await workersAccountId();
    const encoded = encodeURIComponent(name);
    let references: WorkerReferences | null;
    let tails: TailProducer[] | null;
    try {
      [references, tails] = await Promise.all([
        cfGet<WorkerReferences | null>(
          `/accounts/${account}/workers/scripts/${encoded}/references`,
        ),
        cfGet<TailProducer[] | null>(
          `/accounts/${account}/workers/tails/by-consumer/${encoded}`,
        ),
      ]);
    } catch (error) {
      throw nothingDeleted(error);
    }
    const dependents = listDependents(name, references ?? {}, tails ?? []);
    if (dependents.length > 0) {
      throw new AxiError(
        `Worker ${name} is in use by other Workers; nothing deleted`,
        "VALIDATION_ERROR",
        [
          ...dependents,
          `Run \`cloudflare-axi workers delete --name ${name} --force${suffix}\` to delete it anyway; the dependents above break, irreversibly`,
        ],
      );
    }
  }

  const result = await wranglerExec(
    ["delete", "--name", name, "--force", ...configArgs(config)],
    configRunOptions(config),
  );
  const stdout = stripAnsi(result);
  if (!/Successfully deleted/.test(stdout)) {
    throw new AxiError(
      `wrangler did not confirm deleting ${name}: ${stdout.trim().split("\n").pop() ?? ""}`,
      "UNKNOWN",
      [
        `Run \`cloudflare-axi workers secret list --name ${name}${suffix}\` to check whether it still exists (NOT_FOUND means it is gone)`,
      ],
    );
  }
  const sites = parseDeletedSiteNamespaces(stdout);
  return renderOutput([
    encode({
      worker: name,
      status: "deleted",
      secrets: secrets.length,
      removed_with_it:
        "its secrets, cron triggers, routes, custom domains, workers.dev URL and deployment history",
      ...(sites.length > 0 ? { site_namespaces_deleted: sites } : {}),
      ...(force ? { dependents: "not checked (--force)" } : {}),
    }),
    renderHelp([
      `Run \`cloudflare-axi workers secret list --name ${name}${suffix}\` to confirm it is gone (NOT_FOUND)`,
      `A wrangler config that deploys ${name} recreates it on its next \`workers deploy\`; remove or rename that config if it should stay gone`,
    ]),
  ]);
}

// ---- secret delete ----

const KNOWN_SECRET_DELETE_FLAGS = new Set(["--name", "--config", "--help"]);

async function secretDelete(args: string[]): Promise<string> {
  const name = takeFlag(args, "--name");
  const config = takeConfig(args);
  const key = takePositional(args);
  if (args.length > 0) {
    // As with put, never echo leftovers: a stray token may be a secret value.
    const flags = args
      .map((a) => a.split("=")[0])
      .filter((a) => KNOWN_SECRET_DELETE_FLAGS.has(a));
    throw new AxiError(
      `\`workers secret delete\` takes one <KEY>; unexpected input was not echoed${
        flags.length > 0 ? ` (flags: ${[...new Set(flags)].join(", ")})` : ""
      }`,
      "VALIDATION_ERROR",
      [USAGE.secretDelete],
    );
  }
  if (!key) {
    throw new AxiError("secret name <KEY> is required", "VALIDATION_ERROR", [
      USAGE.secretDelete,
      "Run `cloudflare-axi workers secret list --name <worker>` to see its secret names",
    ]);
  }
  if (/[=\s]/.test(key)) {
    throw new AxiError(
      "secret name must not contain '=' or whitespace; the input was not echoed",
      "VALIDATION_ERROR",
      [USAGE.secretDelete],
    );
  }
  if (!name) {
    // VISION.md safety: the Worker is named in full, never inferred.
    throw new AxiError("--name is required", "VALIDATION_ERROR", [
      USAGE.secretDelete,
      nameHint(config),
    ]);
  }
  try {
    return await runSecretDelete(key, name, config);
  } catch (error) {
    throw carryConfig(error, config);
  }
}

async function runSecretDelete(
  key: string,
  name: string,
  config: string | undefined,
): Promise<string> {
  const suffix = configSuffix(config);
  // Read-only precheck: NOT_FOUND for an unknown Worker, and an exact,
  // case-sensitive match on the secret name, before any write.
  let secrets: WranglerSecret[];
  try {
    secrets = await listSecrets(name, config);
  } catch (error) {
    throw nothingDeleted(error);
  }
  if (!secrets.some((s) => s.name === key)) {
    throw new AxiError(
      `secret ${key} not found on Worker ${name}; nothing deleted`,
      "NOT_FOUND",
      [
        `Run \`cloudflare-axi workers secret list --name ${name}${suffix}\` to see its secret names (case-sensitive)`,
      ],
    );
  }
  // wrangler secret delete has no skip-confirmation flag (4.127.1). Its
  // prompt takes the non-interactive fallback (yes) because src/wrangler.ts
  // always runs wrangler with piped stdin and stdout, never a TTY.
  const result = await wranglerExec(
    ["secret", "delete", key, "--name", name, ...configArgs(config)],
    configRunOptions(config),
  );
  const stdout = stripAnsi(result);
  if (!/Success! Deleted secret/.test(stdout)) {
    throw new AxiError(
      `wrangler did not confirm deleting secret ${key}: ${stdout.trim().split("\n").pop() ?? ""}`,
      "UNKNOWN",
      [
        `Run \`cloudflare-axi workers secret list --name ${name}${suffix}\` to check whether it is still there`,
      ],
    );
  }
  return renderOutput([
    encode({
      worker: name,
      secret: key,
      status: "deleted",
      secrets_left: secrets.length - 1,
    }),
    renderHelp([
      `Run \`cloudflare-axi workers secret list --name ${name}${suffix}\` to confirm`,
    ]),
  ]);
}

// ---- dispatch ----

const SUBCOMMANDS = ["deploy", "delete", "secret"] as const;
const SECRET_SUBCOMMANDS = ["put", "list", "delete"] as const;

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
  switch (sub as (typeof SECRET_SUBCOMMANDS)[number]) {
    case "put":
      return secretPut(rest);
    case "list":
      return secretList(rest);
    case "delete":
      return secretDelete(rest);
  }
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
    case "delete":
      return deleteWorker(rest);
    case "secret":
      return secretCommand(rest);
  }
}
