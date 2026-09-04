# cloudflare-axi

An [AXI](https://axi.md)-compliant wrapper around the
[Cloudflare](https://www.cloudflare.com) CLI (`wrangler`) — token-efficient
[TOON](https://toonformat.dev) output, structured errors, and agent-first
ergonomics for AI coding agents that operate Cloudflare via shell.

Built on [`axi-sdk-js`](https://github.com/kunchenguid/axi), modeled on the
reference implementation [`gh-axi`](https://github.com/kunchenguid/gh-axi).

## Status

Early scaffold (v0). Read commands, plus the first write commands on Pages
(`pages create`, `pages deploy`). Writes are explicit verbs that name their
target in full and print what changed; nothing is inferred from context.

## Requirements

- Node.js >= 20
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) installed
  and logged in (`wrangler login`, or `CLOUDFLARE_API_TOKEN` set)

Commands that wrap `wrangler` use whatever credentials `wrangler` uses.
Commands that call the Cloudflare REST API directly (currently `email`,
because `wrangler` has no Email Routing surface) use `CLOUDFLARE_API_TOKEN`
if set, else the OAuth token `wrangler login` stored in its config
(`~/.wrangler/config/default.toml`, or `~/Library/Preferences/.wrangler/...`
on macOS). That OAuth token carries the `email_routing` scope by default;
`wrangler whoami` lists the scopes you have.

## Install

Not on npm yet, so `npx -y cloudflare-axi` does not work. Install from a clone:

```sh
git clone https://github.com/simkimsia/cloudflare-axi
pnpm --prefix cloudflare-axi install
pnpm --prefix cloudflare-axi run build
pnpm --prefix cloudflare-axi link --global   # puts `cloudflare-axi` on PATH
```

Check it: `cloudflare-axi --version`. To update later, `git pull` in the clone
and run the build step again.

## Usage

```sh
cloudflare-axi              # dashboard: this directory's Worker, or Pages projects
cloudflare-axi deployments  # recent deployments of the Worker configured in cwd
cloudflare-axi pages        # all Pages projects in your account
cloudflare-axi pages create <name> [--production-branch main]
cloudflare-axi pages deploy <dir> --project <name> [--branch main]   # default branch main = production
cloudflare-axi pages deployments <name> [--environment production|preview]
cloudflare-axi kv           # all Workers KV namespaces in your account
cloudflare-axi whoami       # logged-in Cloudflare account
cloudflare-axi email --zone example.com            # Email Routing status, destinations, rules
cloudflare-axi email dns --zone example.com        # MX/SPF/DKIM Cloudflare expects vs live DNS
cloudflare-axi email rules --zone example.com      # routing rules incl. catch-all
cloudflare-axi email addresses                     # account destination addresses + verified state
cloudflare-axi --help
cloudflare-axi --version    # fast path, never loads the command graph
cloudflare-axi update       # self-update (built into axi-sdk-js)
```

Example output (TOON):

```
count: 2 Pages projects
projects[2]{name,domain,git,modified}:
  my-docs,my-docs.pages.dev,no,6 days ago
  my-book,my-book.pages.dev,yes,4 years ago
help[3]:
  Run `cloudflare-axi pages deployments <name>` for a project's deployments
  Run `cloudflare-axi pages deploy <dir> --project <name>` to publish a static directory
  Run `cloudflare-axi whoami` to see which account this is
```

## Agent skill

Install the bundled skill so your coding agent prefers `cloudflare-axi` over raw
`wrangler`, falls back to `wrangler` when a command is not wrapped yet, and
files the gap as an issue here (label `agent-reported-gap`):

```sh
npx skills add simkimsia/cloudflare-axi --skill cloudflare-axi -g
```

The skill is a discovery stub that defers to `cloudflare-axi --help` for current
command guidance. Source: [`skills/cloudflare-axi/SKILL.md`](skills/cloudflare-axi/SKILL.md).

## Development

```sh
pnpm install
pnpm run dev          # run from source (tsx)
pnpm test             # vitest (offline — real wrangler output as fixtures)
pnpm run build        # tsc -> dist/
pnpm run format:check
```

## License

MIT
