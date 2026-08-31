# Project agent memory

Project-intrinsic knowledge for agents working on cloudflare-axi.

## What this is

An AXI-compliant wrapper around the Cloudflare CLI (`wrangler`), built on
`axi-sdk-js` (`runAxiCli` in `src/cli.ts`) and deliberately modeled on the
reference implementation [gh-axi](https://github.com/kunchenguid/gh-axi) and
the sibling `railway-axi`. When adding a capability, check how gh-axi solved
the analogous problem first, and follow the AXI principles (the `axi` skill in
the upstream `kunchenguid/axi` repo).

## Architecture

- `bin/cloudflare-axi.ts` — entrypoint; answers bare `-v`/`-V`/`--version` via
  `axi-sdk-js/fast-path` before dynamically importing `src/cli.ts`.
  `src/version.ts` must stay a LEAF module (node builtins only) or the fast
  path silently stops being fast.
- `src/wrangler.ts` — sole place that spawns the `wrangler` binary
  (`wranglerJson` / `wranglerExec`). Non-zero exits route through
  `mapWranglerError`; a missing binary maps to `WRANGLER_NOT_INSTALLED`.
  `extractJson` tolerates the "⛅️ wrangler x.y.z" stdout banner.
- `src/errors.ts` — `mapWranglerError` strips ANSI first (wrangler colors its
  stderr), then walks `patterns` in order and returns on the first regex hit,
  so order is the contract: narrow patterns before broad ones (same rule as
  gh-axi's `mapGhError`). Verify new patterns against real wrangler stderr
  before adding them.
- `src/args.ts` — v0 commands take no args/flags; `assertNoArgs` rejects
  unknown input by name with exit code 2 before any wrangler call (AXI §6).
- Commands live in `src/commands/`, return TOON strings via `src/toon.ts`
  helpers; errors render through the `formatError` hook in `src/cli.ts`
  because the SDK's default formatter only recognizes its own AxiError class.

## Wrangler CLI notes (verified against wrangler 4.127.1)

- `wrangler whoami` is text-only and — quirk — exits 0 even when logged out,
  printing "You are not authenticated. Please run `wrangler login`." on
  stdout. `parseWhoami` in `src/commands/whoami.ts` detects that and the
  command throws a structured AUTH error.
- `wrangler pages project list --json` emits display-oriented keys
  ("Project Name", "Last Modified" as pre-rendered relative time), not API
  field names.
- `wrangler kv namespace list` always emits raw JSON; there is no `--json`
  flag (passing one is an error).
- `wrangler deployments list` is directory-scoped: it needs a Worker name
  from a wrangler config in cwd (or `--name`); without one it fails with
  "You need to provide a name for your Worker" → mapped to `NOT_CONFIGURED`
  (the analog of railway-axi's `NOT_LINKED`). `pages`/`kv` are account-scoped.
- Error stderr is ANSI-colored and shaped like
  `✘ [ERROR] A request to the Cloudflare API (...) failed.` followed by an
  indented detail line such as `Authentication error [code: 10000]` or
  `This Worker does not exist on your account. [code: 10007]`, plus a
  trailing `🪵 Logs were written to ...` line. Non-interactive with no
  credentials: "In a non-interactive environment, it's necessary to set a
  CLOUDFLARE_API_TOKEN environment variable for wrangler to work."
- The SDK ships `update` as a reserved built-in, so `cloudflare-axi update`
  works with no code here; the npm package name resolves from `package.json`.

## Conventions

- pnpm, Node >= 20, ES modules, TypeScript Node16 resolution
  (import specifiers end in `.js`), Vitest tests in `test/`.
- Tests are OFFLINE: they feed captured real wrangler output as fixtures and
  never spawn the real binary.
- Conventional commit messages (`feat:`, `fix:`, `docs:`) with an eye toward
  release-please later.

## Maintaining this file

Keep entries concise and durable; point at the authoritative file rather than
restating what the code shows. Prefer rewriting or pruning over appending.
