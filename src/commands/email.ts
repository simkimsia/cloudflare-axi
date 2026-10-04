import { promises as dns } from "node:dns";
import { cfGet, cfRequest } from "../api.js";
import { rejectExtraArgs, takeFlag, takePositional } from "../args.js";
import { AxiError } from "../errors.js";
import {
  encode,
  relativeTime,
  renderHelp,
  renderList,
  renderOutput,
} from "../toon.js";
import { resolveAccountId, resolveZone, type ZoneRef } from "../zones.js";

export const EMAIL_HELP = `usage: cloudflare-axi email [subcommand] --zone <domain|zone-id>
Email Routing for a zone via the Cloudflare REST API (wrangler has no Email Routing surface).
subcommands[7]:
  read: (none)=routing status + destination addresses + rules, dns, addresses, rules
  write: enable, add-destination <email>, forward <local-part|*> <destination>
flags[1]:
  --zone <domain|zone-id>  apex domain (one lookup) or 32-hex zone id; required except for \`addresses\` and \`add-destination\`
auth: CLOUDFLARE_API_TOKEN if set, else the OAuth token from \`wrangler login\` (needs the email_routing scope; \`wrangler whoami\` lists scopes)
notes:
  \`dns\` shows the MX/SPF/DKIM records Cloudflare expects and checks each against live DNS
  \`addresses\` and \`add-destination\` are account-wide: --zone picks that zone's account, else CLOUDFLARE_ACCOUNT_ID, else the token's sole account
  \`enable\` turns on Email Routing; with the zone's DNS on Cloudflare it also adds the MX/SPF/DKIM records. Already enabled = no-op
  \`add-destination\` makes Cloudflare email a verification link; a destination forwards only after it is clicked. Already listed = no-op
  \`forward '*' <dest>\` sets the catch-all; \`forward hello <dest>\` routes hello@<zone> (a full address on the zone also works). An existing rule for that address is replaced and the old action printed
  \`forward\` checks the destination is listed and verified before calling the API
examples:
  cloudflare-axi email --zone example.com
  cloudflare-axi email dns --zone example.com
  cloudflare-axi email rules --zone example.com
  cloudflare-axi email addresses
  cloudflare-axi email enable --zone example.com
  cloudflare-axi email add-destination you@gmail.com --zone example.com
  cloudflare-axi email forward '*' you@gmail.com --zone example.com
  cloudflare-axi email forward hello you@gmail.com --zone example.com
`;

const USAGE =
  "cloudflare-axi email [dns|addresses|rules|enable|add-destination <email>|forward <local-part|*> <destination>] --zone <domain|zone-id>";

// ---- API shapes (verified live against api.cloudflare.com, 2026-09-04) ----

/** GET /zones/{zone}/email/routing */
export interface EmailRoutingSettings {
  name: string;
  enabled: boolean;
  status?: string;
  synced?: boolean;
  modified?: string;
}

/** GET /zones/{zone}/email/routing/dns entries (the records Cloudflare expects). */
export interface EmailDnsRecord {
  name: string;
  type: string;
  content: string;
  priority?: number;
  ttl?: number;
}

/** GET /accounts/{account}/email/routing/addresses entries. */
export interface EmailAddress {
  id: string;
  email: string;
  status?: string;
  verified?: string | null;
  created?: string;
}

/** GET /zones/{zone}/email/routing/rules entries (catch-all included). */
export interface EmailRule {
  id: string;
  name?: string;
  enabled: boolean;
  priority?: number;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
}

// ---- row shapers (pure; unit-tested offline) ----

export function toAddressRows(
  addresses: EmailAddress[],
): Record<string, unknown>[] {
  return addresses.map((a) => ({
    email: a.email,
    status: a.status ?? (a.verified ? "verified" : "unverified"),
    verified: a.verified ? relativeTime(a.verified) : "no",
  }));
}

