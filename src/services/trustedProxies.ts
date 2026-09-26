import { config } from "../config.js";
import type { FastifyRequest } from "fastify";

/**
 * Trusted-proxy model.
 *
 * ```text
 * Internet  →  trusted reverse proxy  →  Keystone
 * ```
 *
 * Two rules follow from that diagram, and everything else in this module exists
 * to enforce them:
 *
 *  1. Only a request whose **peer** address is a configured trusted proxy may
 *     have its forwarded headers believed. `request.ip` cannot be used for this
 *     decision, because Fastify derives it from `x-forwarded-for` when
 *     `trustProxy` is on — which is exactly the attacker-controlled value.
 *  2. The peer address is the only value that cannot be spoofed. Forwarded
 *     headers are only consulted when (1) holds.
 *
 * With no trusted proxies configured, nothing is trusted: the peer address is
 * used for rate limiting and client-certificate headers are ignored entirely.
 * The default is therefore fail-closed.
 */

/** Headers that carry client identity and must never be believed from an untrusted peer. */
export const IDENTITY_HEADERS = [
  "x-forwarded-client-cert",
  "x-client-cert-fingerprint",
  "x-service-account-id",
  "x-forwarded-client-cert-chain",
] as const;

/** Headers that influence the apparent client address. */
const FORWARDED_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded"] as const;

/**
 * Normalize an address so every spelling of the same host compares equal.
 *
 * IPv4-mapped IPv6 arrives in two forms — the dotted form `::ffff:127.0.0.1`
 * and the hex form `::ffff:7f00:1`. Both must collapse to `127.0.0.1`,
 * otherwise a mapped address slips past an IPv4 CIDR allowlist.
 */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return "";
  let value = address.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  // Strip a zone index and any port suffix on bare IPv6.
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);

  if (value.startsWith("::ffff:")) {
    const tail = value.slice(7);
    if (tail.includes(".")) return tail;
    // Hex form: the final two hextets are the IPv4 address.
    const hextets = tail.split(":");
    if (hextets.length === 2 && hextets.every((h) => /^[0-9a-f]{1,4}$/.test(h))) {
      const high = parseInt(hextets[0], 16);
      const low = parseInt(hextets[1], 16);
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
      }
    }
    return tail;
  }

  return value;
}

