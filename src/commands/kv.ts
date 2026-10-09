import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoArgs,
  rejectExtraArgs,
  takeBoolFlag,
  takeFlag,
  takePositional,
} from "../args.js";
import { AxiError } from "../errors.js";
import { encode, renderHelp, renderList, renderOutput } from "../toon.js";
import { wranglerExec, wranglerJson } from "../wrangler.js";

export const KV_HELP = `usage: cloudflare-axi kv [subcommand] [flags]
Workers KV: list namespaces, create one, list keys, read, write and delete values. Always the remote (deployed) store, never wrangler's local one.
subcommands[5]:
  (none)=list all namespaces (title, id), create <title>, keys [<namespace>], get <key>, put <key>, delete <key>
flags{keys,get}:
  --namespace <title|id> or --binding <NAME> (from the wrangler config in cwd)
flags{keys}:
  --prefix <p>, --limit <n> (default 50)
flags{get}:
  --full (print the whole value; default truncates at 4000 chars)
flags{put}:
  --namespace <title|id> (required), --file <path> or --stdin (exactly one; the value never goes in argv), --ttl <seconds>
flags{delete}:
  --namespace <title|id> (required)
notes:
  put and delete need --namespace named in full (title or id); --binding is refused for writes because it depends on the cwd's wrangler config
  put prints whether it created the key or overwrote an existing value; delete refuses a key that does not exist
  KV is eventually consistent: a read can lag a write by up to 60s
examples:
  cloudflare-axi kv
  cloudflare-axi kv create SETTINGS
  cloudflare-axi kv keys SETTINGS --prefix user:
  cloudflare-axi kv get feed --namespace SETTINGS
  cloudflare-axi kv get feed --binding SETTINGS
  echo '{"on":true}' | cloudflare-axi kv put flags --namespace SETTINGS --stdin
  cloudflare-axi kv put feed --namespace SETTINGS --file ./feed.json --ttl 3600
  cloudflare-axi kv delete feed --namespace SETTINGS
`;

const USAGE = {
  create: "cloudflare-axi kv create <title>",
  keys: "cloudflare-axi kv keys <namespace> | --binding <NAME> [--prefix <p>] [--limit <n>]",
  get: "cloudflare-axi kv get <key> --namespace <title|id> | --binding <NAME> [--full]",
  put: "cloudflare-axi kv put <key> --namespace <title|id> --file <path> | --stdin [--ttl <seconds>]",
  delete: "cloudflare-axi kv delete <key> --namespace <title|id>",
};

/** Values longer than this (in rendered chars) are truncated unless --full. */
export const VALUE_PREVIEW_CHARS = 4000;
const DEFAULT_KEY_LIMIT = 50;

/** `wrangler kv namespace list` always emits raw JSON (there is no --json flag). */
export interface KvNamespace {
  id: string;
  title: string;
  supports_url_encoding?: boolean;
}

/** One entry of `wrangler kv key list` (raw JSON; no --json flag either). */
export interface KvKey {
  name: string;
  /** Unix seconds; absent when the key never expires. */
  expiration?: number;
  metadata?: unknown;
}

function listNamespaces(): Promise<KvNamespace[]> {
  return wranglerJson<KvNamespace[]>(["kv", "namespace", "list"]);
}

// ---- list (unchanged v0 behaviour) ----

async function listCommand(args: string[]): Promise<string> {
  assertNoArgs("kv", args);
  const namespaces = await listNamespaces();

  if (namespaces.length === 0) {
    return renderOutput([
      "namespaces: 0 KV namespaces found in this account",
      renderHelp(["Run `cloudflare-axi kv create <title>` to create one"]),
    ]);
  }

  return renderOutput([
    `count: ${namespaces.length} KV namespaces`,
    renderList(
      "namespaces",
      namespaces.map((n) => ({ title: n.title, id: n.id })),
    ),
    renderHelp([
      "Run `cloudflare-axi kv keys <title>` to list keys in a namespace",
      "Run `cloudflare-axi kv get <key> --namespace <title>` to read a value",
    ]),
  ]);
}

