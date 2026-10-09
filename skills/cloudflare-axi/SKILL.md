---
name: cloudflare-axi
description: "Operate Cloudflare through the cloudflare-axi CLI - Workers deployments, deploys and secrets, Pages projects, KV namespaces, Email Routing, and account identity. Use whenever a task touches Cloudflare. Prefer it over raw `wrangler`; when a command is not wrapped yet, fall back to `wrangler` (or the REST API where wrangler has no surface) and report the gap as a GitHub issue on simkimsia/cloudflare-axi."
user-invocable: false
author: KimSia Sim (simkimsia)
metadata:
  hermes:
    tags: [cloudflare, wrangler, workers, pages, kv, deployments, email-routing]
    category: devops
---

# cloudflare-axi

Agent ergonomic wrapper around the Cloudflare CLI (`wrangler`). Prefer this over
raw `wrangler` for Cloudflare operations: TOON output, structured errors with
`code` and `help:` next steps, exit codes 0 success / 1 error / 2 usage.

## Setup

Install with `pnpm add -g @simkimsia/cloudflare-axi`, or run it without installing
via `npx -y @simkimsia/cloudflare-axi`. The README's Install section covers working
from a clone.

It wraps [`wrangler`](https://developers.cloudflare.com/workers/wrangler/), which must be installed and logged in
(`wrangler login, or set CLOUDFLARE_API_TOKEN`). If a command fails with `WRANGLER_NOT_INSTALLED`, ask the user to
install `wrangler`. `NOT_LINKED` means no Worker config (wrangler.toml / wrangler.jsonc) in the current directory; run from the Worker's directory or use `pages` / `kv` which do not need one.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed
copies go stale. Get the current source of truth from the CLI:

- `cloudflare-axi` for a dashboard of the current directory / account
- `cloudflare-axi --help` for global flags and the command index
- `cloudflare-axi <command> --help` for per-command usage

Today's surface: `deployments` (recent deployments of the Worker configured in cwd), `workers` (`workers deploy --dry-run`, `workers deploy --name <worker>`, `workers secret list [--name <worker>]`, `workers secret put <KEY> --name <worker>` with the value on stdin; `--config <path>` accepted throughout), `pages` (list projects; `pages create <name>`, `pages deploy <dir> --project <name>`, `pages deployments <name>`), `kv` (list namespaces; `kv create <title>`, `kv keys <namespace>` (stops at `--limit`, default 50, and says when more exist), `kv get <key> --namespace <title|id>` or `--binding <NAME>` (`--key <name>` in place of the positional for a key starting with `-`; put, delete and `get --binding` refuse such keys), `kv put <key> --namespace <title|id> --file <path>|--stdin`, `kv delete <key> --namespace <title|id>`; always the remote store), `whoami`, and `email` (Email Routing status / `dns` / `addresses` / `rules` for a `--zone`, plus `enable`, `add-destination <email>`, `forward <local-part|*> <destination>`, and `unforward <local-part|*>`, via the REST API since wrangler has no Email Routing commands; all writes are idempotent and `forward` refuses an unverified destination with code `UNVERIFIED`).

## When cloudflare-axi cannot do it

1. Try `cloudflare-axi <command>` first and read the structured error.
   Rerun with `AXI_DEBUG=1` to print each forwarded `wrangler` argv and REST method and path to stderr.
2. If the error is `VALIDATION_ERROR` with `Unknown command`, or the command
   exists but lacks the flag you need, fall back to raw `wrangler` and finish
   the user's task. Examples: `wrangler kv bulk put <file> --namespace-id <id>`, `wrangler tail`.
   For products wrangler does not cover (Email Routing writes, DNS records),
   fall back to the REST API with `curl` and `CLOUDFLARE_API_TOKEN` or the
   wrangler OAuth token; `cloudflare-axi email --help` says where that token lives.
3. Then report the gap so it gets wrapped. Search before filing:

   ```sh
   gh-axi issue list --repo simkimsia/cloudflare-axi --search "<wrangler subcommand>" --state all
   ```

   If nothing matches, file one (use `gh` if `gh-axi` is not installed):

   ```sh
   gh-axi issue create --repo simkimsia/cloudflare-axi --label agent-reported-gap \
     --title "feat: wrap \`wrangler <subcommand>\`" \
     --body "<template below>"
   ```

   Issue body template:

   ```
   ## What I tried
   `cloudflare-axi <command that failed>` -> `<error code and message>`

   ## What worked instead
   `wrangler <exact command>`

   ## Plain CLI result, with the exact argv the axi forwarded (AXI_DEBUG=1)
   <works / same failure / n/a>

   ## If same failure
   <should the axi shape the arguments, map the error, or document the limit?>

   ## What the agent needed from the output
   <fields / shape, e.g. "deployment id, status, created_at as a TOON table">

   ## Task context
   <one line on the user task that needed this>
   ```

   Tell the user you filed it and link the issue. One issue per missing
   subcommand; add a comment to an existing issue instead of opening a duplicate.

## Writes

Write commands: `pages create`, `pages deploy`, `workers deploy`, `workers secret put`, `kv create`, `kv put` and `kv delete`, plus the `email` writes above. `kv put` and `kv delete` need `--namespace <title|id>` named in full (`--binding` is refused for writes); `kv put` takes the value from `--file` or `--stdin`, never argv, and says whether it created or overwrote the key; `kv delete` refuses a key that does not exist. `pages deploy` defaults to `--branch main`, which is a production deploy; pass another `--branch` for a preview. It refuses a missing or empty directory before calling wrangler.

`workers deploy` deploys the wrangler config in cwd (or `--config`). A real deploy requires `--name <worker>`; it runs a `--dry-run` first and refuses when `--name` differs from the Worker the config deploys. Use `workers deploy --dry-run` for a local bundle check. `workers secret put <KEY> --name <worker>` reads the value from stdin only (`printf %s "$VALUE" | ...`), never prints it, and refuses a Worker that does not exist (wrangler would silently create one).

## Deliberately not wrapped (do not file)

Other mutating commands: `wrangler delete`, `wrangler pages project delete`, `wrangler d1 execute` with writes.
These are excluded by design in v0. Use `wrangler` directly, tell the user
you did so, and do not open an issue for them.

Not wrapped yet, but these CAN be filed as gaps: `wrangler tail`, `wrangler secret delete`, `wrangler secret bulk`, and `wrangler deploy --env <name>`.
