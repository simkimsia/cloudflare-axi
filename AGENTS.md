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
- `src/api.ts` — sole place that calls the Cloudflare REST API directly
  (`cfGet`), only for surfaces wrangler has no subcommand for (VISION.md:
  wrangler first). API failures map through `mapApiError` in `src/errors.ts`
  (numeric codes, not stderr text) into the same AxiError codes.
- `src/credentials.ts` — token for REST calls: `CLOUDFLARE_API_TOKEN`, else
  the OAuth token from wrangler's `config/default.toml` (candidate paths in
  `wranglerConfigCandidates`; legacy `~/.wrangler` wins, macOS otherwise
  writes to `~/Library/Preferences/.wrangler`). OAuth access tokens expire
  hourly; when `expiration_time` has passed we run `wrangler whoami`, which
  makes wrangler refresh and rewrite the file, then re-read it.
- `src/zones.ts` — `--zone` resolution: 32-hex → `GET /zones/{id}`, else
  `GET /zones?name=`. The zone object carries `account.id`, so account-scoped
  endpoints need no extra call when a zone is given (`resolveAccountId` is
  the no-zone fallback: `CLOUDFLARE_ACCOUNT_ID`, else the token's sole account).
- `src/args.ts` — `assertNoArgs` guards the no-flag commands; commands with
  flags use `takeFlag` / `takeBoolFlag` / `takePositional` then
  `rejectExtraArgs`, which names every leftover token with exit code 2
  (AXI §6). Take value flags before positionals so a flag's value is never
  mistaken for a positional.
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
- The SDK routes `<command> <sub> --help` to `getCommandHelp(<command>)`, so
  one help text per top-level command covers all its subcommands.
- The SDK ships `update` as a reserved built-in, so `cloudflare-axi update`
  works with no code here; the npm package name resolves from `package.json`.

## Cloudflare REST API notes (verified live 2026-09-04)

- Email Routing: `GET /zones/{zone}/email/routing` (`enabled`, `status`,
  `synced`), `.../email/routing/dns` (records Cloudflare expects; the DKIM
  TXT is ~420 chars so rows compact it), `.../email/routing/rules` (includes
  the catch-all as a rule with matcher `{type: "all"}` and priority
  2147483647), `GET /accounts/{account}/email/routing/addresses`
  (`status: verified|unverified`, `verified` timestamp or null).
- The wrangler OAuth token (default `wrangler login` scopes) works for all of
  the above and for `GET /zones`. It does NOT cover `dns_records` (issue #4):
  that needs a scoped `CLOUDFLARE_API_TOKEN`.
- Error envelopes: `{"success":false,"errors":[{"code":N,"message":...}]}`.
  Seen: 10000 Authentication error (HTTP 403, also for a zone the token
  cannot see), 6003/6111 bad Authorization header (HTTP 400), 9109 Invalid
  zone identifier, 2054 Destination address is not verified (write side).
- `email dns` also resolves live DNS via `node:dns` to report `ok` /
  `missing` / `differs` per record; tests inject a fake resolver.

## Conventions

- pnpm, Node >= 20, ES modules, TypeScript Node16 resolution
  (import specifiers end in `.js`), Vitest tests in `test/`.
- Tests are OFFLINE: they feed captured real wrangler output and API JSON as
  fixtures and never spawn the real binary or touch the network.
- Conventional commit messages (`feat:`, `fix:`, `docs:`) with an eye toward
  release-please later.

## Maintaining this file

Keep entries concise and durable; point at the authoritative file rather than
restating what the code shows. Prefer rewriting or pruning over appending.