export function isCatchAll(rule: EmailRule): boolean {
  return rule.matchers.some((m) => m.type === "all");
}

function describeMatch(rule: EmailRule): string {
  if (isCatchAll(rule)) return "all";
  return rule.matchers
    .map((m) =>
      m.field && m.field !== "to"
        ? `${m.field}=${m.value}`
        : (m.value ?? m.type),
    )
    .join(" & ");
}

function describeAction(rule: EmailRule): string {
  return rule.actions
    .map((a) =>
      a.value && a.value.length > 0 ? `${a.type}→${a.value.join(",")}` : a.type,
    )
    .join(" & ");
}

/** Rules ordered by priority (lowest number first; the catch-all sorts last). */
export function toRuleRows(rules: EmailRule[]): Record<string, unknown>[] {
  return [...rules]
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((r) => ({
      name: r.name ?? (isCatchAll(r) ? "catch-all" : r.id),
      match: describeMatch(r),
      action: describeAction(r),
      enabled: r.enabled,
    }));
}

function addressStatus(a: EmailAddress): string {
  return a.status ?? (a.verified ? "verified" : "unverified");
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function assertEmail(value: string, what: string): string {
  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new AxiError(
      `${what} must be an email address, got ${value}`,
      "VALIDATION_ERROR",
      [USAGE],
    );
  }
  return email;
}

export type DestinationPlan = "create" | "verified" | "pending";

/** `add-destination` is idempotent: an already-listed address is never re-posted. */
export function planDestination(
  addresses: EmailAddress[],
  email: string,
): DestinationPlan {
  const existing = addresses.find((a) => a.email.toLowerCase() === email);
  if (!existing) return "create";
  return addressStatus(existing) === "verified" ? "verified" : "pending";
}

export type ForwardTarget =
  { catchAll: true } | { catchAll: false; address: string };

/**
 * `*` is the catch-all; a bare local part becomes <local>@<zone>; a full
 * address must sit on the zone (or one of its subdomains), since a rule on
 * another domain could never match.
 */
export function parseForwardTarget(
  target: string,
  zoneName: string,
): ForwardTarget {
  if (target === "*") return { catchAll: true };
  const value = target.trim().toLowerCase();
  if (!value.includes("@")) {
    if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(value)) {
      throw new AxiError(
        `${target} is not a valid local part`,
        "VALIDATION_ERROR",
        ["Pass the part before the @, e.g. `hello`, or '*' for the catch-all"],
      );
    }
    return { catchAll: false, address: `${value}@${zoneName}` };
  }
  const address = assertEmail(value, "forward target");
  const domain = address.split("@")[1];
  if (domain !== zoneName && !domain.endsWith(`.${zoneName}`)) {
    throw new AxiError(
      `${address} is not on zone ${zoneName}`,
      "VALIDATION_ERROR",
      [
        `Pass just the local part (e.g. \`hello\`) to route hello@${zoneName}`,
        "Or pass --zone for the domain the address belongs to",
      ],
    );
  }
  return { catchAll: false, address };
}

function forwardsTo(rule: EmailRule, destination: string): boolean {
  return (
    rule.enabled &&
    rule.actions.length === 1 &&
    rule.actions[0].type === "forward" &&
    (rule.actions[0].value ?? []).length === 1 &&
    rule.actions[0].value![0].toLowerCase() === destination
  );
}

export function findRule(
  rules: EmailRule[],
  target: ForwardTarget,
): EmailRule | undefined {
  if (target.catchAll) return rules.find(isCatchAll);
  return rules.find(
    (r) =>
      !isCatchAll(r) &&
      r.matchers.length === 1 &&
      r.matchers[0].type === "literal" &&
      (r.matchers[0].field ?? "to") === "to" &&
      r.matchers[0].value?.toLowerCase() === target.address,
  );
}

export type ForwardPlan =
  | { kind: "noop"; rule: EmailRule }
  | { kind: "create" }
  | { kind: "update"; rule: EmailRule };

