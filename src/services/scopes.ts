/**
 * API key scope registry.
 *
 * API key scopes used to be decorative. `requireScopes` existed and was
 * decorated onto the Fastify instance, but no route referenced it, so a key
 * issued with the default `["api:read"]` carried exactly the same authority as
 * the user who created it. Scopes were also free-form: a caller could request
 * any string at key creation, including the literal `"service_account"` that
 * `requireScopes` treated as a wildcard.
 *
 * A registry fixes both halves. A scope that is not defined here cannot be
 * granted, so there is no string an attacker can invent; and a route that needs a
 * scope names it from this list, so enforcement cannot silently drift out of
 * date the way an unreferenced decorator did.
 */

/** Every scope Keystone recognises. Order is the order shown to operators. */
export const API_KEY_SCOPES = {
  /** Read the caller's own profile, sessions, and keys. */
  "profile:read": "Read your own profile and identity",
  "profile:write": "Update your own profile",
  /** Read sessions belonging to the caller. */
  "sessions:read": "List your own sessions",
  "sessions:revoke": "Revoke your own sessions",
  /** Manage the caller's own API keys. */
  "api_keys:read": "List your own API keys",
  "api_keys:revoke": "Revoke your own API keys",
  /** Read organization members and applications. */
  "organizations:read": "Read organization membership and applications",
  /** Manage organization members, applications, and roles. */
  "organizations:write": "Manage organization membership and applications",
  /** Read and manage webhooks. */
  "webhooks:manage": "Create, update, and delete webhooks",
  /** Read and manage workflows. */
  "workflows:read": "Read workflows and their runs",
  "workflows:write": "Create and update workflows",
  /** Second-factor management. Never appropriate for a machine credential. */
  "mfa:manage": "Enroll, verify, and disable TOTP and backup codes",
} as const;

export type ApiKeyScope = keyof typeof API_KEY_SCOPES;

const ALL_SCOPES = Object.keys(API_KEY_SCOPES) as ApiKeyScope[];

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return Object.prototype.hasOwnProperty.call(API_KEY_SCOPES, value);
}

export function knownScopes(): ApiKeyScope[] {
  return [...ALL_SCOPES];
}

/** Human-readable description of a scope, for API responses and dashboards. */
export function describeScope(scope: string): string | undefined {
  return isApiKeyScope(scope) ? API_KEY_SCOPES[scope] : undefined;
}

/**
 * Scopes granted to a service account by default.
 *
 * Deliberately excludes anything interactive: a machine credential has no user
 * present to complete a second factor, no real profile, and no sessions worth
 * listing. A service account that needs more is granted it explicitly.
 */
export const SERVICE_ACCOUNT_DEFAULT_SCOPES: ApiKeyScope[] = ["organizations:read"];

/**
 * Scopes a new personal API key receives when the caller names none.
 *
 * Read-only and confined to the caller's own resources. The previous default,
 * `["api:read"]`, was not in the registry at all — which is a fair indicator that
 * nothing was checking it.
 */
export const PERSONAL_KEY_DEFAULT_SCOPES: ApiKeyScope[] = ["profile:read", "sessions:read", "api_keys:read"];

/**
 * Scopes that may never be granted to a machine credential.
 *
 * `mfa:manage` because a second factor is enrolled by a person holding an
 * authenticator; `MfaRequiredError` is raised when a token is minted for a user
 * with TOTP enabled and no recorded factor, and a service account has no
 * authenticator to record.
 *
 * `profile:*` because a service account's "profile" is a synthesized object with
 * an id of `sa:<uuid>` that matches no user row. Reading it returns nothing real,
 * and writing it would update zero rows -- so the scope is meaningless for a
 * machine and misleading in an audit log that shows what a key was used for.
 */
export const HUMAN_ONLY_SCOPES: readonly ApiKeyScope[] = [
  "mfa:manage",
  "profile:read",
  "profile:write",
];

export interface ScopeValidation {
  ok: boolean;
  /** Unknown scopes, which must be refused rather than stored. */
  unknown: string[];
  /** Scopes refused because a service account may not hold them. */
  forbiddenForServiceAccount: string[];
  /** The accepted set, de-duplicated and in registry order. */
  scopes: ApiKeyScope[];
}

/**
 * Validate a requested scope set.
 *
 * Unknown scopes are refused rather than dropped. Silently discarding a scope a
 * caller asked for hides both a typo and an attempt to smuggle an unrecognised
 * privilege past a review, and it leaves the caller believing they hold
 * something they do not.
 */
export function validateScopes(
  requested: string[] | undefined,
  options: { principal: "user" | "service_account"; fallback?: ApiKeyScope[] } = { principal: "user" }
): ScopeValidation {
  const wanted =
    requested && requested.length > 0
      ? requested
      : (options.fallback ??
        (options.principal === "service_account" ? SERVICE_ACCOUNT_DEFAULT_SCOPES : PERSONAL_KEY_DEFAULT_SCOPES));

  const unknown = wanted.filter((scope) => !isApiKeyScope(scope));

  const known = wanted.filter(isApiKeyScope);
  const forbidden =
    options.principal === "service_account"
      ? known.filter((scope) => HUMAN_ONLY_SCOPES.includes(scope))
      : [];

  const allowed = known.filter((scope) => !forbidden.includes(scope));

  return {
    ok: unknown.length === 0 && forbidden.length === 0,
    unknown,
    forbiddenForServiceAccount: forbidden,
    // Registry order, so two equivalent requests produce identical rows.
    scopes: ALL_SCOPES.filter((scope) => allowed.includes(scope)),
  };
}

/**
 * Narrow a key's stored scopes to what the caller is actually entitled to.
 *
 * A key never gains authority from its own record. The effective set is what the
 * key holds *intersected with* what its principal could do directly, so revoking
 * a role or removing a membership takes effect on the key too rather than
 * leaving a stale grant behind.
 */
export function intersectScopes(granted: string[] | null | undefined, principalAllows: string[]): ApiKeyScope[] {
  const held = new Set((granted ?? []).filter(isApiKeyScope));
  const allowed = new Set(principalAllows.filter(isApiKeyScope));
  return ALL_SCOPES.filter((scope) => held.has(scope) && allowed.has(scope));
}

/**
 * Grant check used by `requireScopes`.
 *
 * Explicit allow-list membership only. The previous implementation also accepted
 * a key whose scopes merely *contained* the string `"service_account"`, which is
 * a bypass by construction: that string was client-suppliable at key creation, so
 * any key created with `scopes: ["service_account"]` satisfied every check.
 */
export function hasScopes(granted: string[] | null | undefined, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  const held = new Set(granted ?? []);
  return required.every((scope) => held.has(scope));
}
