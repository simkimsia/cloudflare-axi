import { describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { AxiError as SdkAxiError } from "axi-sdk-js";
import { UNKNOWN_SUGGESTION } from "../src/errors.js";

const { runAxiCli } = vi.hoisted(() => ({ runAxiCli: vi.fn() }));
vi.mock("axi-sdk-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("axi-sdk-js")>()),
  runAxiCli,
}));

async function formatError(error: unknown) {
  const { main } = await import("../src/cli.js");
  await main();
  return runAxiCli.mock.calls[0]![0].formatError(error);
}

describe("formatError", () => {
  it("keeps the SDK's own AxiError code, help and exit code", async () => {
    const { output, exitCode } = await formatError(
      new SdkAxiError("Unknown update option: --bogus", "VALIDATION_ERROR", [
        "Run `cloudflare-axi update --help`",
      ]),
    );
    expect(decode(output.trim())).toEqual({
      error: "Unknown update option: --bogus",
      code: "VALIDATION_ERROR",
      help: ["Run `cloudflare-axi update --help`"],
    });
    expect(exitCode).toBe(2);
  });

  it("renders a help next step for foreign thrown errors", async () => {
    const { output, exitCode } = await formatError(new Error("boom"));
    expect(decode(output.trim())).toEqual({
      error: "boom",
      code: "UNKNOWN",
      help: [UNKNOWN_SUGGESTION],
    });
    expect(exitCode).toBe(1);
  });
});
