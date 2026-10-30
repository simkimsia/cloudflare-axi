import { rejectExtraArgs, takeBoolFlag, takeFlag } from "../args.js";
import {
  configArgs,
  configRunOptions,
  configSource,
  configSuffix,
  configWorkerName,
  findWranglerConfig,
  takeConfig,
  withConfigContext,
} from "../config.js";
import {
  AxiError,
  mapWranglerError,
  stripAnsi,
  wranglerNotInstalledError,
} from "../errors.js";
import { encode, renderHelp, renderList, renderOutput } from "../toon.js";
import { wranglerStream } from "../wrangler.js";
import { carryConfig } from "./workers.js";

export const TAIL_USAGE =
  "cloudflare-axi workers tail [--name <worker>] [--config <path>] [--for <30s|5m>] [--max-events <n>] [--status ok|error|canceled] [--cron]";

/** Default and bounds of the tail window (`--for`). */
export const TAIL_DEFAULT_SECONDS = 60;
export const TAIL_MIN_SECONDS = 5;
export const TAIL_MAX_SECONDS = 30 * 60;
/** Default and bounds of `--max-events`. */
export const TAIL_DEFAULT_EVENTS = 50;
export const TAIL_MAX_EVENTS = 500;

/** Per-event caps so one chatty invocation cannot flood the output. */
const MAX_LOG_LINES = 5;
const MAX_TEXT = 200;

const STATUSES = ["ok", "error", "canceled"] as const;

// ---- pure helpers (exported for tests) ----

/** "30s", "5m", "1h" or bare seconds -> seconds; VALIDATION_ERROR outside the bounds. */
export function parseDuration(value: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(value.trim());
  const seconds = m
    ? Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1)
    : NaN;
  if (
    !Number.isFinite(seconds) ||
    seconds < TAIL_MIN_SECONDS ||
    seconds > TAIL_MAX_SECONDS
  ) {
    throw new AxiError(
      `--for must be a duration from ${TAIL_MIN_SECONDS}s to ${TAIL_MAX_SECONDS / 60}m, got ${value}`,
      "VALIDATION_ERROR",
      ["Use `--for 90s` or `--for 6m` (s, m or h; bare numbers are seconds)"],
    );
  }
  return seconds;
}

export function formatSeconds(seconds: number): string {
  return seconds % 60 === 0 && seconds >= 60
    ? `${seconds / 60}m`
    : `${seconds}s`;
}

/**
 * Splits wrangler's `tail --format json` stdout into event objects. wrangler
 * prints each event as indented multi-line JSON (`JSON.stringify(e, null, 4)`)
 * with nothing between them, so this tracks brace depth outside strings
 * across chunks. Text outside objects is retained in a bounded buffer so
 * `strayMessages()` can recover wrangler's JSON-string fatal errors.
 */
export class JsonObjectStream {
  private buffer = "";
  private depth = 0;
  private inString = false;
  private escaped = false;
  private outside = "";

  push(chunk: string): unknown[] {
    const out: unknown[] = [];
    for (const ch of chunk) {
      if (this.depth === 0) {
        if (ch !== "{") {
          this.outside = (this.outside + ch).slice(-4096);
          continue;
        }
        this.buffer = "";
      }
      this.buffer += ch;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === "{") this.depth++;
      else if (ch === "}") {
        this.depth--;
        if (this.depth === 0) {
          try {
            out.push(JSON.parse(this.buffer));
          } catch {
            // not an event; skip it
          }
          this.buffer = "";
        }
      }
    }
    return out;
  }

  /**
   * Bare JSON strings printed outside any event. In json mode wrangler
   * prints its fatal errors that way, e.g. "Unable to reconnect to the
   * tail for x after 5 attempts. ...".
   */
  strayMessages(): string[] {
    const messages: string[] = [];
    for (const line of this.outside.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('"')) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "string" && parsed.trim()) messages.push(parsed);
      } catch {
        // not a JSON string
      }
    }
    return messages;
  }
}

/** One tail event as wrangler prints it (trace-v1 `TailEventMessage`). */
export interface TailEvent {
  outcome?: string;
  scriptName?: string | null;
  eventTimestamp?: number | null;
  wallTime?: number;
  entrypoint?: string;
  event?: Record<string, unknown> | null;
  logs?: { level?: string; message?: unknown[] }[];
  exceptions?: { name?: string; message?: unknown }[];
}

