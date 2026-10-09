import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError, mapWranglerError } from "../src/errors.js";

// Drives `kv` subcommands end-to-end through src/wrangler.ts with
// child_process.execFile mocked and through src/api.ts with fetch stubbed,
// asserting the wrangler argv and REST paths used and the rendered output.
// Fixtures are real wrangler 4.127.1 output and api.cloudflare.com envelopes
// captured live 2026-10-09 (read-only calls) or taken from the wrangler
// source (create).

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));

const { kvCommand, classifyValue, truncateValue, bindingNameFor } =
  await import("../src/commands/kv.js");

const SETTINGS_ID = "8cd31376cd9a4223b6c49b94da311025";
const NAMESPACES = [
  {
    id: "47b3635c58cc48c994ae8afd77e6babe",
    title: "ACCESS_TOKENS",
    supports_url_encoding: true,
  },
  { id: SETTINGS_ID, title: "SETTINGS", supports_url_encoding: true },
];
const FEED =
  '{"timestamp":"2026-10-09T16:00:00+08:00","readings":{"north":87,"south":92}}';

const ERR = (body: string) =>
  `\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1m${body}\u001b[0m`;
const KEY_404 = `\n${ERR(
  `Failed to fetch https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/${SETTINGS_ID}/values/missing - 404: Not Found`,
)}\n\n\nIf you think this is a bug then please create an issue`;

interface Reply {
  stdout?: string | Buffer;
  stderr?: string;
  code?: number;
}

/** Map of "space-joined argv prefix" -> reply; longest matching prefix wins. */
let replies: Record<string, Reply>;
let calls: string[][];
let putValues: string[];

// ---- REST stub: the SETTINGS namespace in account "acc" ----
const NS_PATH = `/accounts/acc/storage/kv/namespaces/${SETTINGS_ID}`;
/** Keys the stubbed `GET .../keys` pages through, in name order. */
let apiKeys: { name: string; expiration?: number }[];
/** Values (and so existence) served by `.../values/{key}` and `.../metadata/{key}`. */
let apiValues: Record<string, Buffer>;
/** Every REST path requested, in order. */
let apiCalls: string[];
/** Keys handed out by the keys endpoint, summed over pages. */
let keysServed: number;

const envelope = (status: number, body: object) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
// Real envelopes, captured live 2026-10-09.
const KEY_NOT_FOUND = (op: string) =>
  envelope(404, {
    result: null,
    errors: [{ code: 10009, message: `${op}: 'key not found'` }],
    messages: [],
    success: false,
  });
const NAMESPACE_NOT_FOUND = envelope(404, {
  result: null,
  errors: [{ code: 10013, message: "get namespace: 'namespace not found'" }],
  messages: [],
  success: false,
});

function apiReply(path: string): Response {
  const url = new URL(`https://x${path}`);
  if (!url.pathname.startsWith(NS_PATH)) return NAMESPACE_NOT_FOUND;
  const rest = url.pathname.slice(NS_PATH.length);
  if (rest === "/keys") {
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    if (limit < 10 || limit > 1000) {
      return envelope(400, {
        result: null,
        errors: [
          { code: 10028, message: "limit argument must be at least 10" },
        ],
        success: false,
      });
    }
    const prefix = url.searchParams.get("prefix") ?? "";
    const from = Number(url.searchParams.get("cursor") || 0);
    const matching = apiKeys.filter((k) => k.name.startsWith(prefix));
    const page = matching.slice(from, from + limit);
    keysServed += page.length;
    const next = from + limit < matching.length ? String(from + limit) : "";
    return envelope(200, {
      result: page,
      errors: [],
      messages: [],
      success: true,
      result_info: { count: page.length, cursor: next },
    });
  }
  const [, kind, encoded] = /^\/(values|metadata)\/(.+)$/.exec(rest) ?? [];
  const key = encoded === undefined ? undefined : decodeURIComponent(encoded);
  if (key === undefined || !(key in apiValues)) {
    return KEY_NOT_FOUND(kind === "metadata" ? "metadata" : "get");
  }
  if (kind === "metadata") {
    return envelope(200, {
      result: null,
      errors: [],
      messages: [],
      success: true,
    });
  }
  return new Response(new Uint8Array(apiValues[key]), {
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
  });
}

