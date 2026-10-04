import { cfGet, cfRequest } from "../api.js";
import {
  rejectExtraArgs,
  takeBoolFlag,
  takeFlag,
  takePositional,
} from "../args.js";
import { AxiError } from "../errors.js";
import { encode, renderHelp, renderList, renderOutput } from "../toon.js";
import { resolveZone, type ZoneRef } from "../zones.js";

export const DNS_HELP = `usage: cloudflare-axi dns [subcommand] --zone <domain|zone-id>
DNS records for a zone via the Cloudflare REST API (wrangler has no DNS surface).
subcommands[2]:
  read: (none)/list = records in the zone
  write: set <type> <name> <content> = create, or update the one matching record
flags[8]:
  --zone <domain|zone-id>  apex domain (one lookup) or 32-hex zone id; required
  --type <type>            list: only this record type (A, TXT, MX, ...)
  --name <name>            list: only this name
  --full                   list: do not shorten long content (DKIM keys)
  --id <record-id>         set: update exactly this record (when several match)
  --ttl <seconds|auto>     set: TTL; default auto on create, unchanged on update
  --proxied[=true|false]   set: Cloudflare proxy for A/AAAA/CNAME; default off on create, unchanged on update
  --priority <n>           set: MX priority; required to create an MX
auth: CLOUDFLARE_API_TOKEN with Zone > DNS > Read (list) or Edit (set). The \`wrangler login\` OAuth token cannot carry DNS scopes
notes:
  <name> is relative to the zone (\`@\` = apex, \`_dmarc\`) or a full name on the zone (\`_dmarc.example.com\`)
  \`set\` types: A, AAAA, CNAME, TXT, MX, NS. Same content already there = no-op
  \`set\` TXT with a \`v=\` tag (SPF \`v=spf1\`, DMARC \`v=DMARC1\`, DKIM \`v=DKIM1\`) matches only the record with the same tag at that name, so other TXT records (site verification) are left alone
  \`set\` refuses when several records match and lists their ids; re-run with --id <record-id>
examples:
  cloudflare-axi dns --zone example.com
  cloudflare-axi dns list --zone example.com --type TXT --name @
  cloudflare-axi dns set TXT @ "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all" --zone example.com
  cloudflare-axi dns set TXT _dmarc "v=DMARC1; p=none; rua=mailto:dmarc@example.com" --zone example.com
  cloudflare-axi dns set CNAME www example.pages.dev --proxied --zone example.com
`;

const USAGE =
  "cloudflare-axi dns [list [--type <type>] [--name <name>] [--full] | set <type> <name> <content> [--id <id>] [--ttl <s|auto>] [--proxied] [--priority <n>]] --zone <domain|zone-id>";

// ---- API shape (GET /zones/{zone}/dns_records, Cloudflare API v4 docs) ----

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  /** 1 means "automatic". */
  ttl: number;
  proxied?: boolean;
  priority?: number;
  comment?: string | null;
}

export const SETTABLE_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"];
const PROXIABLE_TYPES = new Set(["A", "AAAA", "CNAME"]);
const LIST_LIMIT = 1000;
const CONTENT_LIMIT = 100;

// ---- pure helpers (unit-tested offline) ----

/**
 * `@` is the apex, a name ending in the zone is already full, anything else
 * is relative to the zone (the same rule the Cloudflare dashboard uses).
 */
export function qualifyName(name: string, zoneName: string): string {
  const value = name.trim().toLowerCase().replace(/\.$/, "");
  if (value === "") {
    throw new AxiError("record name is empty", "VALIDATION_ERROR", [
      "Use `@` for the zone apex",
    ]);
  }
  if (value === "@" || value === zoneName) return zoneName;
  if (value.endsWith(`.${zoneName}`)) return value;
  return `${value}.${zoneName}`;
}

export function normalizeType(type: string): string {
  return type.trim().toUpperCase();
}

function unquote(value: string): string {
  // Cloudflare stores TXT content as typed, so a record may come back
  // wrapped in quotes or split into quoted chunks ("a" "b").
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  return [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1])
    .join("");
}

/** Content as DNS sees it, for no-op detection. */
export function normalizeContent(type: string, content: string): string {
  if (type === "TXT") return unquote(content).replace(/\s+/g, " ").trim();
  if (type === "CNAME" || type === "MX" || type === "NS") {
    return content.trim().toLowerCase().replace(/\.$/, "");
  }
  return content.trim().toLowerCase();
}

/** `v=spf1`, `v=DMARC1`, `v=DKIM1` (lowercased), or undefined. */
export function txtTag(content: string): string | undefined {
  return /^v=([a-z0-9]+)/i.exec(unquote(content))?.[0].toLowerCase();
}

