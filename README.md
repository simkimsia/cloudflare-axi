# cloudflare-axi

An [AXI](https://axi.md)-compliant wrapper around the
[Cloudflare](https://www.cloudflare.com) CLI (`wrangler`) — token-efficient
[TOON](https://toonformat.dev) output, structured errors, and agent-first
ergonomics for AI coding agents that operate Cloudflare via shell.

Built on [`axi-sdk-js`](https://github.com/kunchenguid/axi), modeled on the
reference implementation [`gh-axi`](https://github.com/kunchenguid/gh-axi).

## Status

Early scaffold (v0). Read-only commands only.

## Requirements

- Node.js >= 20
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) installed
  and logged in (`wrangler login`, or `CLOUDFLARE_API_TOKEN` set)

## Usage

```sh
cloudflare-axi              # dashboard: this directory's Worker, or Pages projects
cloudflare-axi deployments  # recent deployments of the Worker configured in cwd
cloudflare-axi pages        # all Pages projects in your account
cloudflare-axi kv           # all Workers KV namespaces in your account
cloudflare-axi whoami       # logged-in Cloudflare account
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
help[2]:
  Run `wrangler pages deployment list --project-name <name>` for a project's deployments
  Run `cloudflare-axi whoami` to see which account this is
```

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
