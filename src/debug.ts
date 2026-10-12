/**
 * `AXI_DEBUG=1` prints each forwarded wrangler argv and each REST call to
 * stderr, one line per call, so a gap can be reproduced with the exact command
 * the axi sent (axi-playbook: inherited gaps). stdout stays clean TOON.
 * Only the argv or method and path are printed, never headers or bodies.
 */

export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AXI_DEBUG === "1";
}

/** Single-quote a token for copy-paste into a POSIX shell, when it needs it. */
export function shellQuote(token: string): string {
  if (token !== "" && /^[A-Za-z0-9_\-./:=@,+%]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Mask secret env values (the API token) wherever they appear in a line. */
export function redactSecrets(
  line: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let out = line;
  for (const name of ["CLOUDFLARE_API_TOKEN"]) {
    const value = env[name];
    if (value) out = out.split(value).join("<redacted>");
  }
  return out;
}

export function debugLine(
  line: string,
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!debugEnabled(env)) return;
  write(`[axi-debug] ${redactSecrets(line, env)}\n`);
}

export function debugWrangler(args: string[], cwd?: string): void {
  const line = ["wrangler", ...args].map(shellQuote).join(" ");
  // A `--config` run spawns wrangler in the config's directory; say where.
  debugLine(cwd ? `${line}  # cwd: ${shellQuote(cwd)}` : line);
}

export function debugApi(method: string, path: string): void {
  debugLine(`${method} ${path}`);
}