export function parseTtl(value: string): number {
  if (value.toLowerCase() === "auto") return 1;
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86400) {
    throw new AxiError(
      `--ttl must be auto or whole seconds from 30 to 86400, got ${value}`,
      "VALIDATION_ERROR",
    );
  }
  return ttl;
}

function parsePriority(value: string): number {
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 0 || priority > 65535) {
    throw new AxiError(
      `--priority must be a whole number from 0 to 65535, got ${value}`,
      "VALIDATION_ERROR",
    );
  }
  return priority;
}

function shorten(content: string, full: boolean): string {
  if (full || content.length <= CONTENT_LIMIT) return content;
  return `${content.slice(0, CONTENT_LIMIT)}…(${content.length} chars)`;
}

export function toRecordRows(
  records: DnsRecord[],
  full = false,
): Record<string, unknown>[] {
  return records.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    content: shorten(
      r.priority !== undefined && r.type === "MX"
        ? `${r.priority} ${r.content}`
        : r.content,
      full,
    ),
    ttl: r.ttl === 1 ? "auto" : r.ttl,
    proxied: r.proxied ?? false,
  }));
}

export interface SetRequest {
  type: string;
  name: string;
  content: string;
  id?: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

export type SetPlan =
  | { kind: "create" }
  | { kind: "noop"; record: DnsRecord }
  | { kind: "update"; record: DnsRecord };

/**
 * Pick the record `set` acts on from the records already at (type, name).
 * TXT records share names routinely (SPF next to site verification), so a
 * TXT whose content carries a `v=` tag only matches the same tag; that also
 * enforces one SPF record per name (RFC 7208 3.2). Anything still ambiguous
 * is refused with the candidates listed, never guessed.
 */
export function planSet(existing: DnsRecord[], req: SetRequest): SetPlan {
  let candidates = existing.filter(
    (r) => r.type === req.type && r.name.toLowerCase() === req.name,
  );
  if (req.id !== undefined) {
    const record = candidates.find((r) => r.id === req.id);
    if (!record) {
      throw new AxiError(
        `No ${req.type} record ${req.name} has id ${req.id}`,
        "NOT_FOUND",
        [
          `Run \`cloudflare-axi dns list --type ${req.type} --name ${req.name} --zone <domain>\` to see the ids`,
        ],
      );
    }
    candidates = [record];
  } else if (req.type === "TXT") {
    const tag = txtTag(req.content);
    if (tag) candidates = candidates.filter((r) => txtTag(r.content) === tag);
  }

  if (candidates.length === 0) return { kind: "create" };
  if (candidates.length > 1) {
    throw new AxiError(
      `${candidates.length} ${req.type} records named ${req.name} match; refusing to pick one`,
      "VALIDATION_ERROR",
      [
        ...candidates.map((r) => `id ${r.id}: ${shorten(r.content, false)}`),
        "Re-run with --id <record-id> to update one of them",
      ],
    );
  }
  const record = candidates[0];
  const same =
    normalizeContent(req.type, record.content) ===
      normalizeContent(req.type, req.content) &&
    (req.ttl === undefined || req.ttl === record.ttl) &&
    (req.proxied === undefined || req.proxied === (record.proxied ?? false)) &&
    (req.priority === undefined || req.priority === record.priority);
  return same ? { kind: "noop", record } : { kind: "update", record };
}

/** POST body for a new record. */
export function createBody(req: SetRequest): Record<string, unknown> {
  return {
    type: req.type,
    name: req.name,
    content: req.content,
    ttl: req.ttl ?? 1,
    ...(PROXIABLE_TYPES.has(req.type) ? { proxied: req.proxied ?? false } : {}),
    ...(req.priority !== undefined ? { priority: req.priority } : {}),
  };
}

/** PATCH body: only what was asked for changes; comment, tags, etc. are kept. */
export function patchBody(req: SetRequest): Record<string, unknown> {
  return {
    content: req.content,
    ...(req.ttl !== undefined ? { ttl: req.ttl } : {}),
    ...(req.proxied !== undefined ? { proxied: req.proxied } : {}),
    ...(req.priority !== undefined ? { priority: req.priority } : {}),
  };
}

function describe(record: DnsRecord): string {
  const ttl = record.ttl === 1 ? "auto" : `${record.ttl}s`;
  const prefix =
    record.type === "MX" && record.priority !== undefined
      ? `${record.priority} `
      : "";
  const proxied = record.proxied ? ", proxied" : "";
  return `${prefix}${record.content} (ttl ${ttl}${proxied})`;
}

// ---- API calls ----

/**
 * The wrangler OAuth token has no DNS scope and `wrangler login` cannot
 * grant one (issue #4), so the generic "re-run wrangler login" advice is
 * wrong here. Rewrite AUTH failures with the token that actually works.
 */
export function dnsAuthError(error: unknown, write: boolean): unknown {
  if (!(error instanceof AxiError) || error.code !== "AUTH") return error;
  const permission = write ? "Zone > DNS > Edit" : "Zone > DNS > Read";
  const usingEnv = Boolean(process.env.CLOUDFLARE_API_TOKEN?.trim());
  return new AxiError(error.message, "AUTH", [
    usingEnv
      ? `CLOUDFLARE_API_TOKEN needs ${permission} for this zone; edit the token at https://dash.cloudflare.com/profile/api-tokens`
      : `The \`wrangler login\` token cannot read or edit DNS. Create an API token with ${permission} for this zone at https://dash.cloudflare.com/profile/api-tokens, then export CLOUDFLARE_API_TOKEN=<token>`,
  ]);
}

async function fetchRecords(
  zone: ZoneRef,
  filter: { type?: string; name?: string },
  write = false,
): Promise<DnsRecord[]> {
  const query = new URLSearchParams({ per_page: String(LIST_LIMIT) });
  if (filter.type) query.set("type", filter.type);
  if (filter.name) query.set("name", filter.name);
  try {
    return await cfGet<DnsRecord[]>(
      `/zones/${zone.id}/dns_records?${query.toString()}`,
    );
  } catch (error) {
    throw dnsAuthError(error, write);
  }
}

// ---- subcommands ----

async function listCommand(
  zone: ZoneRef,
  type: string | undefined,
  name: string | undefined,
  full: boolean,
): Promise<string> {
  const records = await fetchRecords(zone, { type, name });
  const filters = [type && `type ${type}`, name && `name ${name}`]
    .filter(Boolean)
    .join(", ");
  const scope = `${zone.name}${filters ? ` (${filters})` : ""}`;
  if (records.length === 0) {
    return renderOutput([
      `records: 0 DNS records in ${scope}`,
      renderHelp([
        `Run \`cloudflare-axi dns set <type> <name> <content> --zone ${zone.name}\` to add one`,
      ]),
    ]);
  }
  const hints: string[] = [];
  if (records.length >= LIST_LIMIT) {
    hints.push(
      `Showing the first ${LIST_LIMIT}; narrow with --type and --name`,
    );
  }
  if (!full && records.some((r) => r.content.length > CONTENT_LIMIT)) {
    hints.push("Long content is shortened; add --full to see it whole");
  }
  hints.push(
    `Run \`cloudflare-axi dns set <type> <name> <content> --zone ${zone.name}\` to change a record`,
  );
  return renderOutput([
    `count: ${records.length} DNS records in ${scope}`,
    renderList("records", toRecordRows(records, full)),
    renderHelp(hints),
  ]);
}

async function setCommand(zone: ZoneRef, req: SetRequest): Promise<string> {
  const existing = await fetchRecords(
    zone,
    { type: req.type, name: req.name },
    true,
  );
  const plan = planSet(existing, req);
  if (
    plan.kind === "create" &&
    req.type === "MX" &&
    req.priority === undefined
  ) {
    throw new AxiError(
      "--priority is required to create an MX record",
      "VALIDATION_ERROR",
      [
        `cloudflare-axi dns set MX ${req.name} <mail-host> --priority 10 --zone ${zone.name}`,
      ],
    );
  }

  let after: DnsRecord;
  try {
    after =
      plan.kind === "create"
        ? await cfRequest<DnsRecord>(
            "POST",
            `/zones/${zone.id}/dns_records`,
            createBody(req),
          )
        : plan.kind === "update"
          ? await cfRequest<DnsRecord>(
              "PATCH",
              `/zones/${zone.id}/dns_records/${plan.record.id}`,
              patchBody(req),
            )
          : plan.record;
  } catch (error) {
    throw dnsAuthError(error, true);
  }

  const hints: string[] = [];
  if (plan.kind === "noop") {
    hints.push(
      `${req.type} ${req.name} already has this content; nothing changed`,
    );
  }
  if (req.type === "TXT" && txtTag(req.content) === "v=spf1") {
    hints.push(
      "SPF allows at most 10 DNS lookups (each include: counts); a receiver treats more as a permanent error",
    );
  }
  hints.push(
    `Run \`cloudflare-axi dns list --type ${req.type} --name ${req.name} --zone ${zone.name}\` to confirm`,
  );
  return renderOutput([
    encode({
      zone: zone.name,
      changed: plan.kind !== "noop",
      action: plan.kind,
      id: after.id,
      type: after.type,
      name: after.name,
      ...(plan.kind === "update" ? { before: describe(plan.record) } : {}),
      after: describe(after),
    }),
    renderHelp(hints),
  ]);
}

export async function dnsCommand(args: string[]): Promise<string> {
  const rest = [...args];
  const zoneArg = takeFlag(rest, "--zone");
  const typeArg = takeFlag(rest, "--type");
  const nameArg = takeFlag(rest, "--name");
  const idArg = takeFlag(rest, "--id");
  const ttlArg = takeFlag(rest, "--ttl");
  const priorityArg = takeFlag(rest, "--priority");
  const proxiedGiven = rest.some(
    (a) => a === "--proxied" || a.startsWith("--proxied="),
  );
  const proxied = takeBoolFlag(rest, "--proxied");
  const full = takeBoolFlag(rest, "--full");
  // Only the first positional is the subcommand; `set` content may itself
  // start with "-" in theory, but real record content never does.
  const sub = takePositional(rest);
  if (sub !== undefined && sub !== "list" && sub !== "set") {
    throw new AxiError(
      `unknown subcommand ${sub} for \`dns\``,
      "VALIDATION_ERROR",
      [USAGE, "cloudflare-axi dns --help"],
    );
  }
  const command = sub ? `dns ${sub}` : "dns";
  const positionals: string[] = [];
  if (sub === "set") {
    for (let i = 0; i < 3; i++) {
      const value = takePositional(rest);
      if (value === undefined) break;
      positionals.push(value);
    }
  }
  rejectExtraArgs(command, rest, USAGE);

  const listOnly = {
    "--type": typeArg,
    "--name": nameArg,
    "--full": full || undefined,
  };
  const setOnly = {
    "--id": idArg,
    "--ttl": ttlArg,
    "--priority": priorityArg,
    "--proxied": proxiedGiven || undefined,
  };
  const misplaced = Object.entries(sub === "set" ? listOnly : setOnly)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  if (misplaced.length > 0) {
    throw new AxiError(
      `${misplaced.join(", ")} not valid for \`${command}\``,
      "VALIDATION_ERROR",
      [USAGE, "cloudflare-axi dns --help"],
    );
  }

  if (sub === "set" && positionals.length < 3) {
    throw new AxiError(
      "set needs <type> <name> <content>",
      "VALIDATION_ERROR",
      [
        "cloudflare-axi dns set <type> <name> <content> --zone <domain>",
        'Quote content with spaces: "v=spf1 include:_spf.google.com ~all"',
      ],
    );
  }
  if (!zoneArg) {
    throw new AxiError("--zone is required", "VALIDATION_ERROR", [
      `cloudflare-axi ${command} --zone <domain|zone-id>`,
    ]);
  }

  // Validate everything that needs no network before resolving the zone.
  let partial: (Omit<SetRequest, "name"> & { rawName: string }) | undefined;
  if (sub === "set") {
    const type = normalizeType(positionals[0]);
    if (!SETTABLE_TYPES.includes(type)) {
      throw new AxiError(
        `set supports ${SETTABLE_TYPES.join(", ")}; got ${positionals[0]}`,
        "VALIDATION_ERROR",
        ["Edit other record types (SRV, CAA, ...) in the Cloudflare dashboard"],
      );
    }
    if (proxiedGiven && !PROXIABLE_TYPES.has(type)) {
      throw new AxiError(
        `--proxied applies only to A, AAAA, CNAME; not ${type}`,
        "VALIDATION_ERROR",
      );
    }
    if (priorityArg !== undefined && type !== "MX") {
      throw new AxiError(
        `--priority applies only to MX; not ${type}`,
        "VALIDATION_ERROR",
      );
    }
    const content = positionals[2].trim();
    if (content === "") {
      throw new AxiError("record content is empty", "VALIDATION_ERROR", [
        USAGE,
      ]);
    }
    partial = {
      type,
      rawName: positionals[1],
      content,
      id: idArg,
      ttl: ttlArg !== undefined ? parseTtl(ttlArg) : undefined,
      proxied: proxiedGiven ? proxied : undefined,
      priority:
        priorityArg !== undefined ? parsePriority(priorityArg) : undefined,
    };
  }

  const zone = await resolveZone(zoneArg);
  if (partial) {
    const { rawName, ...req } = partial;
    return setCommand(zone, { ...req, name: qualifyName(rawName, zone.name) });
  }
  return listCommand(
    zone,
    typeArg ? normalizeType(typeArg) : undefined,
    nameArg ? qualifyName(nameArg, zone.name) : undefined,
    full,
  );
}
