import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDeployableDir,
  parseCreateOutput,
  parseDeployOutput,
  toDeploymentRows,
  toPagesRows,
  type PagesDeploymentRow,
  type PagesProjectRow,
} from "../src/commands/pages.js";

// Real `wrangler pages project list --json` output (wrangler 4.127.1) —
// note the display-oriented keys and pre-rendered relative times.
const FIXTURE: PagesProjectRow[] = [
  {
    "Project Name": "codeassure-docs",
    "Project Domains": "codeassure-docs.pages.dev, docs.example.com",
    "Git Provider": "No",
    "Last Modified": "6 days ago",
  },
  {
    "Project Name": "private-llmmrr-book",
    "Project Domains": "private-llmmrr-book.pages.dev",
    "Git Provider": "Yes",
    "Last Modified": "4 years ago",
  },
];

describe("toPagesRows", () => {
  it("flattens display-keyed projects into minimal rows", () => {
    expect(toPagesRows(FIXTURE)).toEqual([
      {
        name: "codeassure-docs",
        domain: "codeassure-docs.pages.dev",
        git: "no",
        modified: "6 days ago",
      },
      {
        name: "private-llmmrr-book",
        domain: "private-llmmrr-book.pages.dev",
        git: "yes",
        modified: "4 years ago",
      },
    ]);
  });

  it("tolerates a project with no domains", () => {
    const rows = toPagesRows([
      {
        "Project Name": "bare",
        "Project Domains": "",
        "Git Provider": "No",
        "Last Modified": "just now",
      },
    ]);
    expect(rows[0].domain).toBe("none");
  });
});

// Real `wrangler pages deployment list --project-name x --json` output
// (wrangler 4.127.1, captured live 2026-09-04): "Status" is a relative time.
const DEPLOYMENTS: PagesDeploymentRow[] = [
  {
    Id: "f2b34549-7b81-41b0-b04f-ba8bbf8b088d",
    Environment: "Production",
    Branch: "main",
    Source: "c9b77cc",
    Deployment: "https://f2b34549.cloudflare-axi-smoke.pages.dev",
    Status: "14 seconds ago",
    Build:
      "https://dash.cloudflare.com/acc/pages/view/cloudflare-axi-smoke/f2b34549-7b81-41b0-b04f-ba8bbf8b088d",
  },
  {
    Id: "2fe2c7f2-cac4-4cc2-b1db-e463122287e6",
    Environment: "Preview",
    Branch: "preview-x",
    Source: "",
    Deployment: "https://2fe2c7f2.cloudflare-axi-smoke.pages.dev",
    Status: "28 seconds ago",
    Build: "",
  },
];

describe("toDeploymentRows", () => {
  it("shortens ids, lowercases the environment, and keeps the relative time", () => {
    expect(toDeploymentRows(DEPLOYMENTS)).toEqual([
      {
        id: "f2b34549",
        env: "production",
        branch: "main",
        source: "c9b77cc",
        url: "https://f2b34549.cloudflare-axi-smoke.pages.dev",
        created: "14 seconds ago",
      },
      {
        id: "2fe2c7f2",
        env: "preview",
        branch: "preview-x",
        source: "-",
        url: "https://2fe2c7f2.cloudflare-axi-smoke.pages.dev",
        created: "28 seconds ago",
      },
    ]);
  });
});

// Real `wrangler pages deploy` stdout (wrangler 4.127.1, captured live
// 2026-09-04; banner lines elided).
const DEPLOY_PRODUCTION = `Uploading... (0/1)
Uploading... (1/1)
✨ Success! Uploaded 1 files (1.26 sec)

🌎 Deploying...
✨ Deployment complete! Take a peek over at https://361a9b59.cloudflare-axi-smoke.pages.dev
`;

const DEPLOY_PREVIEW = `Uploading... (1/1)
✨ Success! Uploaded 0 files (1 already uploaded) (0.58 sec)

🌎 Deploying...
✨ Deployment complete! Take a peek over at https://2fe2c7f2.cloudflare-axi-smoke.pages.dev
✨ Deployment alias URL: https://preview-x.cloudflare-axi-smoke.pages.dev
`;

describe("parseDeployOutput", () => {
  it("extracts the deployment URL and upload count", () => {
    expect(parseDeployOutput(DEPLOY_PRODUCTION)).toEqual({
      url: "https://361a9b59.cloudflare-axi-smoke.pages.dev",
      uploaded: 1,
      alreadyUploaded: 0,
    });
  });

  it("extracts the alias URL and already-uploaded count for a branch deploy", () => {
    expect(parseDeployOutput(DEPLOY_PREVIEW)).toEqual({
      url: "https://2fe2c7f2.cloudflare-axi-smoke.pages.dev",
      aliasUrl: "https://preview-x.cloudflare-axi-smoke.pages.dev",
      uploaded: 0,
      alreadyUploaded: 1,
    });
  });

  it("returns no url when the shape changes", () => {
    expect(parseDeployOutput("something else").url).toBeUndefined();
  });
});

// Real `wrangler pages project create` stdout (wrangler 4.127.1).
const CREATE = `✨ Successfully created the 'cloudflare-axi-smoke' project. It will be available at https://cloudflare-axi-smoke.pages.dev/ once you create your first deployment.
To deploy a folder of assets, run 'wrangler pages deploy [directory]'.
`;

describe("parseCreateOutput", () => {
  it("extracts the project name and pages.dev URL without the trailing slash", () => {
    expect(parseCreateOutput(CREATE)).toEqual({
      name: "cloudflare-axi-smoke",
      url: "https://cloudflare-axi-smoke.pages.dev",
    });
  });
});

describe("assertDeployableDir", () => {
  it("accepts a directory with files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfaxi-"));
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
    expect(() => assertDeployableDir(dir)).not.toThrow();
  });

  it("rejects an empty directory (wrangler would publish 0 files)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfaxi-"));
    mkdirSync(join(dir, "empty"));
    expect(() => assertDeployableDir(join(dir, "empty"))).toThrow(/is empty/);
  });

  it("rejects a missing path and a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfaxi-"));
    writeFileSync(join(dir, "file.txt"), "x");
    expect(() => assertDeployableDir(join(dir, "nope"))).toThrow(
      /not a directory/,
    );
    expect(() => assertDeployableDir(join(dir, "file.txt"))).toThrow(
      /not a directory/,
    );
  });
});
