import { cfGet } from "./api.js";
import { AxiError } from "./errors.js";

export interface ZoneRef {
  id: string;
  name: string;
  accountId: string;
  accountName?: string;
}

/** Subset of the `/zones` API object we use. */
export interface ApiZone {
  id: string;
  name: string;
  status?: string;
  account?: { id: string; name?: string };
}

export function isZoneId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value);
}

export function toZoneRef(zone: ApiZone): ZoneRef {
  return {
    id: zone.id,
    name: zone.name,
    accountId: zone.account?.id ?? "",
    accountName: zone.account?.name,
  };
}

/** `--zone` accepts a domain name (one lookup) or a 32-hex zone id (direct fetch). */
export async function resolveZone(nameOrId: string): Promise<ZoneRef> {
  if (isZoneId(nameOrId)) {
    return toZoneRef(await cfGet<ApiZone>(`/zones/${nameOrId}`));
  }
  const name = nameOrId.toLowerCase().replace(/\.$/, "");
  const zones = await cfGet<ApiZone[]>(
    `/zones?name=${encodeURIComponent(name)}`,
  );
  if (zones.length === 0) {
    throw new AxiError(
      `No zone named ${name} is visible to these credentials`,
      "NOT_FOUND",
      [
        "Zone names are the bare apex domain, e.g. example.com (or pass the 32-hex zone id)",
        "Run `cloudflare-axi whoami` to check which account is active",
      ],
    );
  }
  return toZoneRef(zones[0]);
}

interface ApiAccount {
  id: string;
  name: string;
}

/**
 * Account for account-scoped endpoints when no zone is given: the
 * CLOUDFLARE_ACCOUNT_ID env var, else the token's sole account. Multiple
 * accounts is an error naming them so the agent can pick one explicitly.
 */
export async function resolveAccountId(): Promise<string> {
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (envAccount) return envAccount;
  const accounts = await cfGet<ApiAccount[]>("/accounts?per_page=50");
  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) {
    throw new AxiError(
      "These credentials can see no Cloudflare account",
      "AUTH",
      ["Run `wrangler login`, or set CLOUDFLARE_API_TOKEN with account access"],
    );
  }
  const listed = accounts.map((a) => `${a.name} (${a.id})`).join(", ");
  throw new AxiError(
    `Multiple accounts visible, pick one: ${listed}`,
    "VALIDATION_ERROR",
    [
      "Pass --zone <domain> to use that zone's account",
      "Or set CLOUDFLARE_ACCOUNT_ID=<id>",
    ],
  );
}