beforeEach(() => {
  calls = [];
  putValues = [];
  apiKeys = [];
  apiValues = {};
  apiCalls = [];
  keysServed = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      apiCalls.push(path);
      return apiReply(path);
    }),
  );
  replies = { "kv namespace list": { stdout: JSON.stringify(NAMESPACES) } };
  execFile.mockImplementation(
    (
      _file: string,
      args: string[],
      _opts: unknown,
      cb: (e: unknown, out: string | Buffer, err: string) => void,
    ) => {
      calls.push(args);
      if (args[2] === "put") {
        putValues.push(readFileSync(args[args.indexOf("--path") + 1], "utf8"));
      }
      const joined = args.join(" ");
      const match = Object.keys(replies)
        .filter((k) => joined.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const reply = match ? replies[match] : { stdout: "" };
      const error = reply.code
        ? Object.assign(new Error("failed"), { code: reply.code })
        : null;
      cb(error, reply.stdout ?? "", reply.stderr ?? "");
      return {};
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function expectError(
  promise: Promise<unknown>,
  code: string,
  message?: RegExp,
): Promise<AxiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AxiError);
  expect((error as AxiError).code).toBe(code);
  if (message) expect((error as AxiError).message).toMatch(message);
  return error as AxiError;
}

describe("kv (list)", () => {
  it("lists namespaces and points at kv keys", async () => {
    const out = await kvCommand([]);
    expect(out).toContain("count: 2 KV namespaces");
    expect(out).toContain(`SETTINGS,${SETTINGS_ID}`);
    expect(out).toContain("cloudflare-axi kv keys <title>");
  });

  it("rejects an unknown subcommand", async () => {
    await expectError(
      kvCommand(["list"]),
      "VALIDATION_ERROR",
      /unknown subcommand list/,
    );
  });
});

describe("kv create", () => {
  it("creates the namespace without touching the cwd config and prints the binding", async () => {
    // wrangler 4.127.1 kv namespace create stdout (from its source).
    replies["kv namespace create"] = {
      stdout: `Resource location: remote\n🌀 Creating namespace with title "NEW_NS"\n✨ Success!\nTo access your new KV Namespace in your Worker, add the following snippet to your configuration file:\n[[kv_namespaces]]\nbinding = "NEW_NS"\nid = "0123456789abcdef0123456789abcdef"\n`,
    };
    const out = await kvCommand(["create", "NEW_NS"]);
    expect(calls).toEqual([
      ["kv", "namespace", "create", "NEW_NS", "--update-config=false"],
    ]);
    expect(out).toContain("title: NEW_NS");
    expect(out).toContain("id: 0123456789abcdef0123456789abcdef");
    expect(out).toContain("status: created");
    expect(out).toContain(
      'binding = "NEW_NS" and id = "0123456789abcdef0123456789abcdef"',
    );
  });

  it("falls back to the namespace list when the id is not in stdout", async () => {
    replies["kv namespace create"] = { stdout: "✨ Success!\n" };
    const out = await kvCommand(["create", "SETTINGS"]);
    expect(out).toContain(`id: ${SETTINGS_ID}`);
  });

  it("maps a taken title to ALREADY_EXISTS", async () => {
    replies["kv namespace create"] = {
      code: 1,
      stderr: ERR('A KV namespace with the title "SETTINGS" already exists.'),
    };
    await expectError(kvCommand(["create", "SETTINGS"]), "ALREADY_EXISTS");
  });

  it("requires a title and rejects extras", async () => {
    await expectError(
      kvCommand(["create"]),
      "VALIDATION_ERROR",
      /title is required/,
    );
    await expectError(
      kvCommand(["create", "a", "b"]),
      "VALIDATION_ERROR",
      /unexpected argument b/,
    );
    expect(calls).toEqual([]);
  });
});

describe("kv keys", () => {
  beforeEach(() => {
    apiKeys = [
      { name: "feed" },
      { name: "limit:35317871", expiration: 1791590400 },
      { name: "member:1" },
    ];
    replies["kv key list"] = { stdout: JSON.stringify(apiKeys) };
  });

  it("lists a namespace over REST, with the prefix and a bounded page", async () => {
    const out = await kvCommand(["keys", "SETTINGS", "--prefix", "li"]);
    expect(calls).toEqual([["kv", "namespace", "list"]]);
    expect(apiCalls).toEqual([`${NS_PATH}/keys?limit=50&prefix=li`]);
    expect(out).toContain(
      `count: 1 keys in SETTINGS (${SETTINGS_ID}) with prefix li`,
    );
    expect(out).not.toContain("more exist");
    expect(out).toContain('"limit:35317871","2026-10-10T00:00:00.000Z"');
  });

  it("never fetches a large listing beyond --limit", async () => {
    apiKeys = Array.from({ length: 5000 }, (_, i) => ({
      name: `k:${String(i).padStart(5, "0")}`,
    }));
    const out = await kvCommand(["keys", "SETTINGS", "--limit", "3"]);
    // The API's page size floor is 10: one page, cut to 3 rows.
    expect(apiCalls).toEqual([`${NS_PATH}/keys?limit=10`]);
    expect(keysServed).toBe(10);
    expect(out).toContain(
      `count: 3 keys in SETTINGS (${SETTINGS_ID}), more exist`,
    );
    expect(out).toContain("k:00002");
    expect(out).not.toContain("k:00003");
    expect(out).toContain("pass a larger --limit (e.g. --limit 6)");
  });

  it("pages with the cursor until --limit rows, then stops", async () => {
    apiKeys = Array.from({ length: 5000 }, (_, i) => ({
      name: `k:${String(i).padStart(5, "0")}`,
    }));
    const out = await kvCommand(["keys", SETTINGS_ID, "--limit", "1500"]);
    expect(apiCalls).toEqual([
      `${NS_PATH}/keys?limit=1000`,
      `${NS_PATH}/keys?limit=500&cursor=1000`,
    ]);
    expect(keysServed).toBe(1500);
    expect(out).toContain("count: 1500 keys in SETTINGS");
    expect(out).toContain("more exist");
  });

  it("says nothing more exists when the last page ends at --limit", async () => {
    apiKeys = Array.from({ length: 10 }, (_, i) => ({ name: `k:${i}` }));
    const out = await kvCommand(["keys", "SETTINGS", "--limit", "10"]);
    expect(out).toContain("count: 10 keys in SETTINGS");
    expect(out).not.toContain("more exist");
  });

  it("passes --binding to wrangler without a namespace lookup", async () => {
    const out = await kvCommand([
      "keys",
      "--binding",
      "SETTINGS",
      "--limit",
      "1",
    ]);
    expect(calls).toEqual([
      ["kv", "key", "list", "--binding", "SETTINGS", "--remote"],
    ]);
    expect(apiCalls).toEqual([]);
    expect(out).toContain("count: 1 keys in binding SETTINGS");
    expect(out).toContain("more exist");
  });

  it("suggests --namespace when a --binding listing overflows wrangler's buffer", async () => {
    execFile.mockImplementationOnce(
      (_f: string, _a: string[], _o: unknown, cb: (e: unknown) => void) => {
        cb(
          Object.assign(new Error("stdout maxBuffer length exceeded"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
        return {};
      },
    );
    const error = await expectError(
      kvCommand(["keys", "--binding", "SETTINGS"]),
      "UNKNOWN",
      /exceeded 32 MiB/,
    );
    expect(error.suggestions[0]).toContain("Pass --namespace <title|id>");
  });

  it("refuses a dash-prefixed --prefix through --binding before calling wrangler", async () => {
    const error = await expectError(
      kvCommand(["keys", "--binding", "SETTINGS", "--prefix=-feed"]),
      "VALIDATION_ERROR",
      /wrangler reads a value starting with - as a flag/,
    );
    expect(error.suggestions[0]).toContain(
      "kv keys --namespace <title|id> --prefix=-feed",
    );
    expect(calls).toEqual([]);
  });

  it("reports an unknown namespace as NOT_FOUND before listing", async () => {
    await expectError(
      kvCommand(["keys", "settings"]),
      "NOT_FOUND",
      /settings not found/,
    );
    expect(calls).toHaveLength(1);
    expect(apiCalls).toEqual([]);
  });

  it("maps a namespace deleted after resolving (code 10013) to NOT_FOUND", async () => {
    replies["kv namespace list"] = {
      stdout: JSON.stringify([{ id: "f".repeat(32), title: "GONE" }]),
    };
    const error = await expectError(kvCommand(["keys", "GONE"]), "NOT_FOUND");
    expect(error.message).toContain("[code: 10013]");
    expect(error.suggestions[0]).toContain("cloudflare-axi kv");
  });

  it("maps a token without KV access (code 10000) to AUTH", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        envelope(403, {
          result: null,
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
          messages: [],
        }),
      ),
    );
    await expectError(kvCommand(["keys", "SETTINGS"]), "AUTH", /10000/);
  });

  it("rejects both a namespace and a binding", async () => {
    await expectError(
      kvCommand(["keys", "SETTINGS", "--binding", "SETTINGS"]),
      "VALIDATION_ERROR",
      /not both/,
    );
  });

  it("maps a missing binding to NOT_LINKED", async () => {
    replies["kv key list"] = {
      code: 1,
      stderr: ERR(
        'No KV namespace with binding "NOPE" was found in the "kv_namespaces" section of your wrangler config.',
      ),
    };
    await expectError(kvCommand(["keys", "--binding", "NOPE"]), "NOT_LINKED");
  });
});

describe("kv get", () => {
  it("reads a namespace value over REST and pretty-prints JSON with its exact size", async () => {
    apiValues.feed = Buffer.from(FEED);
    const out = await kvCommand(["get", "feed", "--namespace", "SETTINGS"]);
    expect(calls).toEqual([["kv", "namespace", "list"]]);
    expect(apiCalls).toEqual([`${NS_PATH}/values/feed`]);
    expect(out).toContain(`size: ${FEED.length} bytes`);
    expect(out).toContain("format: json");
    expect(out).toContain(
      'value:\n  {\n    "timestamp": "2026-10-09T16:00:00+08:00",',
    );
  });

  it("reads a --binding value through wrangler", async () => {
    replies["kv key get home:1"] = { stdout: Buffer.from("east") };
    const out = await kvCommand(["get", "home:1", "--binding", "SETTINGS"]);
    expect(calls).toEqual([
      ["kv", "key", "get", "home:1", "--binding", "SETTINGS", "--remote"],
    ]);
    expect(out).toContain("format: text");
    expect(out).toContain("value:\n  east");
  });

  it("shows text containing a literal U+FFFD, but not invalid UTF-8", async () => {
    apiValues.note = Buffer.from("bad byte shown as \uFFFD here");
    const text = await kvCommand(["get", "note", "--namespace", "SETTINGS"]);
    expect(text).toContain("format: text");
    expect(text).toContain("bad byte shown as \uFFFD here");
    expect(text).toContain("size: 26 bytes");

    apiValues.raw = Buffer.from([0x68, 0x69, 0xff, 0xfe]);
    const binary = await kvCommand(["get", "raw", "--namespace", "SETTINGS"]);
    expect(binary).toContain("format: binary");
    expect(binary).toContain("size: 4 bytes");
    expect(binary).toContain("value: not shown");
  });

  it("classifies --binding values from wrangler's raw bytes", async () => {
    replies["kv key get img"] = {
      stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    };
    const out = await kvCommand(["get", "img", "--binding", "SETTINGS"]);
    expect(out).toContain("format: binary");
    expect(out).toContain("size: 8 bytes");
  });

  it("truncates a large value unless --full", async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    apiValues.big = Buffer.from(big);
    const out = await kvCommand(["get", "big", "--namespace", "SETTINGS"]);
    // 4000 chars of value plus two spaces of indent per line.
    expect(out.length).toBeLessThan(5500);
    expect(out).toMatch(/Truncated: showing \d+ of \d+ chars/);
    expect(out).toContain("--full");
    const full = await kvCommand([
      "get",
      "big",
      "--namespace",
      "SETTINGS",
      "--full",
    ]);
    expect(full).toContain("line 1999");
    expect(full).not.toContain("Truncated");
  });

  it("maps a missing key in a namespace (code 10009) to a key-specific NOT_FOUND", async () => {
    const error = await expectError(
      kvCommand(["get", "missing", "--namespace", "SETTINGS"]),
      "NOT_FOUND",
      /KV key missing not found in namespace SETTINGS/,
    );
    expect(error.message).not.toContain("binding");
  });

  it("names both causes when a --binding read 404s", async () => {
    replies["kv key get missing"] = { code: 1, stderr: KEY_404 };
    const error = await expectError(
      kvCommand(["get", "missing", "--binding", "SETTINGS"]),
      "NOT_FOUND",
      /the key is missing, or the binding's namespace id no longer exists/,
    );
    expect(error.suggestions[0]).toContain("cloudflare-axi kv");
    expect(error.suggestions[0]).toContain("kv_namespaces entry for SETTINGS");
  });

  it("reads a dash-prefixed key with --key, URL-encoded over REST", async () => {
    apiValues["-feed"] = Buffer.from("dash");
    const out = await kvCommand([
      "get",
      "--key",
      "-feed",
      "--namespace",
      "SETTINGS",
    ]);
    expect(apiCalls).toEqual([`${NS_PATH}/values/-feed`]);
    expect(out).toContain('key: "-feed"');
    expect(out).toContain("value:\n  dash");
    const eq = await kvCommand([
      "get",
      "--key=-feed",
      "--namespace",
      "SETTINGS",
    ]);
    expect(eq).toContain("value:\n  dash");
    apiValues["a/b c"] = Buffer.from("slash");
    await kvCommand(["get", "--key", "a/b c", "--namespace", "SETTINGS"]);
    expect(apiCalls.at(-1)).toBe(`${NS_PATH}/values/a%2Fb%20c`);
  });

  it("refuses a dash-prefixed key through --binding before calling wrangler", async () => {
    const error = await expectError(
      kvCommand(["get", "--key", "-feed", "--binding", "SETTINGS"]),
      "VALIDATION_ERROR",
      /wrangler reads a key starting with - as a flag/,
    );
    expect(error.suggestions[0]).toContain("--namespace");
    expect(calls).toEqual([]);
  });

  it("takes the key exactly once and never a flag as --key's value", async () => {
    await expectError(
      kvCommand(["get", "feed", "--key", "x", "--namespace", "SETTINGS"]),
      "VALIDATION_ERROR",
      /pass the key once/,
    );
    await expectError(
      kvCommand(["get", "--key", "--namespace", "SETTINGS"]),
      "VALIDATION_ERROR",
      /--key requires a value/,
    );
    await expectError(
      kvCommand(["get", "--namespace", "SETTINGS"]),
      "VALIDATION_ERROR",
      /--key <name> for a key starting with -/,
    );
    expect(calls).toEqual([]);
  });

  it("requires a namespace or binding", async () => {
    await expectError(
      kvCommand(["get", "feed"]),
      "VALIDATION_ERROR",
      /namespace is required/,
    );
  });
});

