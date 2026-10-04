import { describe, expect, it } from "vitest";
import {
  assertEmail,
  checkLiveDns,
  disabledCatchAllBody,
  dnsRole,
  findRule,
  forwardRuleBody,
  keptRuleName,
  parseForwardTarget,
  planDestination,
  planForward,
  planUnforward,
  toAddressRows,
  toDnsRows,
  toRuleRows,
  updateRuleBody,
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

describe("email write planners", () => {
  it("planDestination: new, verified, and pending addresses", () => {
    expect(planDestination(ADDRESSES, "new@gmail.example")).toBe("create");
    expect(planDestination(ADDRESSES, "inbox@gmail.example")).toBe("verified");
    expect(planDestination(ADDRESSES, "pending@gmail.example")).toBe("pending");
  });

  it("assertEmail lowercases and rejects non-addresses", () => {
    expect(assertEmail("You@Gmail.com", "destination")).toBe("you@gmail.com");
    expect(() => assertEmail("hello", "destination")).toThrow(
      /must be an email address/,
    );
  });

  it("parseForwardTarget: catch-all, local part, full address on and off the zone", () => {
    expect(parseForwardTarget("*", "example.com")).toEqual({ catchAll: true });
    expect(parseForwardTarget("Hello", "example.com")).toEqual({
      catchAll: false,
      address: "hello@example.com",
    });
    expect(parseForwardTarget("hi@mail.example.com", "example.com")).toEqual({
      catchAll: false,
      address: "hi@mail.example.com",
    });
    expect(() => parseForwardTarget("hi@other.com", "example.com")).toThrow(
      /not on zone example.com/,
    );
  });

  it("findRule matches the catch-all and literal rules by address", () => {
    expect(findRule(RULES, { catchAll: true })?.id).toBe("a27d");
    expect(
      findRule(RULES, { catchAll: false, address: "hello@example.com" })?.id,
    ).toBe("d4a1");
    expect(
      findRule(RULES, { catchAll: false, address: "sales@example.com" }),
    ).toBeUndefined();
  });

  it("planForward fails before the API when the destination is missing or unverified", () => {
    const target = { catchAll: false as const, address: "sales@example.com" };
    expect(() =>
      planForward(RULES, ADDRESSES, target, "new@gmail.example"),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() =>
      planForward(RULES, ADDRESSES, target, "pending@gmail.example"),
    ).toThrow(expect.objectContaining({ code: "UNVERIFIED" }));
  });

  it("planForward: noop when already forwarding, update when different, create when absent", () => {
    expect(
      planForward(RULES, ADDRESSES, { catchAll: true }, "inbox@gmail.example")
        .kind,
    ).toBe("noop");
    const other: EmailAddress = {
      id: "3",
      email: "other@gmail.example",
      status: "verified",
      verified: "2026-09-01T00:00:00Z",
    };
    const plan = planForward(
      RULES,
      [...ADDRESSES, other],
      { catchAll: false, address: "hello@example.com" },
      "other@gmail.example",
    );
    expect(plan).toMatchObject({ kind: "update", rule: { id: "d4a1" } });
    expect(
      planForward(
        RULES,
        ADDRESSES,
        { catchAll: false, address: "sales@example.com" },
        "inbox@gmail.example",
      ).kind,
    ).toBe("create");
  });

  it("planForward: a disabled matching rule is updated, a missing catch-all is a PUT", () => {
    const disabled = RULES.map((r) =>
      r.id === "a27d" ? { ...r, enabled: false } : r,
    );
    expect(
      planForward(
        disabled,
        ADDRESSES,
        { catchAll: true },
        "inbox@gmail.example",
      ).kind,
    ).toBe("update");
    expect(
      planForward([], ADDRESSES, { catchAll: true }, "inbox@gmail.example"),
    ).toMatchObject({ kind: "update", rule: { id: "catch_all" } });
  });

  it("forwardRuleBody builds the documented catch-all and literal shapes", () => {
    expect(forwardRuleBody({ catchAll: true }, "a@b.example")).toEqual({
      name: "catch-all to a@b.example",
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: ["a@b.example"] }],
    });
    expect(
      forwardRuleBody(
        { catchAll: false, address: "hello@example.com" },
        "a@b.example",
        "kept name",
      ),
    ).toMatchObject({
      name: "kept name",
      matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
    });
  });

  const hello = { catchAll: false as const, address: "hello@example.com" };
  const literalRule = (
    name: string | undefined,
    priority?: number,
  ): EmailRule => ({
    id: "r1",
    name,
    enabled: true,
    priority,
    matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
    actions: [{ type: "forward", value: ["old@b.example"] }],
  });

  it("keptRuleName drops only the name forwardRuleBody would generate", () => {
    expect(
      keptRuleName(literalRule("hello@example.com to old@b.example"), hello),
    ).toBeUndefined();
    expect(keptRuleName(literalRule("Sales team to bob@corp.com"), hello)).toBe(
      "Sales team to bob@corp.com",
    );
    expect(
      keptRuleName(literalRule("other@example.com to old@b.example"), hello),
    ).toBe("other@example.com to old@b.example");
    expect(keptRuleName(literalRule(undefined), hello)).toBeUndefined();
    expect(
      keptRuleName(
        { ...literalRule("catch-all to old@b.example") },
        { catchAll: true },
      ),
    ).toBeUndefined();
    expect(keptRuleName(literalRule("catch-all to old@b.example"), hello)).toBe(
      "catch-all to old@b.example",
    );
  });

  it("updateRuleBody keeps a literal rule's priority and user-chosen name", () => {
    expect(
      updateRuleBody(
        literalRule("Sales team to bob@corp.com", 5),
        hello,
        "a@b.example",
      ),
    ).toEqual({
      name: "Sales team to bob@corp.com",
      enabled: true,
      priority: 5,
      matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
      actions: [{ type: "forward", value: ["a@b.example"] }],
    });
    expect(
      updateRuleBody(
        literalRule("hello@example.com to old@b.example"),
        hello,
        "a@b.example",
      ),
    ).not.toHaveProperty("priority");
    const catchAll: EmailRule = {
      id: "catch_all",
      name: "catch-all to old@b.example",
      enabled: true,
      priority: 2147483647,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: ["old@b.example"] }],
    };
    expect(updateRuleBody(catchAll, { catchAll: true }, "a@b.example")).toEqual(
      forwardRuleBody({ catchAll: true }, "a@b.example"),
    );
  });
});