/** Cloudflare's notice that it is sampling the tail ("overload"), not an invocation. */
export function tailInfoMessage(event: TailEvent): string | undefined {
  const e = event.event;
  if (e && typeof e.type === "string" && typeof e.message === "string") {
    return e.message;
  }
  return undefined;
}

export function isCronEvent(event: TailEvent): boolean {
  return Boolean(event.event && "cron" in event.event);
}

/**
 * Defense in depth for console lines: mask values that look like
 * credentials. Headers are never printed at all.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}(?![\w-])/g, "<redacted>")
    .replace(
      /\b(authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|token|secret|password)(["']?\s*[:=]\s*["']?)([^\s"',;&}]+)/gi,
      "$1$2<redacted>",
    );
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

function show(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Path only: the query string can carry tokens, so it is reduced to "?…", and the path is redacted. */
export function safePath(url: string): string {
  let path: string;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    const q = url.indexOf("?");
    path = q === -1 ? url : `${url.slice(0, q)}?…`;
  }
  return redactSecrets(path);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** What invoked the Worker, in one short phrase (same cases as wrangler's pretty printer). */
export function describeTrigger(event: TailEvent): string {
  const e = event.event ?? {};
  if ("cron" in e) return `cron "${show(e.cron)}"`;
  if ("request" in e) {
    const req = (e.request ?? {}) as { method?: unknown; url?: unknown };
    const method = str(req.method)?.toUpperCase() ?? "?";
    const url = str(req.url);
    return `fetch ${method} ${url ? safePath(url) : "(missing request)"}`;
  }
  if ("mailFrom" in e) return "email";
  if ("queue" in e) {
    const n = typeof e.batchSize === "number" ? e.batchSize : "?";
    return `queue ${show(e.queue)} (${n} messages)`;
  }
  if ("rpcMethod" in e) {
    return `rpc ${event.entrypoint ?? "?"}.${show(e.rpcMethod)}`;
  }
  if ("consumedEvents" in e) return "tail";
  if ("scheduledTime" in e) return "alarm";
  return "unknown";
}

function eventTime(event: TailEvent): string {
  const e = event.event ?? {};
  const ts =
    typeof event.eventTimestamp === "number"
      ? event.eventTimestamp
      : typeof e.scheduledTime === "number"
        ? e.scheduledTime
        : undefined;
  if (ts === undefined) return "unknown";
  const d = new Date(ts);
  return isNaN(d.getTime())
    ? "unknown"
    : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function responseStatus(event: TailEvent): string {
  const res = event.event?.response as { status?: unknown } | undefined;
  return typeof res?.status === "number" ? String(res.status) : "-";
}

function renderLogs(event: TailEvent): string {
  const logs = event.logs ?? [];
  if (logs.length === 0) return "none";
  const lines = logs
    .slice(0, MAX_LOG_LINES)
    .map(
      (l) =>
        `${l.level ?? "log"}: ${clip(redactSecrets((l.message ?? []).map(show).join(" ")))}`,
    );
  if (logs.length > MAX_LOG_LINES) {
    lines.push(`+${logs.length - MAX_LOG_LINES} more`);
  }
  return lines.join(" | ");
}

function renderExceptions(event: TailEvent): string {
  const exceptions = event.exceptions ?? [];
  if (exceptions.length === 0) return "none";
  return exceptions
    .map((x) =>
      clip(redactSecrets(`${x.name ?? "Error"}: ${show(x.message ?? "")}`)),
    )
    .join(" | ");
}

export function isErrorOutcome(event: TailEvent): boolean {
  return (
    (event.exceptions?.length ?? 0) > 0 ||
    (event.outcome !== undefined &&
      event.outcome !== "ok" &&
      event.outcome !== "canceled")
  );
}

/** One `workers tail` row. Never includes request headers, cf data or the query string. */
export function toTailRow(
  event: TailEvent,
  withDuration: boolean,
): Record<string, unknown> {
  return {
    time: eventTime(event),
    trigger: describeTrigger(event),
    outcome: event.outcome ?? "unknown",
    status: responseStatus(event),
    ...(withDuration
      ? {
          ms:
            typeof event.wallTime === "number"
              ? Math.round(event.wallTime)
              : "-",
        }
      : {}),
    logs: renderLogs(event),
    exceptions: renderExceptions(event),
  };
}

function parseStatuses(value: string | undefined): string[] {
  if (value === undefined) return [];
  const statuses = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = statuses.filter(
    (s) => !(STATUSES as readonly string[]).includes(s),
  );
  if (statuses.length === 0 || bad.length > 0) {
    throw new AxiError(
      `--status takes ${STATUSES.join(", ")} (comma-separated), got ${value}`,
      "VALIDATION_ERROR",
      [TAIL_USAGE],
    );
  }
  return [...new Set(statuses)];
}

function parseMaxEvents(value: string | undefined): number {
  if (value === undefined) return TAIL_DEFAULT_EVENTS;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > TAIL_MAX_EVENTS) {
    throw new AxiError(
      `--max-events must be a whole number from 1 to ${TAIL_MAX_EVENTS}, got ${value}`,
      "VALIDATION_ERROR",
      [TAIL_USAGE],
    );
  }
  return n;
}

// ---- command ----

type StopReason = "time limit" | "max events" | "interrupted";

export async function workersTail(args: string[]): Promise<string> {
  const name = takeFlag(args, "--name");
  const config = takeConfig(args);
  const forFlag = takeFlag(args, "--for");
  const maxFlag = takeFlag(args, "--max-events");
  const statusFlag = takeFlag(args, "--status");
  const cronOnly = takeBoolFlag(args, "--cron");
  rejectExtraArgs("workers tail", args, TAIL_USAGE);

  const seconds =
    forFlag === undefined ? TAIL_DEFAULT_SECONDS : parseDuration(forFlag);
  const maxEvents = parseMaxEvents(maxFlag);
  const statuses = parseStatuses(statusFlag);
  const suffix = configSuffix(config);

  const wranglerArgs = [
    "tail",
    ...(name ? [name] : []),
    "--format",
    "json",
    ...statuses.flatMap((s) => ["--status", s]),
    ...configArgs(config),
  ];

  const kept: TailEvent[] = [];
  const notices = new Set<string>();
  let skipped = 0;
  let workerName = name ?? nameFromConfig(config);
  let stopReason: StopReason | undefined;
  const parser = new JsonObjectStream();

  const handle = wranglerStream(wranglerArgs, {
    ...configRunOptions(config),
    onStdout: (chunk) => {
      for (const obj of parser.push(chunk)) {
        if (kept.length >= maxEvents) return;
        const event = obj as TailEvent;
        const notice = tailInfoMessage(event);
        if (notice !== undefined) {
          notices.add(clip(notice));
          continue;
        }
        workerName ??= str(event.scriptName);
        if (cronOnly && !isCronEvent(event)) {
          skipped++;
          continue;
        }
        kept.push(event);
        if (kept.length >= maxEvents) {
          stopReason ??= "max events";
          handle.stop();
        }
      }
    },
  });
  const timer = setTimeout(() => {
    stopReason ??= "time limit";
    handle.stop();
  }, seconds * 1000);
  // If the caller interrupts or kills this process, stop wrangler too (so no
  // orphaned tail keeps running) and still print what arrived. A repeated
  // signal SIGKILLs the group at once instead of waiting out the grace.
  // The listeners stay until `done`: with `once`, a second Ctrl-C would hit
  // Node's default handler, which exits without the `exit` event and so
  // leaves the wrangler group running.
  let interrupted = false;
  const interrupt = () => {
    stopReason ??= "interrupted";
    if (interrupted) {
      handle.kill();
      return;
    }
    interrupted = true;
    handle.stop();
  };
  // wrangler runs in its own process group, so a terminal Ctrl-C reaches
  // only this process: forward it from here.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const sig of signals) process.on(sig, interrupt);
  const started = Date.now();
  const result = await handle.done;
  clearTimeout(timer);
  for (const sig of signals) process.removeListener(sig, interrupt);
  const elapsed = Math.round((Date.now() - started) / 1000);

  if (result.notInstalled) throw wranglerNotInstalledError();
  const stray = parser.strayMessages().map(stripAnsi);
  const stderr = [stripAnsi(result.stderr), ...stray]
    .filter(Boolean)
    .join("\n");
  const failed =
    stopReason === undefined &&
    result.exitCode !== 0 &&
    result.exitCode !== null;
  if (failed && kept.length === 0) {
    // Failed before any event: auth, unknown Worker, no Worker configured.
    const error = mapWranglerError(stderr, result.exitCode ?? 1);
    await withConfigContext(config, () => Promise.reject(error)).catch(
      (mapped: unknown) => {
        throw carryConfig(mapped, config);
      },
    );
  }

  const reconnects = (stderr.match(/Tail connection lost/g) ?? []).length;
  const errors = kept.filter(isErrorOutcome).length;
  const withDuration = kept.some((e) => typeof e.wallTime === "number");
  const stopped =
    stopReason ??
    (failed
      ? `wrangler exited with code ${result.exitCode}`
      : "wrangler ended the tail");
  const worker =
    workerName ?? `the Worker configured in ${configSource(config)}`;
  const kind = cronOnly ? "cron events" : "events";

  const help: string[] = [];
  if (failed) {
    const mapped = mapWranglerError(stderr, result.exitCode ?? 1);
    help.push(
      `wrangler exited early: ${clip(mapped.code === "UNKNOWN" && stray.length > 0 ? stray[stray.length - 1] : mapped.message)}`,
    );
  }
  if (reconnects > 0) {
    help.push(
      `The tail reconnected ${reconnects} times; after a reconnect Cloudflare has been seen to stop delivering cron (scheduled) events, so a missing cron here does not prove it did not run`,
    );
  }
  for (const notice of notices) help.push(`Cloudflare: ${notice}`);
  if (stopReason === "max events") {
    help.push(
      `Stopped at --max-events ${maxEvents}; rerun with a higher --max-events (up to ${TAIL_MAX_EVENTS}) or a narrower --status to see more`,
    );
  }
  if (kept.length === 0) {
    help.push(
      cronOnly
        ? `No cron event in the ${formatSeconds(elapsed)} tailed: a cron fires on its schedule, so use a --for longer than its interval (a "*/5 * * * *" cron needs --for 6m)`
        : statuses.length > 0
          ? `No invocations matching --status ${statuses.join(",")} in the ${formatSeconds(elapsed)} tailed; other invocations are filtered out by Cloudflare`
          : `No invocations reached the Worker in the ${formatSeconds(elapsed)} tailed; send it a request, or use a --for longer than its cron interval`,
    );
  }
  help.push(
    "Request headers, cf data and query strings are never shown; console lines are truncated to 200 chars",
  );
  const nameArg = workerName ? ` --name ${workerName}` : "";
  if (!cronOnly) {
    help.push(
      `Run \`cloudflare-axi workers tail${nameArg} --cron --for 6m${suffix}\` to watch only cron (scheduled) events`,
    );
  }
  if (errors === 0 && statuses.length === 0 && kept.length > 0) {
    help.push(
      `Run \`cloudflare-axi workers tail${nameArg} --status error${suffix}\` to see only failed invocations`,
    );
  }

  const summary = encode({
    worker,
    window: `${formatSeconds(seconds)} (ran ${elapsed}s, stopped: ${stopped})`,
    ...(statuses.length > 0 ? { status_filter: statuses.join(",") } : {}),
    count: kept.length,
    errors,
    ...(cronOnly ? { skipped_not_cron: skipped } : {}),
  });
  return renderOutput([
    summary,
    kept.length > 0
      ? renderList(
          "events",
          kept.map((e) => toTailRow(e, withDuration)),
        )
      : `events: 0 ${kind}`,
    renderHelp(help),
  ]);
}

/**
 * The Worker wrangler tails without a name: the top-level `name` of the
 * --config or find-up wrangler config. Best effort; wrangler still decides.
 */
function nameFromConfig(config: string | undefined): string | undefined {
  const path = config ?? findWranglerConfig(process.cwd());
  if (path === undefined) return undefined;
  try {
    return configWorkerName(path);
  } catch {
    return undefined;
  }
}
