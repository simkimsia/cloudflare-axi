import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError, mapWranglerError } from "../src/errors.js";

// Drives `kv` subcommands end-to-end through src/wrangler.ts with
// child_process.execFile mocked, asserting the wrangler argv forwarded and the
// rendered output. Fixtures are real wrangler 4.127.1 output captured live
// 2026-10-09 (read-only commands) or taken from the wrangler source (create).

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
  stdout?: string;
  stderr?: string;
  code?: number;
}

/** Map of "space-joined argv prefix" -> reply; longest matching prefix wins. */
let replies: Record<string, Reply>;
let calls: string[][];
let putValues: string[];

beforeEach(() => {
  calls = [];
  putValues = [];
  replies = { "kv namespace list": { stdout: JSON.stringify(NAMESPACES) } };
  execFile.mockImplementation(
    (
      _file: string,
      args: string[],
      _opts: unknown,
      cb: (e: unknown, out: string, err: string) => void,
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
    replies["kv key list"] = {
      stdout: JSON.stringify([
        { name: "feed" },
        { name: "limit:35317871", expiration: 1791590400 },
        { name: "member:1" },
      ]),
    };
  });

  it("resolves a namespace title to its id and always lists remote", async () => {
    const out = await kvCommand(["keys", "SETTINGS", "--prefix", "li"]);
    expect(calls[1]).toEqual([
      "kv",
      "key",
      "list",
      "--namespace-id",
      SETTINGS_ID,
      "--remote",
      "--prefix",
      "li",
    ]);
    expect(out).toContain(
      `count: 3 of 3 keys in SETTINGS (${SETTINGS_ID}) with prefix li`,
    );
    expect(out).toContain("feed,never");
    expect(out).toContain('"limit:35317871","2026-10-10T00:00:00.000Z"');
  });

  it("passes --binding through without a namespace lookup", async () => {
    await kvCommand(["keys", "--binding", "SETTINGS"]);
    expect(calls).toEqual([
      ["kv", "key", "list", "--binding", "SETTINGS", "--remote"],
    ]);
  });

  it("caps rows at --limit with a hint", async () => {
    const out = await kvCommand([
      "keys",
      "--namespace",
      SETTINGS_ID,
      "--limit",
      "1",
    ]);
    expect(out).toContain("count: 1 of 3 keys");
    expect(out).toContain("Pass --limit 3 for all");
  });

  it("reports an unknown namespace as NOT_FOUND before listing", async () => {
    await expectError(
      kvCommand(["keys", "settings"]),
      "NOT_FOUND",
      /settings not found/,
    );
    expect(calls).toHaveLength(1);
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
  it("pretty-prints a JSON value with its size", async () => {
    replies["kv key get feed"] = { stdout: FEED };
    const out = await kvCommand(["get", "feed", "--namespace", "SETTINGS"]);
    expect(calls[1]).toEqual([
      "kv",
      "key",
      "get",
      "feed",
      "--namespace-id",
      SETTINGS_ID,
      "--remote",
    ]);
    expect(out).toContain(`size: ${FEED.length} bytes`);
    expect(out).toContain("format: json");
    expect(out).toContain(
      'value:\n  {\n    "timestamp": "2026-10-09T16:00:00+08:00",',
    );
  });

  it("prints plain text as-is", async () => {
    replies["kv key get home:1"] = { stdout: "east" };
    const out = await kvCommand(["get", "home:1", "--binding", "SETTINGS"]);
    expect(out).toContain("format: text");
    expect(out).toContain("value:\n  east");
  });

  it("truncates a large value unless --full", async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    replies["kv key get big"] = { stdout: big };
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

  it("does not print a binary value", async () => {
    replies["kv key get img"] = {
      stdout: "\u0089PNG\r\n\u001a\n\u0000\u0000�",
    };
    const out = await kvCommand(["get", "img", "--namespace", "SETTINGS"]);
    expect(out).toContain("format: binary");
    expect(out).toContain("value: not shown");
  });

  it("maps a missing key to NOT_FOUND", async () => {
    replies["kv key get missing"] = { code: 1, stderr: KEY_404 };
    await expectError(
      kvCommand(["get", "missing", "--namespace", "SETTINGS"]),
      "NOT_FOUND",
      /KV key not found/,
    );
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
    replies["kv key get flags"] = {
      code: 1,
      stderr: KEY_404.replace("missing", "flags"),
    };
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

  it("reports an overwrite with the previous size", async () => {
    const file = join(dir, "v");
    writeFileSync(file, "new");
    replies["kv key get feed"] = { stdout: FEED };
    const out = await kvCommand([
      "put",
      "feed",
      "--namespace",
      SETTINGS_ID,
      "--file",
      file,
    ]);
    expect(out).toContain(
      `action: overwritten (previous value ${FEED.length} bytes)`,
    );
  });

  it("reads --stdin into a temp file, never argv", async () => {
    const stdin = Object.assign(Readable.from([Buffer.from("from stdin")]), {
      isTTY: false,
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdin as unknown as typeof process.stdin,
    );
    replies["kv key get k"] = { code: 1, stderr: KEY_404 };
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
    replies["kv key get feed"] = { stdout: FEED };
    const out = await kvCommand(["delete", "feed", "--namespace", "SETTINGS"]);
    expect(calls.at(-1)).toEqual([
      "kv",
      "key",
      "delete",
      "feed",
      "--namespace-id",
      SETTINGS_ID,
      "--remote",
    ]);
    expect(out).toContain(`action: deleted (was ${FEED.length} bytes)`);
  });

  it("refuses a missing key without calling delete", async () => {
    replies["kv key get missing"] = { code: 1, stderr: KEY_404 };
    await expectError(
      kvCommand(["delete", "missing", "--namespace", "SETTINGS"]),
      "NOT_FOUND",
      /nothing deleted/,
    );
    expect(calls.some((c) => c[2] === "delete")).toBe(false);
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
  it("classifies values", () => {
    expect(classifyValue("[1,2]").format).toBe("json");
    expect(classifyValue("{not json").format).toBe("text");
    expect(classifyValue("a\tb\r\n").format).toBe("text");
    expect(classifyValue("\u0000").format).toBe("binary");
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
