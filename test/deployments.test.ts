import { describe, expect, it } from "vitest";
import {
  toDeploymentRows,
  type WranglerDeployment,
} from "../src/commands/deployments.js";
import { extractJson } from "../src/wrangler.js";

// Shape from wrangler 4.x `deployments list --json` (JSON.stringify of the
// API deployments array; field names verified against the wrangler source —
// no Worker existed on the live account to capture a real run).
const FIXTURE: WranglerDeployment[] = [
  {
    id: "deploy-1",
    source: "api",
    strategy: "percentage",
    author_email: "jane@example.com",
    created_on: new Date(Date.now() - 3 * 86400 * 1000).toISOString(),
    annotations: { "workers/message": "initial deploy" },
    versions: [{ version_id: "v1", percentage: 100 }],
  },
  {
    id: "deploy-2",
    created_on: new Date(Date.now() - 60 * 1000).toISOString(),
  },
];

describe("toDeploymentRows", () => {
  it("flattens deployments into minimal rows", () => {
    const rows = toDeploymentRows(FIXTURE);
    expect(rows[0]).toEqual({
      created: "3d ago",
      author: "jane@example.com",
      source: "api",
      message: "initial deploy",
    });
    expect(rows[1]).toEqual({
      created: "1m ago",
      author: "unknown",
      source: "unknown",
      message: "",
    });
  });
});

describe("extractJson", () => {
  it("skips the wrangler banner before the JSON document", () => {
    const stdout = ` ⛅️ wrangler 4.127.1\n────────────────────\n[{"id":"x"}]\n`;
    expect(JSON.parse(extractJson(stdout))).toEqual([{ id: "x" }]);
  });

  it("returns bannerless output unchanged", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
});
