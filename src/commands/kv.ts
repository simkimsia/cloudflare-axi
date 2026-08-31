import { assertNoArgs } from "../args.js";
import { renderHelp, renderList, renderOutput } from "../toon.js";
import { wranglerJson } from "../wrangler.js";

export const KV_HELP = `usage: cloudflare-axi kv
Lists all Workers KV namespaces in your account (title, id).
flags: none
examples:
  cloudflare-axi kv
`;

/** `wrangler kv namespace list` always emits raw JSON (there is no --json flag). */
export interface KvNamespace {
  id: string;
  title: string;
  supports_url_encoding?: boolean;
}

export async function kvCommand(args: string[]): Promise<string> {
  assertNoArgs("kv", args);
  const namespaces = await wranglerJson<KvNamespace[]>([
    "kv",
    "namespace",
    "list",
  ]);

  if (namespaces.length === 0) {
    return "namespaces: 0 KV namespaces found in this account";
  }

  return renderOutput([
    `count: ${namespaces.length} KV namespaces`,
    renderList(
      "namespaces",
      namespaces.map((n) => ({ title: n.title, id: n.id })),
    ),
    renderHelp([
      "Run `wrangler kv key list --namespace-id <id>` to list keys in a namespace",
    ]),
  ]);
}