/**
 * Decide what `forward` does without touching the API. The destination check
 * runs first so an unverified address fails here with a next step instead of
 * round-tripping to Cloudflare's code 2054.
 */
export function planForward(
  rules: EmailRule[],
  addresses: EmailAddress[],
  target: ForwardTarget,
  destination: string,
): ForwardPlan {
  const plan = planDestination(addresses, destination);
  if (plan === "create") {
    throw new AxiError(
      `${destination} is not a destination address in this account`,
      "NOT_FOUND",
      [
        `Run \`cloudflare-axi email add-destination ${destination}\`, click the link Cloudflare emails, then re-run`,
      ],
    );
  }
  if (plan === "pending") {
    throw new AxiError(
      `Destination ${destination} is not verified yet`,
      "UNVERIFIED",
      [
        `Click the link Cloudflare emailed to ${destination}, then re-run`,
        "Run `cloudflare-axi email addresses` to check its status",
      ],
    );
  }
  const existing = findRule(rules, target);
  if (!existing) {
    // Cloudflare always has a catch-all rule object (disabled by default),
    // so a missing one is still a PUT, never a create.
    return target.catchAll
      ? {
          kind: "update",
          rule: {
            id: "catch_all",
            enabled: false,
            matchers: [{ type: "all" }],
            actions: [],
          },
        }
      : { kind: "create" };
  }
  return forwardsTo(existing, destination)
    ? { kind: "noop", rule: existing }
    : { kind: "update", rule: existing };
}

export function forwardRuleBody(
  target: ForwardTarget,
  destination: string,
  name?: string,
): Omit<EmailRule, "id" | "priority"> {
  return target.catchAll
    ? {
        name: name ?? `catch-all to ${destination}`,
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "forward", value: [destination] }],
      }
    : {
        name: name ?? `${target.address} to ${destination}`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: target.address }],
        actions: [{ type: "forward", value: [destination] }],
      };
}

export type DnsRole = "mx" | "spf" | "dkim" | "dmarc" | "txt" | "other";

export function dnsRole(record: EmailDnsRecord): DnsRole {
  if (record.type === "MX") return "mx";
  if (record.type !== "TXT") return "other";
  const content = unquote(record.content).toLowerCase();
  if (content.startsWith("v=spf1")) return "spf";
  if (content.startsWith("v=dkim1") || record.name.includes("._domainkey"))
    return "dkim";
  if (content.startsWith("v=dmarc1")) return "dmarc";
  return "txt";
}

