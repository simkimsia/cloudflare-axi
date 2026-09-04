import { describe, expect, it } from "vitest";
import {
  assertNoArgs,
  rejectExtraArgs,
  takeBoolFlag,
  takeFlag,
  takePositional,
} from "../src/args.js";
import { AxiError } from "../src/errors.js";

describe("assertNoArgs", () => {
  it("accepts an empty argv", () => {
    expect(() => assertNoArgs("pages", [])).not.toThrow();
  });

  it("rejects unknown flags by name with a VALIDATION_ERROR", () => {
    try {
      assertNoArgs("pages", ["--json"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      const axiError = error as AxiError;
      expect(axiError.code).toBe("VALIDATION_ERROR");
      expect(axiError.message).toContain("--json");
      expect(axiError.message).toContain("pages");
    }
  });

  it("rejects stray positional arguments", () => {
    expect(() => assertNoArgs("whoami", ["extra"])).toThrow(/unknown argument/);
  });
});

describe("takeFlag", () => {
  it("takes --flag value and --flag=value, removing them from args", () => {
    const a = ["dns", "--zone", "example.com"];
    expect(takeFlag(a, "--zone")).toBe("example.com");
    expect(a).toEqual(["dns"]);
    const b = ["--zone=example.com", "dns"];
    expect(takeFlag(b, "--zone")).toBe("example.com");
    expect(b).toEqual(["dns"]);
  });

  it("returns undefined when absent and rejects a missing value", () => {
    expect(takeFlag(["dns"], "--zone")).toBeUndefined();
    expect(() => takeFlag(["--zone"], "--zone")).toThrow(/requires a value/);
    expect(() => takeFlag(["--zone", "--other"], "--zone")).toThrow(
      /requires a value/,
    );
    expect(() => takeFlag(["--zone="], "--zone")).toThrow(/requires a value/);
  });
});

describe("takeBoolFlag / takePositional", () => {
  it("takes a bare or =true/false boolean flag", () => {
    const a = ["x", "--commit-dirty"];
    expect(takeBoolFlag(a, "--commit-dirty")).toBe(true);
    expect(a).toEqual(["x"]);
    expect(takeBoolFlag(["--commit-dirty=false"], "--commit-dirty")).toBe(
      false,
    );
    expect(takeBoolFlag([], "--commit-dirty")).toBe(false);
    expect(() =>
      takeBoolFlag(["--commit-dirty=maybe"], "--commit-dirty"),
    ).toThrow(/true or false/);
  });

  it("takes the first positional, leaving flags (value flags must be taken first)", () => {
    const a = ["--verbose", "dns"];
    expect(takePositional(a)).toBe("dns");
    expect(a).toEqual(["--verbose"]);
    expect(takePositional(["--only-flags"])).toBeUndefined();
  });
});

describe("rejectExtraArgs", () => {
  it("passes on empty leftovers", () => {
    expect(() => rejectExtraArgs("email", [], "usage")).not.toThrow();
  });

  it("names every leftover flag and positional with usage hints", () => {
    try {
      rejectExtraArgs(
        "email dns",
        ["--json", "extra", "--x"],
        "cloudflare-axi email dns --zone <z>",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const axiError = error as AxiError;
      expect(axiError.code).toBe("VALIDATION_ERROR");
      expect(axiError.message).toBe(
        "unknown flags --json, --x; unexpected argument extra for `email dns`",
      );
      expect(axiError.suggestions).toEqual([
        "cloudflare-axi email dns --zone <z>",
        "cloudflare-axi email --help",
      ]);
    }
  });
});
