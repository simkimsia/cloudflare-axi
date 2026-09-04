# Vision

`cloudflare-axi` is an agent-ergonomic interface to Cloudflare. It wraps the official CLI, `wrangler`, first, and calls the Cloudflare REST API only where `wrangler` has no surface.

## Scope

We aim for functional parity with `wrangler` on the surfaces agents operate: Workers, Pages, KV, and account identity.
Every capability available through `wrangler` should eventually be accessible through an AXI-native interface.

Cloudflare products that `wrangler` does not cover, such as DNS records and Email Routing, are in scope when a command maps onto a documented Cloudflare API endpoint and reuses the credentials `wrangler` already holds or a scoped `CLOUDFLARE_API_TOKEN`.

We accept contributions that expose existing Cloudflare capabilities more ergonomically.
We do not add functionality that Cloudflare itself does not provide, and we do not embed workflow logic that belongs in the calling agent.

## Interface

The interface must follow validated AXI principles and optimize for autonomous agent use.

Output may be structured, but its structure exists for agent comprehension rather than as a stable API for imperative programs.
Human-oriented presentation and compatibility work primarily serving hand-written parsers are not goals.

Errors carry a stable code and a next step the agent can act on.
The wrapper may reshape, combine, or simplify `wrangler` and API operations when doing so improves agent ergonomics without expanding the underlying capability.

## Safety

Read commands are the default and never change account state.
Write commands are explicit, named as verbs, and print what changed.
A command that deletes or overwrites requires the target to be named in full. It never infers it from context.
