import { config } from "../config.js";
import { isPrivateAddress, assertSafeSsoEndpoint } from "./ssoEndpointPolicy.js";

/**
 * SSRF policy for **administrator-supplied** outbound URLs.
 *
 * ## Why this file exists
 *
 * `ssoEndpointPolicy.ts` already does the hard part properly: it classifies
 * private and reserved addresses, resolves DNS and checks *every* answer, pins
 * the connection to the address it validated so a rebind cannot change the
 * destination between check and connect, and refuses redirects. It is applied to
 * SSO and OIDC endpoints.
 *
 * It was not applied to webhooks, which is the worse of the two cases:
 *
 * - an SSO endpoint is configured by a platform owner;
 * - **a webhook URL is configured by any organization admin**, so a lower-trust
 *   role can point the server at an arbitrary address;
 * - and the delivery is performed on a queue worker, from inside the network,
 *   with the application's own identity and egress.
 *
 * A webhook aimed at `169.254.169.254` is a cloud-metadata read. Aimed at
 * `127.0.0.1:6379` or `postgres.internal`, it is a lateral reach into
 * infrastructure that no tenant-controlled URL should be able to touch. The
 * response body is persisted on the delivery row and is readable through the
 * admin API, so a *successful* request hands the content back to the org admin.
 *
 * ## Why this delegates instead of reimplementing
 *
 * The obvious alternative is a `webhookPolicy.ts` carrying its own private-IP
 * table. That is how two implementations drift apart, and the drift is silent: a
 * range added to one is not covered by the other, and a check that covers less
 * than it appears to is precisely the failure this module exists to prevent.
 *
 * So the classification and the resolution are the SSO module's, reused. The
 * policy that differs — the flag, the error text, and the plan's §1.2 HTTPS
 * rule — lives here. `ssoEndpointPolicy` is the module that owns private-address
 * classification for outbound requests; this is a second caller of it.
 */

/**
 * Thrown when an outbound URL fails the policy in this module.
 *
 * A named type rather than a bare `Error`, because the two callers need
 * different statuses for the same rejection: the admin API must answer **400**,
 * since the operator supplied a URL Keystone will not use, while a delivery
 * worker must answer **nothing at all** — the request is never made and the
 * delivery is recorded as failed and retried.
 *
 * Matching on `err.message.includes("private")` at either call site would work
 * right up until someone reworded a message, and would then return the wrong
 * status while looking correct.
 */
export class OutboundUrlRejected extends Error {
  constructor(
    message: string,
    /** The URL as supplied, for the audit trail. Never log the secret. */
    readonly url: string
  ) {
    super(message);
    this.name = "OutboundUrlRejected";
  }
}

function reject(message: string, url: URL): never {
  throw new OutboundUrlRejected(message, url.toString());
}

/**
 * Validate a webhook URL that is about to be **stored**.
 *
 * Synchronous, and deliberately so: it cannot resolve DNS, because a name that
 * resolves to a public address now need not at delivery time. It rejects the
 * shapes that are wrong regardless of when the name resolves — a private
 * literal, a loopback literal, embedded credentials, plain HTTP in production.
 *
 * A URL that passes here can still be refused at delivery time, and should be.
 * See `assertSafeWebhookUrl`.
 */
export function validateWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundUrlRejected("webhook URL must be a valid URL", value);
  }
  if (url.username || url.password) {
    // `https://user:pass@host/` puts a credential in the URL, and a URL is logged
    // by proxies, by the delivery row, and by anyone reading a failed request.
    reject("webhook URL must not contain embedded credentials", url);
  }
  if (url.protocol !== "https:" && !(config.NODE_ENV !== "production" && url.protocol === "http:")) {
    // Plan §1.2. A signing secret in a plain-HTTP body is a credential in every
    // proxy log between here and the consumer.
    reject(
      config.NODE_ENV === "production"
        ? "webhook URL must use HTTPS in production"
        : "webhook URL must use HTTPS or http to a loopback address",
      url
    );
  }
  if (!config.ALLOW_PRIVATE_WEBHOOK_TARGETS) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isLoopbackOrPrivateHostname(host) || isLiteralPrivateAddress(host)) {
      reject("webhook URL must not target a private or local address", url);
    }
  }
  return url;
}

/**
 * Validate a webhook URL at the moment it is about to be **fetched**.
 *
 * Asynchronous, because it resolves DNS and inspects every answer — the only way
 * to catch a name that points somewhere private. Throws rather than returning a
 * flag: a caller that forgets to check a returned boolean gets a loud failure
 * instead of a silent request.
 */
export async function assertSafeWebhookUrl(value: string): Promise<URL> {
  const url = validateWebhookUrl(value);
  if (config.ALLOW_PRIVATE_WEBHOOK_TARGETS) return url;
  try {
    // Performs the DNS resolution and the per-answer private-address check, and
    // throws on a private answer, an unresolvable name, or a name whose answers
    // disagree about being public.
    return await assertSafeSsoEndpoint(url.toString(), "webhook URL");
  } catch (err) {
    // Re-typed, so the delivery worker's `catch` can tell "the operator gave us
    // a URL we refuse" from "the network failed". The first is a permanent
    // rejection and must not be retried; the second is worth retrying. Both
    // arrive here as a plain Error, and collapsing them would mean retrying a
    // URL that can never work.
    throw new OutboundUrlRejected(
      err instanceof Error ? err.message : "webhook URL could not be verified",
      url.toString()
    );
  }
}

function isLiteralPrivateAddress(host: string): boolean {
  // Only literals can be judged without DNS; anything else is `assertSafeWebhookUrl`'s
  // job. Rejecting only literals keeps the synchronous check honest about what it
  // can actually know, rather than pretending to resolve a name.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateAddress(host);
  if (host.includes(":")) return isPrivateAddress(host); // IPv6 literal, possibly bracketed
  return false;
}

function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "ip6-localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata"
  );
}
