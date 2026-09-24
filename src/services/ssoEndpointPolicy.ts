import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { customFetch, type FetchImplementation } from "jose";
import ipaddr from "ipaddr.js";
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
    const parsed = ipaddr.parse(value);
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) {
      return isPrivateAddress(ipv6.toIPv4Address().toString());
    }
    return ["unspecified", "loopback", "linkLocal", "uniqueLocal", "ipv4Mapped", "rfc6145", "6to4", "teredo"].includes(
      parsed.range() as string
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

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: number }> {
  if (net.isIP(hostname)) return { address: hostname, family: net.isIP(hostname) };
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("SSO endpoint hostname could not be resolved");
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("SSO endpoint resolved to a private or local address");
  }
  const publicAddress = addresses[0];
  if (!publicAddress) throw new Error("SSO endpoint resolved only to private or local addresses");
  return publicAddress;
}

async function requestPinned(
  url: URL,
  init: RequestInit,
  address: { address: string; family: number }
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" || init.body instanceof Uint8Array ? init.body : undefined;
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const bodyBuffer = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
            else if (value !== undefined) responseHeaders.set(key, value);
          }
          resolve(new Response(bodyBuffer, { status: response.statusCode ?? 502, statusText: response.statusMessage, headers: responseHeaders }));
        });
      }
    );
    request.setTimeout(10_000, () => request.destroy(new Error("SSO endpoint request timed out")));
    init.signal?.addEventListener("abort", () => request.destroy(new Error("SSO endpoint request aborted")), { once: true });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export async function assertSafeSsoEndpoint(value: string, label: string): Promise<URL> {
  const url = validateSsoEndpoint(value, label);
  if (config.ALLOW_PRIVATE_SSO_ENDPOINTS) return url;
  await resolvePublicAddress(url.hostname);
  return url;
}

export async function fetchSsoEndpoint(
  value: string,
  label: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = validateSsoEndpoint(value, label);
  if (config.ALLOW_PRIVATE_SSO_ENDPOINTS) {
    return fetch(url, { ...init, redirect: "error" });
  }
  const address = await resolvePublicAddress(url.hostname);
  return requestPinned(url, { ...init, redirect: "error" }, address);
}

export const safeJwksFetch: FetchImplementation = async (url, options) => {
  const safeUrl = validateSsoEndpoint(url, "jwksUri");
  if (config.ALLOW_PRIVATE_SSO_ENDPOINTS) {
    return fetch(safeUrl, { ...options, redirect: "manual" });
  }
  const address = await resolvePublicAddress(safeUrl.hostname);
  return requestPinned(safeUrl, options, address);
};

export { customFetch };
