import { db } from "../db/index.js";
import { applications } from "../db/schema.js";
import { eq } from "drizzle-orm";

/**
 * Per-application IP allow/block lists.
 *
 * Entries may be exact IPs ("203.0.113.10") or CIDR ranges
 * ("203.0.113.0/24", "2001:db8::/32"). When `allowedIps` is non-empty only
 * matching IPs may authenticate; `blockedIps` always wins.
 */

function ipToBigInt(ip: string): { value: bigint; bits: number } | null {
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let value = 0n;
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      value = (value << 8n) | BigInt(n);
    }
    return { value, bits: 32 };
  }

  if (ip.includes(":")) {
    // Expand :: shorthand and parse 8 hextets.
    const [head, tail] = ip.split("::");
    let hextets: string[];
    if (tail !== undefined) {
      const headParts = head ? head.split(":") : [];
      const tailParts = tail ? tail.split(":") : [];
      const missing = 8 - headParts.length - tailParts.length;
      if (missing < 0) return null;
      hextets = [...headParts, ...Array(missing).fill("0"), ...tailParts];
    } else {
      hextets = ip.split(":");
    }
    if (hextets.length !== 8) return null;
    let value = 0n;
    for (const hex of hextets) {
      const n = parseInt(hex || "0", 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
      value = (value << 16n) | BigInt(n);
    }
    return { value, bits: 128 };
  }

  return null;
}

export function ipMatchesEntry(ip: string, entry: string): boolean {
  const target = ipToBigInt(ip);
  if (!target) return false;

  const [networkIp, prefixStr] = entry.split("/");
  const network = ipToBigInt(networkIp.trim());
  if (!network || network.bits !== target.bits) return false;

  if (prefixStr === undefined) {
    return target.value === network.value;
  }

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > network.bits) return false;
  if (prefix === 0) return true;

  const shift = BigInt(network.bits - prefix);
  return target.value >> shift === network.value >> shift;
}

export interface IpCheckResult {
  allowed: boolean;
  reason?: string;
}

export async function checkIpAllowed(clientId: string | undefined, ip: string | undefined): Promise<IpCheckResult> {
  if (!clientId || !ip) return { allowed: true };

  const [app] = await db
    .select({ allowedIps: applications.allowedIps, blockedIps: applications.blockedIps })
    .from(applications)
    .where(eq(applications.clientId, clientId))
    .limit(1);

  if (!app) return { allowed: true };

  const blocked = app.blockedIps || [];
  if (blocked.some((entry) => ipMatchesEntry(ip, entry))) {
    return { allowed: false, reason: "Your IP address is blocked for this application." };
  }

  const allowed = app.allowedIps || [];
  if (allowed.length > 0 && !allowed.some((entry) => ipMatchesEntry(ip, entry))) {
    return { allowed: false, reason: "Your IP address is not allowed for this application." };
  }

  return { allowed: true };
}