function unquote(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

/** Long DKIM public keys are noise for an agent; keep a recognizable prefix. */
function compactContent(record: EmailDnsRecord): string {
  const content = unquote(record.content).replace(/\.$/, "");
  const limit = 48;
  return content.length > limit
    ? `${content.slice(0, limit)}…(${content.length} chars)`
    : content;
}

export type LiveState = "ok" | "missing" | "differs" | "unknown";

/** Injectable subset of node:dns/promises so tests stay offline. */
export interface DnsResolver {
  resolveMx(
    hostname: string,
  ): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(hostname: string): Promise<string[][]>;
}

function normalizeHost(value: string): string {
  return unquote(value).toLowerCase().replace(/\.$/, "");
}

function normalizeTxt(value: string): string {
  return unquote(value).replace(/\s+/g, " ").trim();
}

async function tolerate<T>(
  promise: Promise<T>,
): Promise<T | "missing" | "unknown"> {
  try {
    return await promise;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOTFOUND" || code === "ENODATA" || code === "NODATA"
      ? "missing"
      : "unknown";
  }
}

/**
 * Compare each expected record with what public DNS actually serves. This is
 * the "expected vs live" view from the issue: `synced` from the routing
 * status says whether Cloudflare wrote the records, `live` says whether the
 * internet sees them.
 */
export async function checkLiveDns(
  records: EmailDnsRecord[],
  resolver: DnsResolver = dns,
): Promise<LiveState[]> {
  const mxCache = new Map<
    string,
    Awaited<ReturnType<typeof tolerate<{ exchange: string }[]>>>
  >();
  const txtCache = new Map<
    string,
    Awaited<ReturnType<typeof tolerate<string[][]>>>
  >();
  const states: LiveState[] = [];
  for (const record of records) {
    const host = normalizeHost(record.name);
    if (record.type === "MX") {
      if (!mxCache.has(host))
        mxCache.set(host, await tolerate(resolver.resolveMx(host)));
      const live = mxCache.get(host)!;
      if (typeof live === "string") {
        states.push(live);
        continue;
      }
      const want = normalizeHost(record.content);
      states.push(
        live.some((mx) => normalizeHost(mx.exchange) === want)
          ? "ok"
          : "missing",
      );
    } else if (record.type === "TXT") {
      if (!txtCache.has(host))
        txtCache.set(host, await tolerate(resolver.resolveTxt(host)));
      const live = txtCache.get(host)!;
      if (typeof live === "string") {
        states.push(live);
        continue;
      }
      const want = normalizeTxt(record.content);
      const found = live.map((chunks) => normalizeTxt(chunks.join("")));
      if (found.includes(want)) states.push("ok");
      else {
        // Same record family present with different content (e.g. an SPF
        // that lists other senders) is "differs", not "missing".
        const family = want.split(/[\s;]/)[0].toLowerCase();
        states.push(
          found.some((f) => f.toLowerCase().startsWith(family))
            ? "differs"
            : "missing",
        );
      }
    } else {
      states.push("unknown");
    }
  }
  return states;
}

/**
 * Uniform keys per row so TOON renders one tabular block; the MX priority is
 * folded into content zone-file style ("53 route1.mx.cloudflare.net").
 */
export function toDnsRows(
  records: EmailDnsRecord[],
  live?: LiveState[],
): Record<string, unknown>[] {
  return records.map((r, i) => ({
    role: dnsRole(r),
    type: r.type,
    name: r.name,
    content:
      r.type === "MX"
        ? `${r.priority ?? 0} ${compactContent(r)}`
        : compactContent(r),
    ...(live ? { live: live[i] ?? "unknown" } : {}),
  }));
}

// ---- API calls ----

function fetchRouting(zone: ZoneRef): Promise<EmailRoutingSettings> {
  return cfGet<EmailRoutingSettings>(`/zones/${zone.id}/email/routing`);
}

function fetchRules(zone: ZoneRef): Promise<EmailRule[]> {
  return cfGet<EmailRule[]>(
    `/zones/${zone.id}/email/routing/rules?per_page=100`,
  );
}

function fetchAddresses(accountId: string): Promise<EmailAddress[]> {
  return cfGet<EmailAddress[]>(
    `/accounts/${accountId}/email/routing/addresses?per_page=100`,
  );
}

function unverifiedHint(addresses: EmailAddress[]): string[] {
  const pending = addresses.filter((a) => addressStatus(a) !== "verified");
  if (pending.length === 0) return [];
  return [
    `Unverified destination ${pending.map((a) => a.email).join(", ")}: click the link Cloudflare emailed it, then re-run \`cloudflare-axi email addresses\``,
  ];
}

function disabledHint(zone: ZoneRef): string[] {
  return [
    `Email Routing is not enabled for ${zone.name}; run \`cloudflare-axi email enable --zone ${zone.name}\``,
  ];
}

// ---- subcommands ----

async function statusCommand(zone: ZoneRef): Promise<string> {
  const routing = await fetchRouting(zone);
  const blocks: string[] = [
    encode({
      zone: zone.name,
      enabled: routing.enabled,
      status: routing.status ?? "unknown",
      synced: routing.synced ?? "unknown",
    }),
  ];
  if (!routing.enabled) {
    blocks.push(renderHelp(disabledHint(zone)));
    return renderOutput(blocks);
  }

  const [addresses, rules] = await Promise.all([
    fetchAddresses(zone.accountId),
    fetchRules(zone),
  ]);
  blocks.push(
    addresses.length === 0
      ? "addresses: 0 destination addresses in this account"
      : renderList("addresses", toAddressRows(addresses)),
  );
  blocks.push(
    rules.length === 0
      ? "rules: 0 routing rules (no catch-all)"
      : renderList("rules", toRuleRows(rules)),
  );

  const hints = unverifiedHint(addresses);
  if (!routing.synced) {
    hints.push(
      `DNS records are not synced; run \`cloudflare-axi email dns --zone ${zone.name}\` to see which are missing`,
    );
  }
  if (addresses.length === 0) {
    hints.push(
      `No destination addresses yet: run \`cloudflare-axi email add-destination <email> --zone ${zone.name}\``,
    );
  }
  hints.push(
    `Run \`cloudflare-axi email dns --zone ${zone.name}\` for the MX/SPF/DKIM records`,
  );
  blocks.push(renderHelp(hints));
  return renderOutput(blocks);
}

async function dnsCommand(zone: ZoneRef): Promise<string> {
  const [routing, records] = await Promise.all([
    fetchRouting(zone),
    cfGet<EmailDnsRecord[]>(`/zones/${zone.id}/email/routing/dns`),
  ]);
  const live = await checkLiveDns(records);
  const blocks: string[] = [
    encode({
      zone: zone.name,
      enabled: routing.enabled,
      synced: routing.synced ?? "unknown",
    }),
  ];
  if (records.length === 0) {
    blocks.push("records: 0 records expected by Cloudflare");
    blocks.push(renderHelp(routing.enabled ? [] : disabledHint(zone)));
    return renderOutput(blocks);
  }
  blocks.push(renderList("records", toDnsRows(records, live)));

  const hints: string[] = [];
  const missing = records.filter((_, i) => live[i] === "missing");
  const differs = records.filter((_, i) => live[i] === "differs");
  if (missing.length > 0) {
    hints.push(
      `${missing.length} record(s) missing from live DNS: if the zone's DNS is on Cloudflare, re-check in a few minutes (propagation); otherwise add them at your DNS host`,
    );
  }
  if (differs.length > 0) {
    hints.push(
      `${differs.length} record(s) live with different content than Cloudflare's default (${differs.map(dnsRole).join(", ")}); fine if edited on purpose, e.g. an SPF that also lists your outbound sender`,
    );
  }
  if (records.every((_, i) => live[i] === "ok")) {
    hints.push("All expected records are live");
  }
  hints.push(
    `Run \`cloudflare-axi email --zone ${zone.name}\` for routing status, addresses, and rules`,
  );
  blocks.push(renderHelp(hints));
  return renderOutput(blocks);
}

async function addressesCommand(zone: ZoneRef | undefined): Promise<string> {
  const accountId = zone ? zone.accountId : await resolveAccountId();
  const addresses = await fetchAddresses(accountId);
  if (addresses.length === 0) {
    return renderOutput([
      `addresses: 0 destination addresses in account ${accountId}`,
      renderHelp([
        "Run `cloudflare-axi email add-destination <email>` to add one (Cloudflare emails it a verification link)",
      ]),
    ]);
  }
  return renderOutput([
    `count: ${addresses.length} destination addresses (account ${zone?.accountName ?? accountId})`,
    renderList("addresses", toAddressRows(addresses)),
    renderHelp([
      ...unverifiedHint(addresses),
      "Run `cloudflare-axi email rules --zone <domain>` to see which rules forward to these",
    ]),
  ]);
}

async function rulesCommand(zone: ZoneRef): Promise<string> {
  const rules = await fetchRules(zone);
  const catchAll = rules.find(isCatchAll);
  if (rules.length === 0) {
    return renderOutput([
      `rules: 0 routing rules for ${zone.name} (no catch-all)`,
      renderHelp([
        `Run \`cloudflare-axi email --zone ${zone.name}\` to check Email Routing is enabled`,
        `Run \`cloudflare-axi email forward '*' <destination> --zone ${zone.name}\` to set the catch-all`,
      ]),
    ]);
  }
  return renderOutput([
    `count: ${rules.length} routing rules for ${zone.name} (catch-all: ${catchAll ? (catchAll.enabled ? "enabled" : "disabled") : "none"})`,
    renderList("rules", toRuleRows(rules)),
    renderHelp([
      "Rules are evaluated top to bottom; the catch-all applies only when no other rule matches",
      `Run \`cloudflare-axi email addresses --zone ${zone.name}\` to check destinations are verified`,
    ]),
  ]);
}

async function enableCommand(zone: ZoneRef): Promise<string> {
  const before = await fetchRouting(zone);
  const after = before.enabled
    ? before
    : await cfRequest<EmailRoutingSettings>(
        "POST",
        `/zones/${zone.id}/email/routing/enable`,
        {},
      );
  return renderOutput([
    encode({
      zone: zone.name,
      changed: !before.enabled,
      enabled: after.enabled,
      status: after.status ?? "unknown",
      synced: after.synced ?? "unknown",
    }),
    renderHelp([
      ...(before.enabled
        ? [
            `Email Routing was already enabled for ${zone.name}; nothing changed`,
          ]
        : []),
      `Run \`cloudflare-axi email dns --zone ${zone.name}\` to confirm the MX/SPF/DKIM records are live`,
      `Run \`cloudflare-axi email add-destination <email> --zone ${zone.name}\` to add where mail should go`,
    ]),
  ]);
}

async function addDestinationCommand(
  email: string,
  zone: ZoneRef | undefined,
): Promise<string> {
  const accountId = zone ? zone.accountId : await resolveAccountId();
  const addresses = await fetchAddresses(accountId);
  const plan = planDestination(addresses, email);
  if (plan === "create") {
    await cfRequest<EmailAddress>(
      "POST",
      `/accounts/${accountId}/email/routing/addresses`,
      { email },
    );
  }
  const status = plan === "verified" ? "verified" : "unverified";
  const hints: string[] = [];
  if (plan === "create") {
    hints.push(
      `Cloudflare emailed a verification link to ${email}; click it, then run \`cloudflare-axi email addresses\` to confirm`,
    );
  } else if (plan === "pending") {
    hints.push(
      `${email} was already added but is not verified; click the link Cloudflare emailed it (resend from the dashboard: Email > Email Routing > Destination addresses)`,
    );
  } else {
    hints.push(`${email} was already added and verified; nothing changed`);
  }
  hints.push(
    `Then run \`cloudflare-axi email forward <local-part|*> ${email} --zone <domain>\` to route mail to it`,
  );
  return renderOutput([
    encode({
      email,
      changed: plan === "create",
      status,
      account: zone?.accountName ?? accountId,
    }),
    renderHelp(hints),
  ]);
}

async function forwardCommand(
  zone: ZoneRef,
  targetArg: string,
  destination: string,
): Promise<string> {
  const target = parseForwardTarget(targetArg, zone.name);
  const [routing, rules, addresses] = await Promise.all([
    fetchRouting(zone),
    fetchRules(zone),
    fetchAddresses(zone.accountId),
  ]);
  const plan = planForward(rules, addresses, target, destination);
  const matchLabel = target.catchAll ? "all (catch-all)" : target.address;

  let previous: string | undefined;
  if (plan.kind === "create") {
    await cfRequest<EmailRule>(
      "POST",
      `/zones/${zone.id}/email/routing/rules`,
      forwardRuleBody(target, destination),
    );
  } else if (plan.kind === "update") {
    if (plan.rule.actions.length > 0) {
      previous = `${describeAction(plan.rule)}${plan.rule.enabled ? "" : " (disabled)"}`;
    }
    // Keep a user-chosen rule name; only default-named rules get renamed.
    const keepName =
      plan.rule.name && !/ to [^ ]+@[^ ]+$/.test(plan.rule.name)
        ? plan.rule.name
        : undefined;
    const path = target.catchAll
      ? `/zones/${zone.id}/email/routing/rules/catch_all`
      : `/zones/${zone.id}/email/routing/rules/${plan.rule.id}`;
    await cfRequest<EmailRule>(
      "PUT",
      path,
      forwardRuleBody(target, destination, keepName),
    );
  }

  const hints: string[] = [];
  if (plan.kind === "noop") {
    hints.push(
      `${matchLabel} already forwards to ${destination}; nothing changed`,
    );
  }
  if (!routing.enabled) {
    hints.push(
      `Email Routing is not enabled for ${zone.name}, so this rule does nothing yet; run \`cloudflare-axi email enable --zone ${zone.name}\``,
    );
  }
  hints.push(
    `Run \`cloudflare-axi email rules --zone ${zone.name}\` to see every rule in order`,
  );
  return renderOutput([
    encode({
      zone: zone.name,
      changed: plan.kind !== "noop",
      match: matchLabel,
      action: `forward→${destination}`,
      ...(previous ? { previous } : {}),
    }),
    renderHelp(hints),
  ]);
}

const SUBCOMMANDS = [
  "dns",
  "addresses",
  "rules",
  "enable",
  "add-destination",
  "forward",
] as const;
type EmailSubcommand = (typeof SUBCOMMANDS)[number];

export async function emailCommand(args: string[]): Promise<string> {
  const rest = [...args];
  const zoneArg = takeFlag(rest, "--zone");
  const sub = takePositional(rest);
  if (sub !== undefined && !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new AxiError(
      `unknown subcommand ${sub} for \`email\``,
      "VALIDATION_ERROR",
      [USAGE, "cloudflare-axi email --help"],
    );
  }
  const positionals: string[] = [];
  const arity = sub === "add-destination" ? 1 : sub === "forward" ? 2 : 0;
  for (let i = 0; i < arity; i++) {
    const value = takePositional(rest);
    if (value === undefined) break;
    positionals.push(value);
  }
  rejectExtraArgs(sub ? `email ${sub}` : "email", rest, USAGE);
  if (positionals.length < arity) {
    throw new AxiError(
      sub === "forward"
        ? "forward needs <local-part|*> and <destination>"
        : "add-destination needs an <email>",
      "VALIDATION_ERROR",
      [
        sub === "forward"
          ? "cloudflare-axi email forward <local-part|*> <destination> --zone <domain>"
          : "cloudflare-axi email add-destination <email> [--zone <domain>]",
      ],
    );
  }

  if (sub === "addresses" || sub === "add-destination") {
    // Validate before any network call.
    const email =
      sub === "add-destination"
        ? assertEmail(positionals[0], "destination")
        : undefined;
    const zone = zoneArg ? await resolveZone(zoneArg) : undefined;
    return email ? addDestinationCommand(email, zone) : addressesCommand(zone);
  }

  if (!zoneArg) {
    const command = sub ? `email ${sub}` : "email";
    throw new AxiError("--zone is required", "VALIDATION_ERROR", [
      `cloudflare-axi ${command} --zone <domain|zone-id>`,
    ]);
  }
  const destination =
    sub === "forward" ? assertEmail(positionals[1], "destination") : undefined;
  const zone = await resolveZone(zoneArg);
  switch (sub as EmailSubcommand | undefined) {
    case "enable":
      return enableCommand(zone);
    case "forward":
      return forwardCommand(zone, positionals[0], destination!);
    case "dns":
      return dnsCommand(zone);
    case "rules":
      return rulesCommand(zone);
    default:
      return statusCommand(zone);
  }
}
