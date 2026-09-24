import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized === "metadata.google.internal";
}

export function validateSsoEndpoint(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain embedded credentials`);
  if (url.protocol !== "https:" && !(config.NODE_ENV !== "production" && url.protocol === "http:")) {
    throw new Error(`${label} must use HTTPS`);
  }
  if (!config.ALLOW_PRIVATE_SSO_ENDPOINTS && (isPrivateHostname(url.hostname) || (net.isIP(url.hostname) && isPrivateAddress(url.hostname)))) {
    throw new Error(`${label} must not target a private or local address`);
  }
  return url;
}

export async function assertSafeSsoEndpoint(value: string, label: string): Promise<URL> {
  const url = validateSsoEndpoint(value, label);
  if (config.ALLOW_PRIVATE_SSO_ENDPOINTS) return url;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`${label} hostname could not be resolved`);
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`${label} resolved to a private or local address`);
  }
  return url;
}
