import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dnsAuthError,
  dnsCommand,
  normalizeContent,
  parseTtl,
  planSet,
  qualifyName,
  toRecordRows,
  txtTag,
  type DnsRecord,
} from "../src/commands/dns.js";
import { AxiError } from "../src/errors.js";

// Record shapes follow the Cloudflare API v4 dns_records docs. Not yet
// captured live: the wrangler OAuth token cannot read dns_records (issue #4).

const ZONE_ID = "0123456789abcdef0123456789abcdef";

const SPF: DnsRecord = {
  id: "spf1",
  type: "TXT",
  name: "example.com",
  content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
  ttl: 1,
  proxied: false,
};
const VERIFY: DnsRecord = {
  id: "gsv",
  type: "TXT",
  name: "example.com",
  content: "google-site-verification=abc123",
  ttl: 3600,
  proxied: false,
};
const DMARC: DnsRecord = {
  id: "dmarc",
  type: "TXT",
  name: "_dmarc.example.com",
  content: "v=DMARC1; p=none",
  ttl: 1,
  proxied: false,
};
const MX: DnsRecord = {
  id: "mx1",
  type: "MX",
  name: "example.com",
  content: "route1.mx.cloudflare.net",
  priority: 53,
  ttl: 1,
  proxied: false,
};

describe("qualifyName", () => {
  it("maps @, relative, full, and trailing-dot names onto the zone", () => {
    expect(qualifyName("@", "example.com")).toBe("example.com");
    expect(qualifyName("_dmarc", "example.com")).toBe("_dmarc.example.com");
    expect(qualifyName("WWW.Example.com.", "example.com")).toBe(
      "www.example.com",
    );
    expect(qualifyName("example.com", "example.com")).toBe("example.com");
  });
});

describe("content helpers", () => {
  it("txtTag reads the v= tag through quotes", () => {
    expect(txtTag(SPF.content)).toBe("v=spf1");
    expect(txtTag("v=DMARC1; p=none")).toBe("v=dmarc1");
    expect(txtTag(VERIFY.content)).toBeUndefined();
  });

  it("normalizeContent joins quoted TXT chunks and drops trailing dots", () => {
    expect(normalizeContent("TXT", '"v=spf1 a" " ~all"')).toBe("v=spf1 a ~all");
    expect(normalizeContent("CNAME", "Site.Pages.dev.")).toBe("site.pages.dev");
  });

  it("parseTtl accepts auto and 30..86400", () => {
    expect(parseTtl("auto")).toBe(1);
    expect(parseTtl("300")).toBe(300);
    expect(() => parseTtl("5")).toThrow(/--ttl/);
    expect(() => parseTtl("1.5")).toThrow(/--ttl/);
  });

  it("toRecordRows folds MX priority, renders auto ttl, shortens long content", () => {
    const dkim: DnsRecord = {
      id: "dk",
      type: "TXT",
      name: "cf2024-1._domainkey.example.com",
      content: `v=DKIM1; k=rsa; p=${"A".repeat(400)}`,
      ttl: 1,
    };
    const [mx, long] = toRecordRows([MX, dkim]);
    expect(mx).toMatchObject({
      content: "53 route1.mx.cloudflare.net",
      ttl: "auto",
      proxied: false,
    });
    expect(long.content).toMatch(/…\(418 chars\)$/);
    expect(toRecordRows([dkim], true)[0].content).toBe(dkim.content);
  });
});

