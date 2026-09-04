import { describe, expect, it } from "vitest";
import {
  checkLiveDns,
  dnsRole,
  toAddressRows,
  toDnsRows,
  toRuleRows,
  type EmailAddress,
  type EmailDnsRecord,
  type EmailRule,
} from "../src/commands/email.js";

// Real api.cloudflare.com responses captured live 2026-09-04 (ids/emails
// anonymised).
const ADDRESSES: EmailAddress[] = [
  {
    id: "168836ef91e8444c93e7d65ba2852551",
    email: "inbox@gmail.example",
    verified: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
    created: "2026-09-03T02:44:11.471794Z",
    status: "verified",
  },
  {
    id: "2",
    email: "pending@gmail.example",
    verified: null,
    status: "unverified",
  },
];

const RULES: EmailRule[] = [
  {
    id: "a27d",
    name: "catch-all to gmail",
    matchers: [{ type: "all" }],
    actions: [{ type: "forward", value: ["inbox@gmail.example"] }],
    enabled: true,
    priority: 2147483647,
  },
  {
    id: "d4a1",
    name: "hello to gmail",
    matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
    actions: [{ type: "forward", value: ["inbox@gmail.example"] }],
    enabled: true,
    priority: 0,
  },
  {
    id: "x",
    matchers: [{ type: "literal", field: "to", value: "noreply@example.com" }],
    actions: [{ type: "drop" }],
    enabled: false,
    priority: 1,
  },
];

const DKIM =
  "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiweykoi";
const DNS: EmailDnsRecord[] = [
  {
    name: "example.com",
    content: "route1.mx.cloudflare.net.",
    type: "MX",
    priority: 53,
    ttl: 1,
  },
  {
    name: "example.com",
    content: "route2.mx.cloudflare.net.",
    type: "MX",
    priority: 9,
    ttl: 1,
  },
  {
    name: "cf2024-1._domainkey.example.com",
    content: `"${DKIM}"`,
    type: "TXT",
    ttl: 1,
  },
  {
    name: "example.com",
    content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
    type: "TXT",
    ttl: 1,
  },
];

describe("toAddressRows", () => {
  it("flattens addresses with a verified age", () => {
    expect(toAddressRows(ADDRESSES)).toEqual([
      { email: "inbox@gmail.example", status: "verified", verified: "2d ago" },
      { email: "pending@gmail.example", status: "unverified", verified: "no" },
    ]);
  });
});

describe("toRuleRows", () => {
  it("orders by priority with the catch-all last and describes match/action", () => {
    expect(toRuleRows(RULES)).toEqual([
      {
        name: "hello to gmail",
        match: "hello@example.com",
        action: "forward→inbox@gmail.example",
        enabled: true,
      },
      {
        name: "x",
        match: "noreply@example.com",
        action: "drop",
        enabled: false,
      },
      {
        name: "catch-all to gmail",
        match: "all",
        action: "forward→inbox@gmail.example",
        enabled: true,
      },
    ]);
  });
});

describe("dnsRole / toDnsRows", () => {
  it("classifies MX, DKIM, and SPF records", () => {
    expect(DNS.map(dnsRole)).toEqual(["mx", "mx", "dkim", "spf"]);
  });

  it("strips quotes and trailing dots, folds MX priority in, compacts the DKIM key", () => {
    const rows = toDnsRows(DNS);
    expect(rows[0]).toEqual({
      role: "mx",
      type: "MX",
      name: "example.com",
      content: "53 route1.mx.cloudflare.net",
    });
    expect(rows[3].content).toBe("v=spf1 include:_spf.mx.cloudflare.net ~all");
    expect(String(rows[2].content)).toMatch(
      /^v=DKIM1; h=sha256; k=rsa; p=.*…\(\d+ chars\)$/,
    );
    // Uniform keys so TOON renders one tabular block.
    expect(rows.map((r) => Object.keys(r).join())).toEqual(
      Array(4).fill("role,type,name,content"),
    );
  });

  it("adds the live column when states are given", () => {
    const rows = toDnsRows(DNS, ["ok", "missing", "ok", "differs"]);
    expect(rows.map((r) => r.live)).toEqual(["ok", "missing", "ok", "differs"]);
  });
});

describe("checkLiveDns", () => {
  const resolver = {
    async resolveMx(host: string) {
      if (host !== "example.com")
        throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
      return [{ exchange: "route1.mx.cloudflare.net", priority: 53 }];
    },
    async resolveTxt(host: string) {
      if (host === "example.com")
        return [
          [
            "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all",
          ],
        ];
      const err = Object.assign(new Error("x"), { code: "ENODATA" });
      throw err;
    },
  };

  it("reports ok / missing / differs per record", async () => {
    expect(await checkLiveDns(DNS, resolver)).toEqual([
      "ok",
      "missing",
      "missing",
      "differs",
    ]);
  });

  it("reports ok when a multi-chunk TXT joins to the expected value", async () => {
    const chunked = {
      ...resolver,
      async resolveTxt() {
        return [["v=spf1 include:_spf.mx.", "cloudflare.net ~all"]];
      },
    };
    expect(await checkLiveDns([DNS[3]], chunked)).toEqual(["ok"]);
  });
});
