import dns from "node:dns/promises";
import net from "node:net";
import { customFetch, type FetchImplementation } from "jose";
import { config } from "../config.js";

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const value = mapped ?? normalized;
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(value)) {
    return (
      value === "::1" ||
      value === "::" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe80:")
    );
  }
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "ip6-localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "metadata.google.internal"
  );
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

export async function fetchSsoEndpoint(
  value: string,
  label: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = await assertSafeSsoEndpoint(value, label);
  return fetch(url, { ...init, redirect: "error" });
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

export const safeJwksFetch: FetchImplementation = async (url, options) => {
  const safeUrl = await assertSafeSsoEndpoint(url, "jwksUri");
  return fetch(safeUrl, { ...options, redirect: "manual" });
};

export { customFetch };
