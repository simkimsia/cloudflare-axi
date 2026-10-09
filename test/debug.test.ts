import { afterEach, describe, expect, it, vi } from "vitest";
import { cfGet } from "../src/api.js";
import { debugLine, debugWrangler, shellQuote } from "../src/debug.js";

const TOKEN = "cf-test-token-0123456789abcdef";

function captureStderr() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  return { lines, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shellQuote", () => {
  it("leaves plain tokens bare and quotes the rest", () => {
    expect(shellQuote("--project-name")).toBe("--project-name");
    expect(shellQuote("my docs")).toBe("'my docs'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("O'Brien")).toBe(`'O'\\''Brien'`);
  });
});

describe("AXI_DEBUG", () => {
  it("prints the forwarded wrangler argv to stderr when AXI_DEBUG=1", () => {
    vi.stubEnv("AXI_DEBUG", "1");
    const { lines } = captureStderr();
    debugWrangler(["pages", "deploy", "./my site", "--project-name", "docs"]);
    expect(lines).toEqual([
      "[axi-debug] wrangler pages deploy './my site' --project-name docs\n",
    ]);
  });

  it("prints a secret put argv with KEY and --name; the value never reaches argv", () => {
    vi.stubEnv("AXI_DEBUG", "1");
    const { lines } = captureStderr();
    debugWrangler(["secret", "put", "API_KEY", "--name", "my-worker"]);
    expect(lines).toEqual([
      "[axi-debug] wrangler secret put API_KEY --name my-worker\n",
    ]);
  });

  it("prints nothing when AXI_DEBUG is unset or not 1", () => {
    const { lines } = captureStderr();
    vi.stubEnv("AXI_DEBUG", "");
    debugWrangler(["whoami"]);
    vi.stubEnv("AXI_DEBUG", "true");
    debugWrangler(["whoami"]);
    expect(lines).toEqual([]);
  });

  it("masks the API token wherever it appears", () => {
    const out: string[] = [];
    debugLine(`wrangler x --token ${TOKEN}`, (t) => out.push(t), {
      AXI_DEBUG: "1",
      CLOUDFLARE_API_TOKEN: TOKEN,
    });
    expect(out).toEqual(["[axi-debug] wrangler x --token <redacted>\n"]);
  });

  it("prints method and path for a REST call, never the token or headers", async () => {
    vi.stubEnv("AXI_DEBUG", "1");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", TOKEN);
    const { lines } = captureStderr();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stdoutWrite = vi.spyOn(process.stdout, "write");
    await cfGet("/zones?name=example.com");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(lines).toEqual(["[axi-debug] GET /zones?name=example.com\n"]);
    expect(lines.join("")).not.toContain(TOKEN);
    expect(lines.join("")).not.toContain("Bearer");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
