import { describe, expect, it } from "vitest";
import { assertNoArgs } from "../src/args.js";
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
