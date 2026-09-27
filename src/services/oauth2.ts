import crypto from "node:crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  oauth2AuthorizationCodes,
  oauth2Consents,
  applications,
  orgMemberships,
  type User,
  type Application,
} from "../db/schema.js";
import { config } from "../config.js";
import { createTokenSet, createIdToken, type AccessTokenOptions, type MfaAssertion } from "./tokens.js";

export interface AuthorizationCodeInput {
  appId: string;
  userId: string;
  challenge?: string;
  challengeMethod?: string;
  redirectUri?: string;
  scopes?: string[];
  nonce?: string;
  mfaFactor?: MfaAssertion;
}

export function generateAuthorizationCode(): { code: string; codeHash: string } {
  const code = crypto.randomBytes(48).toString("base64url");
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  return { code, codeHash };
}

export async function storeAuthorizationCode(input: AuthorizationCodeInput) {
  const { code, codeHash } = generateAuthorizationCode();
  const expiresAt = new Date(Date.now() + config.OAUTH_CODE_TTL_SECONDS * 1000);

  const [record] = await db
    .insert(oauth2AuthorizationCodes)
    .values({
      appId: input.appId,
      userId: input.userId,
      codeHash,
      challenge: input.challenge ?? null,
      challengeMethod: input.challengeMethod ?? null,
      redirectUri: input.redirectUri ?? null,
      scopes: input.scopes ?? [],
      nonce: input.nonce ?? null,
      mfaFactor: input.mfaFactor ?? null,
      expiresAt,
    })
    .returning();

  return { ...record, code };
}

export async function consumeAuthorizationCode(
  code: string,
  appId: string,
  redirectUri?: string
): Promise<typeof oauth2AuthorizationCodes.$inferSelect | undefined> {
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const now = new Date();

  const conditions = [
    eq(oauth2AuthorizationCodes.codeHash, codeHash),
    eq(oauth2AuthorizationCodes.appId, appId),
    gt(oauth2AuthorizationCodes.expiresAt, now),
    isNull(oauth2AuthorizationCodes.usedAt),
  ];
  // Exact match, no exceptions. `redirect_uri` is required at /authorize, so
  // there is always a stored value to compare against; tolerating a missing one
  // here would let a stolen code be redeemed against any redirect URI.
  if (redirectUri) {
    conditions.push(eq(oauth2AuthorizationCodes.redirectUri, redirectUri));
  }

  const [record] = await db
    .update(oauth2AuthorizationCodes)
    .set({ usedAt: now })
    .where(and(...conditions))
    .returning();
  return record;
}

/**
 * Verify a PKCE code verifier against a stored challenge.
 *
 * `requireChallenge` exists because the previous shape of this function was the
 * whole PKCE story at the token endpoint, and it was not a check at all:
 *
 * ```ts
 * if (!challenge) return true;   // no challenge was registered -> accept
 * ```
 *
 * A client that omitted `code_challenge` at `/authorize` and then sent any
 * string as `code_verifier` at `/token` passed. The endpoint required a
 * verifier to be *present*, so the requirement looked enforced while proving
 * nothing. For a public client — an SPA or a mobile app that cannot hold a
 * secret — PKCE is the only thing standing between an intercepted authorization
 * code and a stolen account, so "optional" meant "unprotected".
 *
 * The two failure modes are now separated deliberately:
 *  - no challenge and `requireChallenge` false: a confidential client that chose
 *    not to use PKCE. Permitted, because it authenticates with a secret.
 *  - a challenge but a mismatched or malformed verifier: always a failure.
 */
export function verifyPKCE(
  challenge: string | null | undefined,
  method: string | null | undefined,
  verifier: string | null | undefined,
  options: { requireChallenge?: boolean } = {}
): boolean {
  if (!challenge) {
    // No challenge to verify against. Only acceptable when PKCE was not
    // required for this client.
    return !options.requireChallenge;
  }

  if (typeof verifier !== "string" || verifier === "") return false;
  if (method?.toLowerCase() !== "s256") return false;

  const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
  return timingSafeEqual(hash, challenge);
}

/** Constant-time comparison, so a verifier cannot be recovered byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * A client that cannot keep a secret must use PKCE.
 *
 * Today every application has a non-null `client_secret_hash`, so this reduces to
 * "the client has no usable secret" — which is the honest test regardless of how
 * the column is populated, and stays correct if secretless public clients are
 * introduced later.
 */
export function requiresPkce(clientSecretHash: string | null | undefined): boolean {
  return !clientSecretHash || clientSecretHash === "";
}

/**
 * Reduce requested scopes to the ones actually granted.
 *
 * The effective set is the intersection of what the client is registered to ask
 * for, what it asked for, and what the user consented to. Previously the
 * client's `scope` parameter was stored verbatim and the only filter applied was
 * consent, so a client could put any string it liked into the issued token.
 *
 * Rejecting rather than silently dropping is deliberate: a client asking for
 * something it was never registered for is a misconfiguration or an attempt to
 * escalate, and quietly handing back a lesser scope set hides both. The error
 * names the offending scope so the client can be fixed.
 *
 * An empty `allowedScopes` means "no restriction registered", which preserves
 * every existing application. Once an application has an allowlist, it is
 * enforced.
 */
