import { describe, expect, it } from "vitest";
import { toPagesRows, type PagesProjectRow } from "../src/commands/pages.js";

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