// ---- namespace targeting ----

/** Where a kv key command points: a resolved namespace, or a config binding. */
export type KvTarget =
  | { kind: "namespace"; id: string; title: string }
  | { kind: "binding"; binding: string };

/**
 * Resolve `--namespace <title|id>` by exact match against the account's
 * namespaces. Never fuzzy: a write must name its target in full (VISION.md
 * Safety). Resolving also proves the namespace exists, so a later wrangler
 * 404 can only mean the key is missing.
 */
export async function resolveNamespace(ref: string): Promise<KvTarget> {
  const namespaces = await listNamespaces();
  const match =
    namespaces.find((n) => n.id === ref) ??
    namespaces.find((n) => n.title === ref);
  if (!match) {
    throw new AxiError(
      `KV namespace ${ref} not found in this account`,
      "NOT_FOUND",
      [
        "Run `cloudflare-axi kv` to list namespaces (title, id); titles match exactly, case-sensitive",
      ],
    );
  }
  return { kind: "namespace", id: match.id, title: match.title };
}

/** wrangler argv selecting the target; always --remote (wrangler defaults some kv commands to local). */
function targetArgs(target: KvTarget): string[] {
  return target.kind === "namespace"
    ? ["--namespace-id", target.id, "--remote"]
    : ["--binding", target.binding, "--remote"];
}

function targetLabel(target: KvTarget): string {
  return target.kind === "namespace"
    ? `${target.title} (${target.id})`
    : `binding ${target.binding} (from the wrangler config in cwd)`;
}

/** The `--namespace X` / `--binding X` to repeat in follow-up hints. */
function targetFlag(target: KvTarget): string {
  return target.kind === "namespace"
    ? `--namespace ${target.title}`
    : `--binding ${target.binding}`;
}

/** Reads accept a namespace (title or id) or a config binding, exactly one. */
async function readTarget(
  namespace: string | undefined,
  binding: string | undefined,
  usage: string,
): Promise<KvTarget> {
  if (namespace && binding) {
    throw new AxiError(
      "pass either a namespace or --binding, not both",
      "VALIDATION_ERROR",
      [usage],
    );
  }
  if (binding) return { kind: "binding", binding };
  if (namespace) return resolveNamespace(namespace);
  throw new AxiError(
    "a namespace is required (--namespace <title|id> or --binding <NAME>)",
    "VALIDATION_ERROR",
    [usage, "Run `cloudflare-axi kv` to list namespaces (title, id)"],
  );
}

type NamespaceTarget = Extract<KvTarget, { kind: "namespace" }>;

/** Writes need --namespace; --binding is refused (it is inferred from the cwd config). */
async function writeTarget(
  namespace: string | undefined,
  binding: string | undefined,
  command: string,
  usage: string,
): Promise<NamespaceTarget> {
  if (binding) {
    throw new AxiError(
      `\`kv ${command}\` needs --namespace <title|id>; --binding is not accepted for writes`,
      "VALIDATION_ERROR",
      [
        usage,
        "A binding resolves through whatever wrangler config is in cwd; a write names its namespace in full",
        "Run `cloudflare-axi kv` to list namespaces (title, id)",
      ],
    );
  }
  if (!namespace) {
    throw new AxiError("--namespace is required", "VALIDATION_ERROR", [
      usage,
      "Run `cloudflare-axi kv` to list namespaces (title, id)",
    ]);
  }
  return (await resolveNamespace(namespace)) as NamespaceTarget;
}

function requireKey(args: string[], usage: string): string {
  const key = takePositional(args);
  if (!key) {
    throw new AxiError("key is required", "VALIDATION_ERROR", [usage]);
  }
  return key;
}

// ---- create ----