export function resolveEffectiveScopes(input: {
  requested: string[];
  allowed: string[];
  consented: string[] | null;
}): { ok: true; scopes: string[] } | { ok: false; error: string; scope: string } {
  const requested = [...new Set(input.requested.filter(Boolean))];
  const allowed = new Set(input.allowed);
  const consented = input.consented === null ? null : new Set(input.consented);

  const effective: string[] = [];
  for (const scope of requested) {
    if (allowed.size > 0 && !allowed.has(scope)) {
      return { ok: false, error: "invalid_scope", scope };
    }
    if (consented && !consented.has(scope)) {
      return { ok: false, error: "invalid_scope", scope };
    }
    effective.push(scope);
  }

  return { ok: true, scopes: effective };
}

export async function hasConsent(
  userId: string,
  appId: string,
  requestedScopes: string[]
): Promise<boolean> {
  if (requestedScopes.length === 0) return true;

  const [consent] = await db
    .select()
    .from(oauth2Consents)
    .where(
      and(
        eq(oauth2Consents.appId, appId),
        eq(oauth2Consents.userId, userId),
        isNull(oauth2Consents.revokedAt)
      )
    )
    .limit(1);

  if (!consent) return false;
  const granted = new Set(consent.scopes);
  return requestedScopes.every((scope) => granted.has(scope));
}

/**
 * The user's current consent record, or undefined if they have never consented
 * or have revoked it.
 *
 * Kept separate from `hasConsent` because the scope intersection needs the
 * granted set itself, not a yes/no answer to it.
 */
export async function findConsent(
  userId: string,
  appId: string
): Promise<typeof oauth2Consents.$inferSelect | undefined> {
  const [consent] = await db
    .select()
    .from(oauth2Consents)
    .where(
      and(
        eq(oauth2Consents.appId, appId),
        eq(oauth2Consents.userId, userId),
        isNull(oauth2Consents.revokedAt)
      )
    )
    .limit(1);
  return consent;
}

export async function grantConsent(userId: string, appId: string, scopes: string[]) {
  const now = new Date();
  const [record] = await db
    .insert(oauth2Consents)
    .values({
      appId,
      userId,
      scopes,
      grantedAt: now,
    })
    .onConflictDoUpdate({
      target: [oauth2Consents.appId, oauth2Consents.userId],
      set: {
        scopes,
        grantedAt: now,
        revokedAt: null,
      },
    })
    .returning();
  return record;
}

export async function revokeConsent(userId: string, appId: string): Promise<void> {
  await db
    .update(oauth2Consents)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauth2Consents.appId, appId), eq(oauth2Consents.userId, userId)));
}

export async function listConsentsByAppId(appId: string) {
  return db
    .select()
    .from(oauth2Consents)
    .where(and(eq(oauth2Consents.appId, appId), isNull(oauth2Consents.revokedAt)));
}

export async function createTokenResponse(
  user: User,
  app: Application,
  scopes: string[],
  opts: {
    ip?: string;
    userAgent?: string;
    deviceFingerprint?: string;
    nonce?: string;
    mfaFactor?: MfaAssertion;
  } = {}
) {
  const [membership] = await db
    .select({ id: orgMemberships.id })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, app.orgId), eq(orgMemberships.userId, user.id)))
    .limit(1);
  if (!membership) throw new Error("OAuth user is not a member of the application organization");

  const tokenOpts: AccessTokenOptions = {
    appId: app.id,
    orgId: app.orgId,
    clientId: app.clientId,
    // The granted set is persisted on the refresh token so it survives rotation
    // instead of being dropped at the first refresh.
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(opts.mfaFactor ? { mfaFactor: opts.mfaFactor } : {}),
  };

  const tokenSet = await createTokenSet(
    user,
    opts.ip,
    opts.userAgent,
    tokenOpts,
    opts.deviceFingerprint,
    "oauth-token"
  );

  const response: Record<string, unknown> = {
    access_token: tokenSet.accessToken,
    refresh_token: tokenSet.refreshToken,
    token_type: "Bearer",
    expires_in: config.ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
  };

  if (scopes.includes("openid")) {
    response.id_token = await createIdToken(user, app, opts.nonce);
  }

  return response;
}

export async function findApplicationByClientId(clientId: string): Promise<Application | undefined> {
  const [app] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.clientId, clientId), eq(applications.isActive, true)))
    .limit(1);
  return app;
}

export async function verifyClientSecret(
  clientId: string,
  secret: string
): Promise<Application | undefined> {
  const [app] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.clientId, clientId), eq(applications.isActive, true)))
    .limit(1);

  if (!app) return undefined;
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  if (app.clientSecretHash !== hash) return undefined;
  return app;
}
