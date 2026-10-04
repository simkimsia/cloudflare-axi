import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailCommand } from "../src/commands/email.js";
import type { EmailRule } from "../src/commands/email.js";

// Drives `email unforward` end-to-end through cfRequest with a stubbed fetch,
// asserting the HTTP calls made and the rendered output.

const ZONE_ID = "0123456789abcdef0123456789abcdef";

const CATCH_ALL: EmailRule = {
  id: "a27d",
  name: "catch-all to gmail",
  matchers: [{ type: "all" }],
  actions: [{ type: "forward", value: ["inbox@gmail.example"] }],
  enabled: true,
  priority: 2147483647,
};
const TEST_RULE: EmailRule = {
  id: "t3st",
  name: "test to gmail",
  matchers: [{ type: "literal", field: "to", value: "test@example.com" }],
  actions: [{ type: "forward", value: ["inbox@gmail.example"] }],
  enabled: true,
  priority: 0,
};

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function stubApi(rules: EmailRule[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      const method = init.method ?? "GET";
      calls.push({
        method,
        path,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      let result: unknown = null;
      if (path.startsWith("/zones?name=")) {
        result = [{ id: ZONE_ID, name: "example.com", account: { id: "acc" } }];
      } else if (path.includes("/email/routing/rules?")) {
        result = rules;
      } else if (method === "DELETE") {
        result = { id: path.split("/").pop() };
      } else if (method === "PUT") {
        result = { ...CATCH_ALL, ...(calls.at(-1)!.body as object) };
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

describe("email unforward command", () => {
  it("DELETEs the rule for a local part and prints what was removed", async () => {
    const calls = stubApi([CATCH_ALL, TEST_RULE]);
    const out = await emailCommand([
      "unforward",
      "test",
      "--zone",
      "example.com",
    ]);
    expect(writes(calls)).toEqual([
      {
        method: "DELETE",
        path: `/zones/${ZONE_ID}/email/routing/rules/t3st`,
        body: undefined,
      },
    ]);
    expect(out).toContain("changed: true");
    expect(out).toContain("match: test@example.com");
    expect(out).toContain("removed: forward→inbox@gmail.example");
    expect(out).toContain("falls through to the catch-all");
  });

  it("accepts a full address on the zone", async () => {
    const calls = stubApi([CATCH_ALL, TEST_RULE]);
    await emailCommand([
      "unforward",
      "test@example.com",
      "--zone",
      "example.com",
    ]);
    expect(writes(calls).map((c) => c.method + " " + c.path)).toEqual([
      `DELETE /zones/${ZONE_ID}/email/routing/rules/t3st`,
    ]);
  });

  it("is a no-op with changed: false when no rule matches (second run)", async () => {
    const calls = stubApi([CATCH_ALL]);
    const out = await emailCommand([
      "unforward",
      "test",
      "--zone",
      "example.com",
    ]);
    expect(writes(calls)).toEqual([]);
    expect(out).toContain("changed: false");
    expect(out).not.toContain("removed");
    expect(out).toContain("nothing changed");
  });

  it("leaves a multi-matcher rule alone", async () => {
    const multi: EmailRule = {
      ...TEST_RULE,
      matchers: [
        ...TEST_RULE.matchers,
        { type: "literal", field: "from", value: "boss@corp.example" },
      ],
    };
    const calls = stubApi([CATCH_ALL, multi]);
    const out = await emailCommand([
      "unforward",
      "test",
      "--zone",
      "example.com",
    ]);
    expect(writes(calls)).toEqual([]);
    expect(out).toContain("changed: false");
  });

  it("'*' disables the catch-all via PUT, keeping name and action", async () => {
    const calls = stubApi([CATCH_ALL, TEST_RULE]);
    const out = await emailCommand(["unforward", "*", "--zone", "example.com"]);
    expect(writes(calls)).toEqual([
      {
        method: "PUT",
        path: `/zones/${ZONE_ID}/email/routing/rules/catch_all`,
        body: {
          name: "catch-all to gmail",
          enabled: false,
          matchers: [{ type: "all" }],
          actions: [{ type: "forward", value: ["inbox@gmail.example"] }],
        },
      },
    ]);
    expect(out).toContain("changed: true");
    expect(out).toContain("catch-all now disabled");
    expect(out).toContain("now rejected");
    expect(out).toContain("email forward '*' <destination>");
  });

  it("'*' on an already disabled catch-all is a no-op", async () => {
    const calls = stubApi([{ ...CATCH_ALL, enabled: false }]);
    const out = await emailCommand(["unforward", "*", "--zone", "example.com"]);
    expect(writes(calls)).toEqual([]);
    expect(out).toContain("changed: false");
  });

  it("rejects a missing target with a usage hint", async () => {
    stubApi([]);
    await expect(
      emailCommand(["unforward", "--zone", "example.com"]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