function toIPv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Does `address` fall inside `cidr`? Supports IPv4 CIDR and exact IPv6. */
export function addressInCidr(address: string, cidr: string): boolean {
  const target = normalizeAddress(address);
  const range = cidr.trim().toLowerCase();
  if (!target || !range) return false;

  if (!range.includes("/")) return target === normalizeAddress(range);

  const [network, bitsRaw] = range.split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits)) return false;

  const targetOctets = toIPv4Octets(normalizeAddress(network));
  const boundOctets = toIPv4Octets(normalizeAddress(network));
  if (!targetOctets || !boundOctets) {
    // IPv6: compare the leading `bits` of the hextets. Anything not an exact
    // or prefix match is treated as outside the range.
    if (bits < 0 || bits > 128) return false;
    const left = normalizeAddress(network).split(":");
    const right = normalizeAddress(target).split(":");
    if (left.length !== right.length) return false;
    const hextets = bits / 16;
    for (let i = 0; i < Math.floor(hextets); i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  if (bits < 0 || bits > 32) return false;
  const targetV4 = toIPv4Octets(normalizeAddress(target));
  if (!targetV4) return false;

  let remaining = bits;
  for (let i = 0; i < 4; i++) {
    if (remaining <= 0) break;
    const take = Math.min(8, remaining);
    const mask = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
    if ((targetV4[i] & mask) !== (boundOctets[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

let cachedConfig: { raw: string; entries: string[] } | null = null;

/**
 * Read the setting at call time rather than from the `config` snapshot, which
 * is built once at import. Cached on the raw string, so this is cheap while
 * still picking up a reload.
 */
function trustedEntries(): string[] {
  const raw = (process.env.KEYSTONE_TRUSTED_PROXIES ?? config.TRUSTED_PROXIES ?? "").trim();
  if (cachedConfig?.raw === raw) return cachedConfig.entries;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  cachedConfig = { raw, entries };
  return entries;
}

/** Reset the parse cache. Exists for tests that change configuration. */
export function resetTrustedProxyCache(): void {
  cachedConfig = null;
}

/**
 * Is at least one trusted proxy configured? False means client-identity headers
 * are stripped from every request and rate limits key on the peer address.
 */
export function hasTrustedProxies(): boolean {
  return trustedEntries().length > 0;
}

export function isTrustedProxy(address: string | undefined): boolean {
  const entries = trustedEntries();
  if (entries.length === 0) return false;
  const target = normalizeAddress(address);
  if (!target) return false;
  return entries.some((entry) => addressInCidr(target, entry));
}

/**
 * The socket's peer address. This is the only value a client cannot forge,
 * because it is established by the TCP connection rather than by a header.
 */
export function peerAddress(request: FastifyRequest): string {
  return normalizeAddress(request.socket?.remoteAddress ?? request.ip);
}

/** True when the immediate peer is a configured trusted proxy. */
export function isFromTrustedProxy(request: FastifyRequest): boolean {
  return isTrustedProxy(peerAddress(request));
}

/**
 * The client address to use for rate limiting and logging.
 *
 * Behind a trusted proxy this is the left-most forwarded address, because the
 * proxy is the one that appended it. From any other peer the forwarded headers
 * are ignored, so a client cannot rotate `x-forwarded-for` to obtain a fresh
 * rate-limit budget.
 */
export function clientAddress(request: FastifyRequest): string {
  if (!isFromTrustedProxy(request)) return peerAddress(request);

  const xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const first = xff.split(",")[0]?.trim();
    if (first) return normalizeAddress(first);
  }
  const realIp = request.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return normalizeAddress(realIp);
  return peerAddress(request);
}

/**
 * Remove identity and forwarded headers from a request that did not arrive via
 * a trusted proxy. Stripping rather than merely ignoring means no downstream
 * route, plugin, or future feature can accidentally read them.
 *
 * @returns whether the request was trusted (and therefore kept its headers)
 */
export function stripUntrustedHeaders(request: FastifyRequest): boolean {
  if (isFromTrustedProxy(request)) return true;
  for (const header of [...IDENTITY_HEADERS, ...FORWARDED_HEADERS]) {
    delete request.headers[header];
  }
  return false;
}

/** The value Fastify's `trustProxy` option should be given. */
export function fastifyTrustProxySetting(): boolean | string[] {
  const entries = trustedEntries();
  return entries.length > 0 ? entries : false;
}

/**
 * Does this address look like infrastructure rather than a public client?
 *
 * Loopback, RFC 1918, link-local, and unique-local ranges are where reverse
 * proxies, load balancers, and service meshes live. A request arriving from one
 * of these while no trusted proxy is configured is the signature of a proxied
 * deployment that forgot `KEYSTONE_TRUSTED_PROXIES` — which fails silently, as
 * every client collapsing into a single rate-limit budget.
 */
export function isInfrastructureAddress(address: string): boolean {
  const target = normalizeAddress(address);
  if (!target) return false;
  if (target === "127.0.0.1" || target === "::1" || target === "0.0.0.0" || target === "::") {
    return true;
  }
  if (target.startsWith("10.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(target)) return true;
  if (target.startsWith("192.168.")) return true;
  if (target.startsWith("169.254.")) return true;
  // IPv6: fe80::/10 link-local, fc00::/7 unique-local. Compare the first
  // hextet regardless of how many there are, so a fully expanded address
  // (`fe80:0000:...:0001`) is classified the same as the compressed form.
  const first = parseInt(target.split(":")[0] ?? "", 16);
  if (Number.isInteger(first)) {
    if ((first & 0xffc0) === 0xfe80) return true;
    if ((first & 0xfe00) === 0xfc00) return true;
  }
  return false;
}

/**
 * Why no forwarded headers were believed, or `null` when the peer was trusted.
 *
 * Returned so the caller can log a warning only in the case that indicates a
 * misconfiguration, rather than on every stripped request.
 */
export function describeUntrustedPeer(address: string): string | null {
  if (hasTrustedProxies()) return null;
  if (!isInfrastructureAddress(address)) return null;
  return (
    "client-identity headers were stripped from an infrastructure address while " +
    "KEYSTONE_TRUSTED_PROXIES is unset. If Keystone is behind a reverse proxy, " +
    "set it to the proxy's address: until then every client shares one rate-limit " +
    "budget and forwarded client addresses are ignored. See docs/security/proxy-security.md"
  );
}

const FINGERPRINT_HEX = /^[0-9a-f]{64}$/i;
const FINGERPRINT_COLON = /^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i;

/** A SHA-256 fingerprint, in hex or the colon-separated form AWS ALB emits. */
export function isValidFingerprint(value: string | undefined): value is string {
  if (!value) return false;
  const normalized = value.trim();
  return FINGERPRINT_HEX.test(normalized) || FINGERPRINT_COLON.test(normalized);
}

/** Canonical fingerprint form used for storage and comparison. */
export function canonicalFingerprint(value: string): string {
  return value.trim().replace(/:/g, "").toLowerCase();
}