describe("planSet", () => {
  const records = [SPF, VERIFY, DMARC, MX];

  it("updates the SPF record and leaves site verification alone", () => {
    const plan = planSet(records, {
      type: "TXT",
      name: "example.com",
      content:
        "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all",
    });
    expect(plan).toEqual({ kind: "update", record: SPF });
  });

  it("is a no-op when the content already matches (quotes ignored)", () => {
    const plan = planSet(records, {
      type: "TXT",
      name: "example.com",
      content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
    });
    expect(plan.kind).toBe("noop");
  });

  it("is an update when only ttl or proxied differs", () => {
    const plan = planSet(records, {
      type: "TXT",
      name: "_dmarc.example.com",
      content: "v=DMARC1; p=none",
      ttl: 300,
    });
    expect(plan.kind).toBe("update");
  });

  it("creates when nothing with that type and name exists", () => {
    expect(
      planSet(records, {
        type: "TXT",
        name: "_dmarc.other.example.com",
        content: "v=DMARC1; p=none",
      }),
    ).toEqual({ kind: "create" });
  });

  it("refuses an untagged TXT when several TXT share the name, listing ids", () => {
    let error: unknown;
    try {
      planSet(records, { type: "TXT", name: "example.com", content: "hello" });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
    const help = (error as { suggestions: string[] }).suggestions.join("\n");
    expect(help).toContain("id spf1");
    expect(help).toContain("id gsv");
    expect(help).toContain("--id");
  });

  it("--id picks one record and must match type and name", () => {
    expect(
      planSet(records, {
        type: "TXT",
        name: "example.com",
        content: "google-site-verification=new",
        id: "gsv",
      }),
    ).toEqual({ kind: "update", record: VERIFY });
    expect(() =>
      planSet(records, {
        type: "TXT",
        name: "example.com",
        content: "x",
        id: "dmarc",
      }),
    ).toThrow(/has id dmarc/);
  });
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function stubApi(
  records: DnsRecord[],
  failRecords?: { status: number; code: number; message: string },
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      let result: unknown = null;
      if (path.startsWith("/zones?name=")) {
        result = [{ id: ZONE_ID, name: "example.com", account: { id: "acc" } }];
      } else if (path.includes("/dns_records") && failRecords) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: failRecords.code, message: failRecords.message }],
            result: null,
          }),
          { status: failRecords.status },
        );
      } else if (method === "GET" && path.includes("/dns_records?")) {
        const query = new URLSearchParams(path.split("?")[1]);
        result = records.filter(
          (r) =>
            (!query.get("type") || r.type === query.get("type")) &&
            (!query.get("name") || r.name === query.get("name")),
        );
      } else if (method === "POST") {
        result = { id: "new1", ...body };
      } else if (method === "PATCH") {
        const id = path.split("/").pop();
        result = { ...records.find((r) => r.id === id), ...body };
      }
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
      });
    }),
  );
  return calls;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("dns command", () => {
  it("lists records filtered server-side by type and qualified name", async () => {
    const calls = stubApi([SPF, VERIFY, DMARC, MX]);
    const out = await dnsCommand([
      "list",
      "--zone",
      "example.com",
      "--type",
      "txt",
      "--name",
      "@",
    ]);
    expect(calls.at(-1)!.path).toBe(
      `/zones/${ZONE_ID}/dns_records?per_page=1000&type=TXT&name=example.com`,
    );
    expect(out).toContain(
      "count: 2 DNS records in example.com (type TXT, name example.com)",
    );
    expect(out).toContain("records[2]{id,type,name,content,ttl,proxied}");
  });

  it("set PATCHes only the content of the SPF record and prints before/after", async () => {
    const calls = stubApi([SPF, VERIFY]);
    const out = await dnsCommand([
      "set",
      "TXT",
      "@",
      "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all",
      "--zone",
      "example.com",
    ]);
    expect(writes(calls)).toEqual([
      {
        method: "PATCH",
        path: `/zones/${ZONE_ID}/dns_records/spf1`,
        body: {
          content:
            "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all",
        },
      },
    ]);
    expect(out).toContain("changed: true");
    expect(out).toContain("action: update");
    expect(out).toContain(
      'before: "\\"v=spf1 include:_spf.mx.cloudflare.net ~all\\" (ttl auto)"',
    );
    expect(out).toContain("include:_spf.google.com ~all (ttl auto)");
  });

  it("set POSTs a new record with auto ttl and proxied off", async () => {
    const calls = stubApi([]);
    const out = await dnsCommand([
      "set",
      "cname",
      "www",
      "site.pages.dev",
      "--zone",
      "example.com",
    ]);
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        path: `/zones/${ZONE_ID}/dns_records`,
        body: {
          type: "CNAME",
          name: "www.example.com",
          content: "site.pages.dev",
          ttl: 1,
          proxied: false,
        },
      },
    ]);
    expect(out).toContain("action: create");
    expect(out).not.toContain("before:");
  });

  it("set is a no-op on a second identical run", async () => {
    const calls = stubApi([DMARC]);
    const out = await dnsCommand([
      "set",
      "TXT",
      "_dmarc",
      "v=DMARC1; p=none",
      "--zone",
      "example.com",
    ]);
    expect(writes(calls)).toEqual([]);
    expect(out).toContain("changed: false");
    expect(out).toContain("nothing changed");
  });

  it("set MX needs --priority to create", async () => {
    stubApi([]);
    await expect(
      dnsCommand(["set", "MX", "@", "mx.example.net", "--zone", "example.com"]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rewrites AUTH with the DNS permission the token lacks", async () => {
    stubApi([], { status: 403, code: 10000, message: "Authentication error" });
    let error: unknown;
    try {
      await dnsCommand(["--zone", "example.com"]);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: "AUTH" });
    const help = (error as { suggestions: string[] }).suggestions.join("\n");
    expect(help).toContain("CLOUDFLARE_API_TOKEN needs Zone > DNS > Read");
    expect(help).not.toContain("wrangler login");
  });

  it("without an env token, AUTH says wrangler login cannot carry DNS", () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const error = dnsAuthError(
      new AxiError("Cloudflare API rejected the credentials", "AUTH", ["x"]),
      true,
    ) as AxiError;
    expect(error.suggestions.join("\n")).toMatch(
      /`wrangler login` token cannot read or edit DNS.*Zone > DNS > Edit.*export CLOUDFLARE_API_TOKEN/,
    );
    const other = new AxiError("nope", "NOT_FOUND");
    expect(dnsAuthError(other, true)).toBe(other);
  });

  it("rejects flags meant for the other subcommand and unknown subcommands", async () => {
    stubApi([]);
    await expect(
      dnsCommand(["list", "--ttl", "300", "--zone", "example.com"]),
    ).rejects.toThrow(/--ttl not valid for `dns list`/);
    await expect(
      dnsCommand(["delete", "--zone", "example.com"]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      dnsCommand(["set", "SRV", "x", "y", "--zone", "example.com"]),
    ).rejects.toThrow(/set supports/);
    await expect(dnsCommand([])).rejects.toThrow(/--zone is required/);
  });
});
