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
  (`wranglerJson` / `wranglerExec`, both taking optional `{ input, env, cwd }`).
  Non-zero exits route through `mapWranglerError`; a missing binary maps to
  `WRANGLER_NOT_INSTALLED`. `extractJson` tolerates the "⛅️ wrangler x.y.z"
  stdout banner. `run` always closes the child's stdin (writing `input` when
  given) so wrangler never waits on it. `wranglerExecWithOutput` points
  `WRANGLER_OUTPUT_FILE_PATH` at a private temp file and returns its parsed
  ND-JSON entries (`parseOutputEntries`) next to stdout.
- `src/debug.ts` — `AXI_DEBUG=1` prints each wrangler argv (from `run` in
  `src/wrangler.ts`) and each REST method and path (from `cfRequest`) to
  stderr, with `CLOUDFLARE_API_TOKEN` masked. Never headers or bodies.
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
- `src/config.ts` — global `--config <path>` for the directory-scoped
  commands (dashboard, `deployments`, `workers ...`). `takeConfig` validates
  the path (missing or a directory → `VALIDATION_ERROR`) and returns it
  absolute; `configArgs` + `configRunOptions` forward `--config <abs>` AND
  spawn wrangler with the config's directory as cwd, because wrangler resolves
  `main`/`assets` against the config but runs a custom `build.command`, reads
  `.env` and writes `.wrangler/` against the process cwd. A child cwd rather
  than wrangler's own global `--cwd` keeps older 4.x working. `configSuffix`
  threads `--config` into next-step hints; `withConfigContext` rewrites a
  NOT_LINKED under `--config` to name the config. `liftLeadingConfig` in
  `src/cli.ts` accepts a leading `--config` (the SDK rejects leading flags):
  alone it feeds the dashboard, otherwise it moves to the end of argv where
  the command parses or rejects it. Account-scoped commands reject it.
  `NOT_LINKED_SUGGESTIONS` in `src/errors.ts` makes every NOT_LINKED suggest
  `--config <path>`.
- `src/commands/workers.ts` — `workers deploy` (dry-run name check, then a
  real deploy that never forwards `--name`), `workers secret list|put`
  (value on stdin only; read-only `secret list` precheck before `put`;
  `stdinSource` is the test seam). Bare `workers` prints its help and points
  at `deployments`.
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
- `wrangler pages deployment list --project-name <n> --json` has the same
  display-key quirk, and its `Status` field is a pre-rendered relative time
  ("1 day ago"), not a status. Newest first. Missing project → "Project not
  found. ... [code: 8000007]".
- `wrangler pages deploy <dir>` is text-only (progress lines, then
  "✨ Deployment complete! Take a peek over at <url>" and, for non-production
  branches, "✨ Deployment alias URL: <url>"). It has no id or environment,
  so `pages deploy` looks the URL up in the deployment list afterwards. It
  publishes an EMPTY directory without complaint ("Uploaded 0 files"), which
  is why `assertDeployableDir` runs first. Missing project → 'The Pages
  project "x" does not exist.' (no numeric code). The wrapper always passes
  `--commit-dirty=true` so the cwd's git state never prompts.