describe("kv put", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kv-test-"));
  });

  it("writes a file value and reports a new key as created", async () => {
    const file = join(dir, "v.json");
    writeFileSync(file, '{"on":true}');
    apiKeys = [{ name: "flags:old" }];
    apiValues["flags:old"] = Buffer.from("x");
    const out = await kvCommand([
      "put",
      "flags",
      "--namespace",
      "SETTINGS",
      "--file",
      file,
      "--ttl",
      "3600",
    ]);
    expect(apiCalls).toEqual([`${NS_PATH}/metadata/flags`]);
    expect(calls.at(-1)).toEqual([
      "kv",
      "key",
      "put",
      "flags",
      "--path",
      file,
      "--namespace-id",
      SETTINGS_ID,
      "--remote",
      "--ttl",
      "3600",
    ]);
    expect(out).toContain("action: created");
    expect(out).toContain("size: 11 bytes");
    expect(out).toContain("ttl: 3600s");
  });

  it("reports an overwrite from the metadata probe, never listing or reading values", async () => {
    const file = join(dir, "v");
    writeFileSync(file, "new");
    apiValues.feed = Buffer.from("old");
    const out = await kvCommand([
      "put",
      "feed",
      "--namespace",
      SETTINGS_ID,
      "--file",
      file,
    ]);
    expect(apiCalls).toEqual([`${NS_PATH}/metadata/feed`]);
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "kv namespace list",
      "kv key put",
    ]);
    expect(out).toContain("action: overwritten");
  });

  it("reads --stdin into a temp file, never argv", async () => {
    const stdin = Object.assign(Readable.from([Buffer.from("from stdin")]), {
      isTTY: false,
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdin as unknown as typeof process.stdin,
    );
    const out = await kvCommand([
      "put",
      "k",
      "--namespace",
      "SETTINGS",
      "--stdin",
    ]);
    expect(putValues).toEqual(["from stdin"]);
    const put = calls.at(-1)!;
    expect(put).not.toContain("from stdin");
    expect(out).toContain("size: 10 bytes");
  });

  it("refuses a dash-prefixed key before any call", async () => {
    const file = join(dir, "v");
    writeFileSync(file, "x");
    await expectError(
      kvCommand([
        "put",
        "--key",
        "-feed",
        "--namespace",
        "SETTINGS",
        "--file",
        file,
      ]),
      "VALIDATION_ERROR",
      /`kv put` cannot take key -feed/,
    );
    expect(calls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("accepts --key for an ordinary key", async () => {
    const file = join(dir, "v");
    writeFileSync(file, "x");
    await kvCommand([
      "put",
      "--key",
      "plain",
      "--namespace",
      "SETTINGS",
      "--file",
      file,
    ]);
    expect(calls.at(-1)?.slice(0, 4)).toEqual(["kv", "key", "put", "plain"]);
  });

  it("refuses --binding for a write", async () => {
    await expectError(
      kvCommand(["put", "k", "--binding", "SETTINGS", "--file", "x"]),
      "VALIDATION_ERROR",
      /--binding is not accepted for writes/,
    );
    expect(calls).toEqual([]);
  });

  it("needs exactly one of --file or --stdin", async () => {
    await expectError(
      kvCommand(["put", "k", "--namespace", "SETTINGS"]),
      "VALIDATION_ERROR",
      /exactly one of --file/,
    );
    await expectError(
      kvCommand(["put", "k", "v", "--namespace", "SETTINGS"]),
      "VALIDATION_ERROR",
      /unexpected argument v/,
    );
    expect(calls).toEqual([]);
  });

  it("validates --ttl and the file before any write", async () => {
    await expectError(
      kvCommand([
        "put",
        "k",
        "--namespace",
        "SETTINGS",
        "--file",
        "x",
        "--ttl",
        "5",
      ]),
      "VALIDATION_ERROR",
      />= 60/,
    );
    await expectError(
      kvCommand([
        "put",
        "k",
        "--namespace",
        "SETTINGS",
        "--file",
        join(dir, "nope"),
      ]),
      "VALIDATION_ERROR",
      /is not a file/,
    );
    expect(calls.some((c) => c[2] === "put")).toBe(false);
  });
});

describe("kv delete", () => {
  it("deletes an existing key and says what it removed", async () => {
    apiValues.feed = Buffer.from("v");
    const out = await kvCommand(["delete", "feed", "--namespace", "SETTINGS"]);
    expect(apiCalls).toEqual([`${NS_PATH}/metadata/feed`]);
    expect(calls.at(-1)).toEqual([
      "kv",
      "key",
      "delete",
      "feed",
      "--namespace-id",
      SETTINGS_ID,
      "--remote",
    ]);
    expect(calls.some((c) => c[1] === "key" && c[2] !== "delete")).toBe(false);
    expect(out).toContain("action: deleted");
  });

  it("refuses a missing key without calling delete", async () => {
    apiValues["missing:1"] = Buffer.from("v");
    await expectError(
      kvCommand(["delete", "missing", "--namespace", "SETTINGS"]),
      "NOT_FOUND",
      /nothing deleted/,
    );
    expect(calls.some((c) => c[2] === "delete")).toBe(false);
  });

  it("refuses a dash-prefixed key before any call", async () => {
    await expectError(
      kvCommand(["delete", "--key=-feed", "--namespace", "SETTINGS"]),
      "VALIDATION_ERROR",
      /`kv delete` cannot take key -feed/,
    );
    expect(calls).toEqual([]);
  });

  it("requires --namespace named in full", async () => {
    await expectError(
      kvCommand(["delete", "feed"]),
      "VALIDATION_ERROR",
      /--namespace is required/,
    );
    await expectError(
      kvCommand(["delete", "feed", "--binding", "SETTINGS"]),
      "VALIDATION_ERROR",
      /not accepted for writes/,
    );
    await expectError(
      kvCommand(["delete", "feed", "--namespace", "SETTING"]),
      "NOT_FOUND",
      /SETTING not found/,
    );
    expect(calls.some((c) => c[2] === "delete")).toBe(false);
  });
});

describe("helpers", () => {
  const b = (s: string) => Buffer.from(s);

  it("classifies values from their bytes", () => {
    expect(classifyValue(b("[1,2]")).format).toBe("json");
    expect(classifyValue(b("{not json")).format).toBe("text");
    expect(classifyValue(b("a\tb\r\n")).format).toBe("text");
    expect(classifyValue(b("\u0000")).format).toBe("binary");
    expect(classifyValue(b("\uFFFD")).format).toBe("text");
    expect(classifyValue(Buffer.from([0xc3, 0x28])).format).toBe("binary");
  });

  it("shows JSON as stored text when parsing would change it", () => {
    const big = '{"id":12345678901234567890}';
    expect(classifyValue(b(big))).toEqual({ format: "text", text: big });
    const dup = '{"a":1,"a":2}';
    expect(classifyValue(b(dup))).toEqual({ format: "text", text: dup });
    expect(classifyValue(b('{ "s": "a  b",\n "n": [1, 2] }'))).toEqual({
      format: "json",
      text: '{\n  "s": "a  b",\n  "n": [\n    1,\n    2\n  ]\n}',
    });
  });

  it("truncates on a line boundary", () => {
    expect(truncateValue("aaaa\nbbbb\ncccc", 12)).toEqual({
      text: "aaaa\nbbbb",
      truncated: true,
    });
    expect(truncateValue("short", 12).truncated).toBe(false);
  });

  it("derives a valid binding name", () => {
    expect(bindingNameFor("my-cache")).toBe("my_cache");
    expect(bindingNameFor("1st")).toBe("_1st");
  });

  it("maps an unknown namespace id from wrangler to NOT_FOUND", () => {
    const error = mapWranglerError(
      `${ERR("A request to the Cloudflare API (/accounts/a/storage/kv/namespaces/x/keys) failed.")}\n\n  get namespace: 'namespace not found' [code: 10013]`,
      1,
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("KV namespace not found in this account");
  });
});
