/**
 * Redirect URI validation.
 *
 * Redirect URIs are the one place an authorization server sends a user's browser
 * somewhere on its own authority. Anything accepted here becomes a `Location`
 * header the identity provider itself emits, so the accepted set has to be a
 * set a browser cannot be talked out of.
 *
 * Two distinct jobs, kept separate on purpose:
 *
 *  - {@link validateRedirectUri} decides whether a URI may be **registered**.
 *  - {@link isRedirectUriRegistered} decides whether a URI may be **used**.
 *
 * Matching is exact string comparison. That is the strictest form available and
 * the one RFC 9700 requires: no prefix matching, no normalization, no wildcards.
 * Normalizing before comparing is what turns a strict check into a loose one,
 * because the two sides then stop being compared as the bytes that will
 * actually be sent.
 */

export interface RedirectUriRejection {
  ok: false;
  reason: string;
}

export type RedirectUriCheck = { ok: true } | RedirectUriRejection;

/** Schemes that would execute script or inline a document if navigated to. */
const SCRIPT_SCHEMES = new Set(["javascript", "data", "vbscript", "blob", "file"]);

/**
 * Hostnames that may legitimately be reached over plaintext HTTP, because they
 * never leave the developer's machine.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** `scheme:` per RFC 3986, which custom app schemes (`myapp://`) must match. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Whether a redirect URI may be registered.
 *
 * Rejects, in order of how badly they fail:
 *  - `javascript:`, `data:`, and friends — script execution on our own origin
 *  - wildcards — accepted by the URL parser but can never match exactly, so they
 *    mislead the operator into thinking a redirect is configured when it is not
 *  - fragments — never transmitted to the server, so an exact comparison against
 *    them can never succeed
 *  - embedded credentials — `https://user:pass@host` is a phishing primitive
 *  - plaintext HTTP to anything that is not loopback
 */
export function validateRedirectUri(uri: string): RedirectUriCheck {
  if (typeof uri !== "string" || uri.trim() === "") {
    return { ok: false, reason: "must be a non-empty string" };
  }

  const value = uri.trim();

  // A wildcard is a valid URL character sequence to the parser, so it has to be
  // rejected explicitly rather than caught by scheme or host rules.
  if (value.includes("*")) {
    return { ok: false, reason: "must not contain a wildcard; register each redirect URI exactly" };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "must be a valid absolute URL" };
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();

  if (SCRIPT_SCHEMES.has(scheme)) {
    return {
      ok: false,
      reason: `scheme "${scheme}" would execute script or inline a document and is never a valid redirect target`,
    };
  }

  if (url.hash) {
    return { ok: false, reason: "must not contain a fragment; fragments are not sent to the server" };
  }

  if (url.username || url.password) {
    return { ok: false, reason: "must not embed credentials" };
  }

  if (scheme === "https") {
    return { ok: true };
  }

  if (scheme === "http") {
    const host = url.hostname.toLowerCase();
    if (LOOPBACK_HOSTS.has(host)) return { ok: true };
    return {
      ok: false,
      reason: "must use https; plaintext http is accepted only for loopback addresses during development",
    };
  }

  // A custom scheme is how native and mobile clients receive the redirect, so it
  // is allowed — provided it is not one of the script-bearing schemes handled
  // above. It must be a reverse-DNS style identifier, not a bare word.
  if (SCHEME.test(value) && url.protocol !== ":") {
    if (!/^[a-z][a-z0-9+.-]*:$/i.test(url.protocol)) {
      return { ok: false, reason: "scheme is malformed" };
    }
    return { ok: true };
  }

  return { ok: false, reason: `scheme "${scheme}" is not supported` };
}

/**
 * Validate a whole registration set, returning every problem rather than the
 * first, so an operator fixing a configuration sees all of it at once.
 */
export function validateRedirectUris(uris: string[]): RedirectUriRejection[] {
  const problems: RedirectUriRejection[] = [];

  for (const uri of uris) {
    const result = validateRedirectUri(uri);
    if (!result.ok) problems.push({ ok: false, reason: `${uri}: ${result.reason}` });
  }

  const seen = new Set<string>();
  for (const uri of uris) {
    if (seen.has(uri)) {
      problems.push({ ok: false, reason: `${uri}: registered more than once` });
    }
    seen.add(uri);
  }

  return problems;
}

/**
 * Whether a requested redirect URI is registered.
 *
 * Exact string comparison, deliberately. The requested value is compared as the
 * exact bytes that will be sent in the `Location` header, with no parsing,
 * case-folding, trailing-slash adjustment, or default-port removal. Any of those
 * would widen the check: `https://example.com` and `https://example.com/` are
 * different origins paths-wise, and a comparison that treats them as equal is a
 * comparison that can be made to match something it should not.
 */
export function isRedirectUriRegistered(registered: string[], requested: string | undefined): boolean {
  if (typeof requested !== "string" || requested === "") return false;
  return registered.includes(requested);
}