- `wrangler pages project create <n>` is text-only ("✨ Successfully created
  the 'x' project. It will be available at https://x.pages.dev/ ..."); a
  taken name → "[code: 8000002]" → `ALREADY_EXISTS`. The production branch
  defaults to `main` on the wrangler side too.
- `wrangler deployments list` is directory-scoped: it needs a Worker name
  from a wrangler config in cwd (or `--config` / `--name`); without one it
  fails with "You need to provide a name for your Worker" → mapped to
  `NOT_LINKED` (same code as railway-axi and netlify-axi). `pages`/`kv` are
  account-scoped.
- wrangler 4.x has global `--config`/`-c` and `--cwd` (which `chdir`s before
  resolving a relative `--config`). Under `--config`, `main`, `base_dir`,
  `assets` and `site` resolve against the config's directory; `build.cwd`
  (default: process cwd), `--outdir` and `.env` do not.
- Error stderr is ANSI-colored and shaped like
  `✘ [ERROR] A request to the Cloudflare API (...) failed.` followed by an
  indented detail line such as `Authentication error [code: 10000]` or
  `This Worker does not exist on your account. [code: 10007]`, plus a
  trailing `🪵 Logs were written to ...` line. Non-interactive with no
  credentials: "In a non-interactive environment, it's necessary to set a
  CLOUDFLARE_API_TOKEN environment variable for wrangler to work."
- `WRANGLER_OUTPUT_FILE_PATH=<file>` makes wrangler append ND-JSON lines:
  `wrangler-session`, then `deploy` (`worker_name`, `version_id`,
  `worker_tag`, `targets`, `worker_name_overridden`; `version_id` is null on
  `--dry-run`), or `command-failed` (`code`, `message`). `targets` is a
  string[]: workers.dev URLs (with https://), route patterns, custom domains,
  `schedule: <cron>`, `Producer for <queue>`, `workflow: <name>`. Bindings
  and the "Total Upload: X / gzip: Y" size appear only in stdout (a
  "Binding Resource" table whose parenthesized detail holds var values,
  which `parseBindings` drops).
- `wrangler deploy` with no config in cwd: autoconfig (default on) fails with
  "Could not detect a directory containing static files"; with
  `--autoconfig=false`, "Missing entry-point to Worker script or to assets
  directory"; a bad `--config` gives "Could not read file: ... ENOENT".
  `workers deploy` prechecks for a config (find-up for wrangler.json /
  wrangler.jsonc / wrangler.toml) so these are backstops (`NOT_LINKED`).
- `wrangler secret list` prints JSON by default (`[{name, type}]`, no
  banner). Missing Worker → 'Worker "x" not found.' (`NOT_FOUND`); no config
  and no `--name` → "Required Worker name missing" (`NOT_LINKED`).
- `wrangler secret put <KEY>` reads the value from a non-TTY stdin and
  `trimEnd()`s it. Quirk: on a missing Worker it calls `createDraftWorker`
  and silently creates one, which is why `workers secret put` runs a
  read-only `secret list --name` first. Success line: "✨ Success! Uploaded
  secret <KEY>".
- Workers write paths (real `deploy`, `secret put`) are unit-tested only;
  live smoke covers `workers deploy --dry-run`, `secret list`, the `--name`
  mismatch refusal and the `secret put` NOT_FOUND precheck (2026-10-09,
  family-haze-bot). Never smoke a real deploy or put against a live Worker.
- The SDK routes `<command> <sub> --help` to `getCommandHelp(<command>)`, so
  one help text per top-level command covers all its subcommands.
- The SDK ships `update` as a reserved built-in, so `cloudflare-axi update`
  works with no code here; the npm package name resolves from `package.json`.

## Live smoke procedure for Pages writes

Tests are offline, so after touching `pages create` / `deploy`, smoke it for
real on a throwaway project and delete it afterwards:
`cloudflare-axi pages create cloudflare-axi-smoke`, deploy a one-file dir,
`cloudflare-axi pages deployments cloudflare-axi-smoke`, then
`wrangler pages project delete cloudflare-axi-smoke --yes`.

## Cloudflare REST API notes (verified live 2026-09-04)

- Email Routing: `GET /zones/{zone}/email/routing` (`enabled`, `status`,
  `synced`), `.../email/routing/dns` (records Cloudflare expects; the DKIM
  TXT is ~420 chars so rows compact it), `.../email/routing/rules` (includes
  the catch-all as a rule with matcher `{type: "all"}` and priority
  2147483647), `GET /accounts/{account}/email/routing/addresses`
  (`status: verified|unverified`, `verified` timestamp or null).
- Email Routing writes (from the 2026-09-03 manual setup, issue #2):
  `POST /zones/{zone}/email/routing/enable` (body `{}`; adds MX/SPF/DKIM
  when DNS is on Cloudflare), `POST /accounts/{account}/email/routing/addresses`
  `{email}` (sends the verification mail; there is no resend endpoint, so an
  existing unverified address is reported, never re-posted),
  `PUT .../email/routing/rules/catch_all` (the catch-all always exists, so
  it is never POSTed), `POST .../email/routing/rules` and
  `PUT .../email/routing/rules/{id}` for literal `to` rules, and
  `DELETE .../email/routing/rules/{id}` for `unforward` (the catch-all is
  disabled via PUT instead, since it cannot be deleted). `planForward`
  checks the destination is verified before any write, so 2054 is a
  fallback. Write paths are unit-tested via the pure planners; live runs
  cover the no-op and validation paths plus `forward`/`unforward` of a
  literal rule (2026-10-04), never the catch-all writes.
- The wrangler OAuth token (default `wrangler login` scopes) works for all of
  the above and for `GET /zones`. It does NOT cover `dns_records` (issue #4):
  that needs a scoped `CLOUDFLARE_API_TOKEN`.
- Error envelopes: `{"success":false,"errors":[{"code":N,"message":...}]}`.
  Seen: 10000 Authentication error (HTTP 403, also for a zone the token
  cannot see), 6003/6111 bad Authorization header (HTTP 400), 9109 Invalid
  zone identifier, 2054 Destination address is not verified (write side,
  mapped to `UNVERIFIED`).
- `email dns` also resolves live DNS via `node:dns` to report `ok` /
  `missing` / `differs` per record; tests inject a fake resolver.

## Conventions

- pnpm, Node >= 20, ES modules, TypeScript Node16 resolution
  (import specifiers end in `.js`), Vitest tests in `test/`.
- Tests are OFFLINE: they feed captured real wrangler output and API JSON as
  fixtures and never spawn the real binary or touch the network.
- Conventional commit messages (`feat:`, `fix:`, `docs:`). Releases are cut by
  release-please from these commits and published to npm by trusted publishing.
  Never hand-edit `CHANGELOG.md` or `.release-please-manifest.json`; release-please
  owns them and `guard-generated-files.yml` fails PRs that touch them.

## Maintaining this file

Keep entries concise and durable; point at the authoritative file rather than
restating what the code shows. Prefer rewriting or pruning over appending.