describe("email unforward planner", () => {
  it("deletes the rule that routes the named address", () => {
    expect(
      planUnforward(RULES, { catchAll: false, address: "hello@example.com" }),
    ).toMatchObject({ kind: "delete", rule: { id: "d4a1" } });
  });

  it("is a no-op when no rule routes the address on its own", () => {
    expect(
      planUnforward(RULES, { catchAll: false, address: "sales@example.com" }),
    ).toEqual({ kind: "noop" });
    const multi: EmailRule = {
      id: "m",
      enabled: true,
      matchers: [
        { type: "literal", field: "to", value: "sales@example.com" },
        { type: "literal", field: "from", value: "boss@corp.example" },
      ],
      actions: [{ type: "drop" }],
    };
    expect(
      planUnforward([multi], {
        catchAll: false,
        address: "sales@example.com",
      }),
    ).toEqual({ kind: "noop" });
  });

  it("disables an enabled catch-all and no-ops a disabled one", () => {
    expect(planUnforward(RULES, { catchAll: true })).toMatchObject({
      kind: "disable",
      rule: { id: "a27d" },
    });
    const off = RULES.map((r) =>
      r.id === "a27d" ? { ...r, enabled: false } : r,
    );
    expect(planUnforward(off, { catchAll: true })).toEqual({ kind: "noop" });
    expect(planUnforward([], { catchAll: true })).toEqual({ kind: "noop" });
  });

  it("disabledCatchAllBody keeps the name and action, flips enabled", () => {
    expect(disabledCatchAllBody(RULES[0])).toEqual({
      name: "catch-all to gmail",
      enabled: false,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: ["inbox@gmail.example"] }],
    });
  });
});
