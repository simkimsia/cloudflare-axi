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
  (`wranglerJson` / `wranglerExec`, both taking optional `{ input, env, cwd }`;
  `wranglerBytes` for undecoded stdout with a 32 MiB buffer and a distinct
  `WranglerOutputTooLargeError`). Non-zero exits route through
  `mapWranglerError`; a missing binary maps to `WRANGLER_NOT_INSTALLED`.
  `extractJson` tolerates the "⛅️ wrangler x.y.z" stdout banner. `run`
  always closes the child's stdin (writing `input` when given) so wrangler
  never waits on it. `wranglerExecWithOutput` points
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
  (`cfGet`/`cfRequest`; `cfGetPage` adds `result_info` for cursor paging;
  `cfGetBytes` reads raw-body endpoints such as KV values), only for surfaces
  wrangler has no subcommand for (VISION.md: wrangler first). API failures
  map through `mapApiError` in `src/errors.ts` (numeric codes, not stderr
  text) into the same AxiError codes, as a `CloudflareApiError` that keeps
  `apiCodes` for callers that branch on them.
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
  threads `--config` into next-step hints (absolute, `shellQuote`d);
  `wranglerConfigSuffix` adds `--cwd <config dir>` to raw `wrangler` hints so
  they read the same `.env` and build dir as the wrapper; `withConfigContext` rewrites a
  NOT_LINKED under `--config` to name the config. `liftLeadingConfig` in
  `src/cli.ts` accepts a leading `--config` (the SDK rejects leading flags):
  alone it feeds the dashboard, otherwise it moves to the end of argv where
  the command parses or rejects it. Account-scoped commands reject it.
  `NOT_LINKED_SUGGESTIONS` in `src/errors.ts` makes every NOT_LINKED suggest
  `--config <path>`.
- `src/commands/workers.ts` — `workers deploy` (dry-run name check, then a
  real deploy that never forwards `--name`), `workers secret list|put`
  (value on stdin only; read-only `secret list` precheck before `put`;
  `stdinSource` is the test seam), `workers delete` and
  `workers secret delete` (both prechecked read-only with
  `secret list --name`, so an unknown Worker or secret is NOT_FOUND with
  nothing deleted). `workers list` is REST-only (wrangler has no command
  that lists Workers): the scripts list and the account subdomain, then
  per-Worker `schedules` and `subdomain` reads, at most 6 in flight, which
  degrade to `unknown` with a help line rather than fail the list. Its
  account comes from `workersAccountId`, shared with `delete`;
  `listWorkerScripts` also feeds the dashboard's `workers[n]` block (scripts
  list only, a failure shown as `could not list (<code>)`). Bare `workers`
  prints its help and points at `deployments`. A user's `--config` is carried, absolute and
  shell-quoted (`configSuffix` / `shellQuote` in `src/config.ts`), into every
  follow-up hint, including `workers` and `deployments` commands suggested by
  mapped wrangler errors (`carryConfig`). Without the ND-JSON `deploy` entry (or its
  `targets`), a real deploy reports urls/crons as `unknown`, never `none`.
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
  flag (passing one is an error). `wrangler kv key list` is the same
  (`[{name, expiration?, metadata?}]`, all pages fetched).
- `wrangler kv key list/get/put/delete` default to LOCAL storage (an empty
  local list returns `[]`, not an error), so every `kv` subcommand passes
  `--remote`. `key get` writes the raw value to stdout with no banner and no
  trailing newline; a missing key AND a missing namespace both give
  "Failed to fetch .../values/<key> - 404: Not Found", which is why `kv`
  resolves `--namespace <title|id>` against `kv namespace list` first. An
  unknown `--namespace-id` on `key list` gives "[code: 10013]".
  `key list` pages through EVERY matching key and has no limit flag, and
  there is no metadata-only existence check, so for a `--namespace` target
  `kv keys`, `kv get` and the put/delete existence probe use REST (see the
  KV REST notes below); `--binding` can only be resolved by wrangler, so
  `kv keys --binding` and `kv get --binding` stay on it (`wranglerBytes`,
  32 MiB; an overflowing binding listing suggests `--namespace`). Writes
  stay on wrangler; `key delete` succeeds on a missing key, hence the probe.
  `--binding` resolves through the wrangler config in cwd; writes refuse it
  (VISION.md Safety: the target is named, not inferred). Through a binding,
  a values 404 also means the binding's namespace was deleted, so that
  NOT_FOUND names both causes.