/** wrangler's own rule for the binding name it suggests: a valid JS identifier. */
export function bindingNameFor(title: string): string {
  const cleaned = title.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * `wrangler kv namespace create` is text-only. It prints a config snippet
 * containing the new id, as TOML (`id = "..."`) or JSON (`"id": "..."`)
 * depending on the cwd's config format.
 */
export function parseCreatedId(stdout: string): string | undefined {
  return /\bid"?\s*[=:]\s*"([0-9a-f]{32})"/.exec(stdout)?.[1];
}

async function createNamespace(args: string[]): Promise<string> {
  const title = takePositional(args);
  if (!title) {
    throw new AxiError("namespace title is required", "VALIDATION_ERROR", [
      USAGE.create,
    ]);
  }
  rejectExtraArgs("kv create", args, USAGE.create);

  // --update-config=false: never let wrangler patch (or prompt to patch) a
  // wrangler.jsonc in cwd; the binding snippet is printed for the agent.
  const stdout = await wranglerExec([
    "kv",
    "namespace",
    "create",
    title,
    "--update-config=false",
  ]);
  const id =
    parseCreatedId(stdout) ??
    (await listNamespaces()
      .then((all) => all.find((n) => n.title === title)?.id)
      .catch(() => undefined));
  const binding = bindingNameFor(title);
  const shownId = id ?? "<id from `cloudflare-axi kv`>";

  return renderOutput([
    encode({ namespace: { title, id: id ?? "unknown" }, status: "created" }),
    renderHelp([
      `wrangler.toml: add a [[kv_namespaces]] table with binding = "${binding}" and id = "${shownId}"`,
      `wrangler.jsonc: add { "binding": "${binding}", "id": "${shownId}" } to "kv_namespaces"`,
      `Run \`cloudflare-axi kv put <key> --namespace ${title} --file <path>\` to write a value`,
    ]),
  ]);
}

// ---- keys ----

function expiresLabel(expiration: number | undefined): string {
  if (!expiration) return "never";
  return new Date(expiration * 1000).toISOString();
}

async function listKeys(args: string[]): Promise<string> {
  const prefix = takeFlag(args, "--prefix");
  const limitRaw = takeFlag(args, "--limit");
  const namespaceFlag = takeFlag(args, "--namespace");
  const binding = takeFlag(args, "--binding");
  const positional = takePositional(args);
  rejectExtraArgs("kv keys", args, USAGE.keys);
  if (namespaceFlag && positional) {
    throw new AxiError(
      "pass the namespace once, either positionally or with --namespace",
      "VALIDATION_ERROR",
      [USAGE.keys],
    );
  }
  const limit = limitRaw === undefined ? DEFAULT_KEY_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AxiError(
      `--limit must be a positive integer, got ${limitRaw}`,
      "VALIDATION_ERROR",
      [USAGE.keys],
    );
  }
  const target = await readTarget(
    namespaceFlag ?? positional,
    binding,
    USAGE.keys,
  );

  const keys = await wranglerJson<KvKey[]>([
    "kv",
    "key",
    "list",
    ...targetArgs(target),
    ...(prefix ? ["--prefix", prefix] : []),
  ]);
  const scope = `${targetLabel(target)}${prefix ? ` with prefix ${prefix}` : ""}`;
  if (keys.length === 0) {
    return renderOutput([
      `keys: 0 keys in ${scope}`,
      renderHelp([
        `Run \`cloudflare-axi kv put <key> --namespace ${target.kind === "namespace" ? target.title : "<title|id>"} --file <path>\` to write one`,
      ]),
    ]);
  }
  const shown = keys.slice(0, limit);
  return renderOutput([
    `count: ${shown.length} of ${keys.length} keys in ${scope}`,
    renderList(
      "keys",
      shown.map((k) => ({
        name: k.name,
        expires: expiresLabel(k.expiration),
      })),
    ),
    renderHelp([
      ...(keys.length > limit
        ? [`Pass --limit ${keys.length} for all, or --prefix <p> to narrow`]
        : []),
      `Run \`cloudflare-axi kv get <key> ${targetFlag(target)}\` to read a value`,
    ]),
  ]);
}

// ---- get ----

export type ValueFormat = "json" | "text" | "binary";

/**
 * Classify a value as wrangler printed it (stdout decoded as UTF-8). Bytes
 * that are not valid UTF-8 decode to U+FFFD, and text rarely contains C0
 * control characters other than tab/newline/CR, so either marks it binary.
 */
