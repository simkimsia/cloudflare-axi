---
name: cloudflare-axi
description: "Operate Cloudflare through the cloudflare-axi CLI - Workers deployments, Pages projects, KV namespaces, and account identity. Use whenever a task touches Cloudflare. Prefer it over raw `wrangler`; when a command is not wrapped yet, fall back to `wrangler` and report the gap as a GitHub issue on simkimsia/cloudflare-axi."
user-invocable: false
author: KimSia Sim (simkimsia)
metadata:
  hermes:
    tags: [cloudflare, wrangler, workers, pages, kv, deployments]
    category: devops
---

# cloudflare-axi

Agent ergonomic wrapper around the Cloudflare CLI (`wrangler`). Prefer this over
raw `wrangler` for Cloudflare operations: TOON output, structured errors with
`code` and `help:` next steps, exit codes 0 success / 1 error / 2 usage.

## Setup

cloudflare-axi is not on npm yet. Run it from a clone:

```sh
git clone https://github.com/simkimsia/cloudflare-axi
pnpm --prefix cloudflare-axi install
pnpm --prefix cloudflare-axi run build
pnpm --prefix cloudflare-axi link --global   # puts `cloudflare-axi` on PATH
```

It wraps [`wrangler`](https://developers.cloudflare.com/workers/wrangler/), which must be installed and logged in
(`wrangler login, or set CLOUDFLARE_API_TOKEN`). If a command fails with `WRANGLER_NOT_INSTALLED`, ask the user to
install `wrangler`. `NOT_CONFIGURED` means no Worker config (wrangler.toml / wrangler.jsonc) in the current directory; run from the Worker's directory or use `pages` / `kv` which do not need one.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed
copies go stale. Get the current source of truth from the CLI:

- `cloudflare-axi` for a dashboard of the current directory / account
- `cloudflare-axi --help` for global flags and the command index
- `cloudflare-axi <command> --help` for per-command usage

Today's surface is read-only v0: `deployments` (recent deployments of the Worker configured in cwd), `pages` (Pages projects), `kv` (KV namespaces), `whoami`.

## When cloudflare-axi cannot do it

1. Try `cloudflare-axi <command>` first and read the structured error.
2. If the error is `VALIDATION_ERROR` with `Unknown command`, or the command
   exists but lacks the flag you need, fall back to raw `wrangler` and finish
   the user's task. Examples: `wrangler pages deployment list --project-name <name>`, `wrangler kv key list --namespace-id <id>`, `wrangler tail`.
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

   ## What the agent needed from the output
   <fields / shape, e.g. "deployment id, status, created_at as a TOON table">

   ## Task context
   <one line on the user task that needed this>
   ```

   Tell the user you filed it and link the issue. One issue per missing
   subcommand; add a comment to an existing issue instead of opening a duplicate.

## Deliberately not wrapped (do not file)

Mutating commands: `wrangler deploy`, `wrangler pages deploy`, `wrangler kv key put/delete`, `wrangler delete`, `wrangler secret put`, `wrangler d1 execute` with writes.
These are excluded by design in v0. Use `wrangler` directly, tell the user
you did so, and do not open an issue for them.