- wrangler's yargs reads a key starting with `-` as a flag and has no
  escape: `key get -- -k`, `key get --key=-k` and bare `-k` all fail with
  "Not enough non-option arguments" (4.127.1, verified live read-only). So
  `--key <name>` exists for such keys, `kv get --namespace` reads them over
  REST, and put, delete and `get --binding` refuse them (VALIDATION_ERROR).
- `wrangler kv namespace create <title>` is text-only and prints a
  `[[kv_namespaces]]` snippet with the new id (TOML or JSON by the cwd config
  format). With a wrangler.jsonc in cwd it may offer to patch the config, so
  `kv create` passes `--update-config=false`. A taken title →
  'A KV namespace with the title "x" already exists.' → `ALREADY_EXISTS`.
  Verified live 2026-10-12 (#45, wrangler 4.127.1): `kv create` parsed the
  id and showed the toml and jsonc snippets, and a rerun gave
  `ALREADY_EXISTS`. `kv put --stdin` created then overwrote; `--file` with
  `--ttl 60` created with the TTL (`--ttl 30` and a missing file gave
  `VALIDATION_ERROR`); `kv delete` deleted and a rerun gave `NOT_FOUND`.
  `kv get` / `kv keys --binding` worked from a project dir, an unknown
  binding gave `NOT_LINKED` and `kv put --binding` was refused.
- `wrangler kv namespace delete` (4.127.1 source) takes exactly one of a
  positional title, `--binding` or `--namespace-id`, prints "About to
  delete ..." and asks "Ok to proceed?" unless `--skip-confirmation` / `-y`
  (also present in 4.103). `kv drop` resolves the title or id itself
  (exact match, NOT_FOUND before any write), counts keys with one REST
  request (limit 1000, never a cursor walk; a returned cursor makes it
  "N+"), then runs it with `--namespace-id`
  and `--skip-confirmation`. Not yet smoke-tested live.
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
  "Could not detect a directory containing static files" (backstop,
  `NOT_LINKED`); a bad `--config` gives "Could not read file: ... ENOENT".
  `workers deploy` prechecks for a config (find-up for wrangler.json /
  wrangler.jsonc / wrangler.toml). "Missing entry-point to Worker script or
  to assets directory" comes from a config with `name` but no `main` or
  `[assets]` (also from no config with `--autoconfig=false`), so it maps to
  `VALIDATION_ERROR` "wrangler config has no entry point".
- Broken paths in a deploy config (captured live 2026-10-12, `--dry-run`):
  a missing `main` file → 'The entry-point file at "src/worker.js" was not
  found.' (or, with `[build] command`, 'The expected output file at "…" was
  not found after running custom build: …'); a missing `[assets] directory`
  → 'The directory specified by the "assets.directory" field in your
  configuration file does not exist:' with the absolute path on the next
  line ("doesn't point to a directory:" for a file). All map to
  `VALIDATION_ERROR` naming the path, ahead of the catch-all "not found"
  (#43, #44).
- `wrangler secret list` prints JSON by default (`[{name, type}]`, no
  banner). Missing Worker → 'Worker "x" not found.' (`NOT_FOUND`); no config
  and no `--name` → "Required Worker name missing" (`NOT_LINKED`).
- `wrangler secret put <KEY>` reads the value from a non-TTY stdin and
  `trimEnd()`s it. Quirk: on a missing Worker it calls `createDraftWorker`
  and silently creates one, which is why `workers secret put` runs a
  read-only `secret list --name` first. Success line: "✨ Success! Uploaded
  secret <KEY>".
- `wrangler delete` (4.127.1 `src/delete.ts`) has no skip-confirmation
  flag. Its `--force` skips both prompts ("Are you sure you want to delete
  <name>?" and the "is currently in use by other Workers" one) and the
  dependents check itself, and non-interactively (wrangler always runs with
  piped stdio here) both prompts auto-confirm, so a plain run would break
  dependents silently too. `workers delete` therefore reads the same two
  endpoints wrangler does,
  `GET /accounts/{a}/workers/scripts/{name}/references` and
  `.../workers/tails/by-consumer/{name}` (`listDependents`) in the account
  wrangler deletes from (`configAccountId`: the `--config` or find-up
  config's top-level `account_id`, read with a real TOML parser
  (`smol-toml`) or as JSONC, which wrangler prefers, then
  `CLOUDFLARE_ACCOUNT_ID`, then the token's sole account), refuses when
  anything depends on the Worker unless `--force`, then always runs
  `wrangler delete --name <n> --force`. Success line: "Successfully deleted
  <name>"; it also deletes Workers Sites asset namespaces ('Deleted asset
  namespace for Workers Site "<title>"'). Without `--name` wrangler would
  fall back to the cwd config's name, which is why `--name` is required.
- `wrangler secret delete <KEY> --name <w>` has no skip-confirmation flag
  either; its prompt auto-confirms non-interactively. It never creates a
  draft Worker, but `workers secret delete` still prechecks with
  `secret list --name` for NOT_FOUND on a missing Worker or key. Success
  line: "✨ Success! Deleted secret <KEY>". Neither delete path has been
  smoke-tested live yet.
- Workers write paths were smoke-tested live on 2026-10-12 on a throwaway
  Worker (#45, wrangler 4.127.1): `workers deploy --name --config` listed the
  version id, the workers.dev url and the crons, and a `--name` mismatch was
  refused with no Worker created; `secret put` created then updated, with
  the value absent from the output and from `AXI_DEBUG=1`; `--name` of a
  missing Worker gave `NOT_FOUND` after only `secret list`, with no draft
  Worker. Read-only paths (`deploy --dry-run`, `secret list`) were checked
  on 2026-10-09 (family-haze-bot). Live smokes use throwaway
  `axi-smoke-<date>-*` names and must clean up afterwards: delete a
  throwaway Worker (its secrets go with it) with
  `cloudflare-axi workers delete --name <worker>`, a single secret with
  `cloudflare-axi workers secret delete <KEY> --name <worker>`, and a
  throwaway KV namespace with `cloudflare-axi kv drop <title>`. Never
  smoke a real deploy, put or delete against a real Worker.
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
- Workers KV (verified live 2026-10-09, read-only; account from
  `resolveAccountId`, since wrangler's namespace list has no account id):
  `GET /accounts/{a}/storage/kv/namespaces/{ns}/keys?prefix=&limit=&cursor=`
  (`limit` must be 10..1000, else 400 code 10028; `result_info.cursor` is ""
  on the last page), `.../metadata/{key}` (200 with `result: null` for a key
  without metadata, so 200 means it exists), `.../values/{key}` (raw bytes,
  `application/octet-stream`, not the JSON envelope; errors still are). Keys
  are URL-encoded in the path. A missing key is 404 code 10009 ("get: 'key
  not found'" / "metadata: 'key not found'"), a missing namespace 404 code
  10013; a bad token 401 code 10000 (AUTH).
- Workers list (from the Cloudflare API docs and wrangler 4.127.1 source;
  not yet run live): `GET /accounts/{a}/workers/scripts` (Script objects:
  `id` is the name, `modified_on`, `routes` [{id, pattern, script}] or null;
  no crons or workers.dev flag), `GET /accounts/{a}/workers/subdomain`
  (`{subdomain}`, the account-wide `<subdomain>.workers.dev`; code 10007
  when none is registered), `.../workers/scripts/{name}/schedules`
  (`{schedules: [{cron}]}`) and `.../workers/scripts/{name}/subdomain`
  (`{enabled, previews_enabled}`).
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