export function classifyValue(raw: string): {
  format: ValueFormat;
  text: string;
} {
  // eslint-disable-next-line no-control-regex
  if (/[�\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw)) {
    return { format: "binary", text: "" };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return {
        format: "json",
        text: JSON.stringify(JSON.parse(trimmed), null, 2),
      };
    } catch {
      // not JSON; fall through to text
    }
  }
  return { format: "text", text: raw };
}

/** Cut at the last line break before `limit` chars so lines stay whole. */
export function truncateValue(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", limit);
  return {
    text: text.slice(0, cut > limit / 2 ? cut : limit),
    truncated: true,
  };
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** Fetch a key's raw value; NOT_FOUND when the key is missing. */
function fetchValue(key: string, target: KvTarget): Promise<string> {
  return wranglerExec(["kv", "key", "get", key, ...targetArgs(target)]);
}

/** Byte size of a fetched value, or undefined when the key does not exist. */
async function probeSize(
  key: string,
  target: KvTarget,
): Promise<number | undefined> {
  try {
    return Buffer.byteLength(await fetchValue(key, target), "utf8");
  } catch (error) {
    if (error instanceof AxiError && error.code === "NOT_FOUND") {
      return undefined;
    }
    throw error;
  }
}

async function getValue(args: string[]): Promise<string> {
  const full = takeBoolFlag(args, "--full");
  const namespaceFlag = takeFlag(args, "--namespace");
  const binding = takeFlag(args, "--binding");
  const key = requireKey(args, USAGE.get);
  rejectExtraArgs("kv get", args, USAGE.get);
  const target = await readTarget(namespaceFlag, binding, USAGE.get);

  const raw = await fetchValue(key, target);
  const size = Buffer.byteLength(raw, "utf8");
  const { format, text } = classifyValue(raw);
  const header = encode({
    key,
    namespace: targetLabel(target),
    size: format === "binary" ? "unknown (binary)" : `${size} bytes`,
    format,
  });

  if (format === "binary") {
    return renderOutput([
      header,
      "value: not shown (not valid UTF-8 text)",
      renderHelp([
        "Read binary values from the Worker that wrote them; cloudflare-axi only prints text and JSON",
      ]),
    ]);
  }

  const shown = full
    ? { text, truncated: false }
    : truncateValue(text, VALUE_PREVIEW_CHARS);
  const hints: string[] = [];
  if (shown.truncated) {
    hints.push(
      `Truncated: showing ${shown.text.length} of ${text.length} chars; run \`cloudflare-axi kv get ${key} ${targetFlag(target)} --full\` for all of it`,
    );
  }
  hints.push(
    format === "json"
      ? "value is the stored JSON, pretty-printed and indented two spaces"
      : "value is the stored text, indented two spaces",
  );
  return renderOutput([
    header,
    `value:\n${indentBlock(shown.text)}${shown.truncated ? "\n  ..." : ""}`,
    renderHelp(hints),
  ]);
}

// ---- put ----

/** Read all of stdin; refuses a TTY so the command never hangs on a prompt. */
async function readStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) {
    throw new AxiError(
      "--stdin was given but stdin is a terminal",
      "VALIDATION_ERROR",
      [
        "Pipe the value in: `printf '%s' <value> | cloudflare-axi kv put <key> --namespace <ns> --stdin`",
        "Or pass --file <path>",
      ],
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function putValue(args: string[]): Promise<string> {
  const file = takeFlag(args, "--file");
  const fromStdin = takeBoolFlag(args, "--stdin");
  const ttlRaw = takeFlag(args, "--ttl");
  const namespace = takeFlag(args, "--namespace");
  const binding = takeFlag(args, "--binding");
  const key = requireKey(args, USAGE.put);
  rejectExtraArgs("kv put", args, USAGE.put);

  if ((file === undefined) === !fromStdin) {
    throw new AxiError(
      "pass exactly one of --file <path> or --stdin for the value",
      "VALIDATION_ERROR",
      [USAGE.put, "The value is never taken from argv"],
    );
  }
  let ttl: number | undefined;
  if (ttlRaw !== undefined) {
    ttl = Number(ttlRaw);
    // Cloudflare's minimum expiration TTL is 60 seconds.
    if (!Number.isInteger(ttl) || ttl < 60) {
      throw new AxiError(
        `--ttl must be an integer number of seconds >= 60, got ${ttlRaw}`,
        "VALIDATION_ERROR",
        [USAGE.put],
      );
    }
  }

  const target = await writeTarget(namespace, binding, "put", USAGE.put);

  let tempDir: string | undefined;
  let path: string;
  let size: number;
  if (file !== undefined) {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      throw new AxiError(`${file} is not a file`, "VALIDATION_ERROR", [
        USAGE.put,
      ]);
    }
    path = file;
    size = info.size;
  } else {
    const value = await readStdin();
    tempDir = await mkdtemp(join(tmpdir(), "cloudflare-axi-kv-"));
    path = join(tempDir, "value");
    await writeFile(path, value, { mode: 0o600 });
    size = value.length;
  }

  try {
    const previous = await probeSize(key, target);
    await wranglerExec([
      "kv",
      "key",
      "put",
      key,
      "--path",
      path,
      ...targetArgs(target),
      ...(ttl !== undefined ? ["--ttl", String(ttl)] : []),
    ]);
    return renderOutput([
      encode({
        key,
        namespace: targetLabel(target),
        action:
          previous === undefined
            ? "created"
            : `overwritten (previous value ${previous} bytes)`,
        size: `${size} bytes`,
        ttl: ttl !== undefined ? `${ttl}s` : "none",
      }),
      renderHelp([
        `Run \`cloudflare-axi kv get ${key} --namespace ${target.title}\` to read it back (reads can lag a write by up to 60s)`,
      ]),
    ]);
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

// ---- delete ----

async function deleteKey(args: string[]): Promise<string> {
  const namespace = takeFlag(args, "--namespace");
  const binding = takeFlag(args, "--binding");
  const key = requireKey(args, USAGE.delete);
  rejectExtraArgs("kv delete", args, USAGE.delete);
  const target = await writeTarget(namespace, binding, "delete", USAGE.delete);

  // wrangler's delete succeeds on a missing key; check first so the output
  // never claims a deletion that did not happen.
  const previous = await probeSize(key, target);
  if (previous === undefined) {
    throw new AxiError(
      `key ${key} not found in KV namespace ${target.title}; nothing deleted`,
      "NOT_FOUND",
      [
        `Run \`cloudflare-axi kv keys ${target.title} --prefix ${key}\` to check the exact key name`,
        "A key written in the last 60s may not be visible yet",
      ],
    );
  }
  await wranglerExec(["kv", "key", "delete", key, ...targetArgs(target)]);
  return renderOutput([
    encode({
      key,
      namespace: targetLabel(target),
      action: `deleted (was ${previous} bytes)`,
    }),
    renderHelp([
      `Run \`cloudflare-axi kv keys ${target.title}\` to see the remaining keys (listings can lag up to 60s)`,
    ]),
  ]);
}

// ---- dispatch ----

const SUBCOMMANDS = ["create", "keys", "get", "put", "delete"] as const;

export async function kvCommand(args: string[]): Promise<string> {
  const rest = [...args];
  const first = rest[0];
  if (first === undefined || first.startsWith("-")) {
    return listCommand(rest);
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
    throw new AxiError(
      `unknown subcommand ${first} for \`kv\``,
      "VALIDATION_ERROR",
      [
        `subcommands: ${SUBCOMMANDS.join(", ")} (or none to list namespaces)`,
        "cloudflare-axi kv --help",
      ],
    );
  }
  rest.shift();
  switch (first as (typeof SUBCOMMANDS)[number]) {
    case "create":
      return createNamespace(rest);
    case "keys":
      return listKeys(rest);
    case "get":
      return getValue(rest);
    case "put":
      return putValue(rest);
    case "delete":
      return deleteKey(rest);
  }
}
