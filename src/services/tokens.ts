import crypto from "node:crypto";
import {
  SignJWT,
  importPKCS8,
  importSPKI,
  jwtVerify,
  decodeProtectedHeader,
  exportJWK,
} from "jose";
import { eq, and, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  refreshTokens,
  users,
  applications,
  orgMemberships,
  type User,
  type Application,
} from "../db/schema.js";
import { config } from "../config.js";
import type { Span } from "@opentelemetry/api";
import { ATTR, SPAN, recordSpan, withSpan } from "./spans.js";
import type { TokenClaims } from "../types.js";
import {
  getActiveSigningKey,
  listValidSigningKeys,
  type SigningKeyPair,
} from "./secrets.js";
import { SessionRepository } from "../repositories/session.js";

/** Active signing key used to issue new tokens. */
let activeKey: SigningKeyPair | null = null;
/** All valid signing keys (active + grace-period keys) used for verification. */
const validKeys = new Map<string, SigningKeyPair>();

export async function loadSigningKeys(): Promise<void> {
  if (config.JWT_PRIVATE_KEY && config.JWT_PUBLIC_KEY) {
    const privateKey = await importPKCS8(config.JWT_PRIVATE_KEY, "RS256");
    const publicKey = await importSPKI(config.JWT_PUBLIC_KEY, "RS256");
    activeKey = { keyId: "env", privateKey, publicKey };
    validKeys.set(activeKey.keyId, activeKey);
    return;
  }

  activeKey = await getActiveSigningKey();
  const keys = await listValidSigningKeys();
  validKeys.clear();
  for (const key of keys) {
    validKeys.set(key.keyId, key);
  }
}

/**
 * Return the public JWK for the active signing key. Kept for backwards
 * compatibility; new code should prefer `getPublicJwks()`.
 */
export async function getPublicJWK() {
  if (!activeKey) await loadSigningKeys();
  return exportJWK(activeKey!.publicKey);
}

/**
 * Return the JWKS document containing every valid public key, including
 * recently rotated keys still within the grace period.
 */
export async function getPublicJwks() {
  if (validKeys.size === 0) await loadSigningKeys();
  const keys = await Promise.all(
    Array.from(validKeys.values()).map(async (key) => {
      const jwk = await exportJWK(key.publicKey);
      return { ...jwk, kid: key.keyId, use: "sig", key_ops: ["verify"] };
    })
  );
  return { keys };
}

function issuer(): string {
  return process.env.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
}

/**
 * Authentication methods that can satisfy the MFA requirement for a user who
 * has TOTP enabled. `session` is only valid when rotating a refresh token that
 * was itself created after a successful second factor.
 */
export type MfaAssertion = "totp" | "backup_code" | "webauthn" | "session";

/**
 * Raised when a token is requested for a user with MFA enabled but the caller
 * could not prove a second factor was verified. Thrown from the single
 * issuance chokepoint so no login path can bypass MFA by omission.
 */
export class MfaRequiredError extends Error {
  readonly code = "MFA_REQUIRED" as const;
  readonly userId: string;

  constructor(userId: string) {
    super("Multi-factor authentication is required before a token can be issued");
    this.name = "MfaRequiredError";
    this.userId = userId;
  }
}

export interface AccessTokenOptions {
  appId?: string;
  orgId?: string;
  clientId?: string;
  deviceFingerprint?: string;
  /** Proof that the MFA requirement for this user was satisfied. */
  mfaFactor?: MfaAssertion;
  /** Scopes granted at the authorization step, carried on the refresh token. */
  scopes?: string[];
}

export function createAccessToken(user: User, opts: AccessTokenOptions = {}): Promise<string> {
  if (!user.isActive) throw new Error("Cannot issue a token for a deactivated account");
  if (user.totpEnabled && !opts.mfaFactor) throw new MfaRequiredError(user.id);
  if (!activeKey) throw new Error("JWT signing keys not loaded");
  const claims: TokenClaims = {
    sub: user.id,
    email: user.email,
    username: user.username,
    name: user.name ?? undefined,
    plan: user.plan,
    role: user.role === "owner" ? "owner" : "user",
    provider: user.provider,
  };
  if (opts.orgId) claims.org_id = opts.orgId;
  if (opts.appId) claims.app_id = opts.appId;
  if (opts.clientId) claims.client_id = opts.clientId;
  if (opts.deviceFingerprint) claims.device_fingerprint = opts.deviceFingerprint;
  if (opts.mfaFactor) {
    claims.amr = [user.provider, opts.mfaFactor];
    claims.mfa_factor = opts.mfaFactor;
    claims.mfa_verified = true;
  }
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: activeKey.keyId })
    .setIssuedAt()
    .setIssuer(issuer())
    .setAudience("hilbras")
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(activeKey.privateKey);
}

export interface ApplicationAccessTokenOptions {
  appId: string;
  orgId: string;
  clientId: string;
  scopes?: string[];
}

export function createApplicationAccessToken(
  opts: ApplicationAccessTokenOptions
): Promise<string> {
  if (!activeKey) throw new Error("JWT signing keys not loaded");
  const claims: Record<string, unknown> = {
    sub: opts.clientId,
    client_id: opts.clientId,
    app_id: opts.appId,
    org_id: opts.orgId,
  };
  if (opts.scopes && opts.scopes.length > 0) {
    claims.scope = opts.scopes.join(" ");
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: activeKey.keyId })
    .setIssuedAt()
    .setIssuer(issuer())
    .setAudience("hilbras")
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(activeKey.privateKey);
}

export async function createIdToken(
  user: User,
  app: Application,
  nonce?: string
): Promise<string> {
  if (!activeKey) throw new Error("JWT signing keys not loaded");
  const claims: Record<string, unknown> = {
    sub: user.id,
    email: user.email,
    email_verified: user.emailVerified,
    username: user.username,
    name: user.name,
    picture: user.avatarUrl,
    aud: app.clientId,
    azp: app.clientId,
  };
  if (nonce) claims.nonce = nonce;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: activeKey.keyId })
    .setIssuedAt()
    .setIssuer(issuer())
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(activeKey.privateKey);
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  refreshTokenHash: string;
  expiresAt: Date;
  userId: string;
}

/**
 * Which door a token came through.
 *
 * A union rather than a string so a misspelled flow is a compile error at the
 * call site instead of a span attribute that quietly says "unknown" forever. The
 * parameter stays optional because `createTokenSet` is exported and an SDK
 * consumer calling it should not be forced to learn a new argument to keep
 * working; the eleven internal call sites all name their flow.
 */
export type TokenFlow =
  | "password"
  | "mfa"
  | "magic-link"
  | "webauthn"
  | "refresh"
  | "oauth-authorize"
  | "oauth-token"
  | "federation"
  | "saml"
  | "oidc"
  | "registration";

export async function createTokenSet(
  user: User,
  ip?: string,
  userAgent?: string,
  opts: AccessTokenOptions = {},
  deviceFingerprint?: string,
  flow?: TokenFlow
): Promise<TokenSet> {
  // Every token in the system is minted here: password login, refresh, OAuth
  // token exchange, federation, SAML and OIDC callbacks. That is the point —
  // MFA enforcement works because there is one door, and this span is placed at
  // the same door so a slow or failing issuance is visible wherever it started.
  return withSpan(
    SPAN.tokenIssuance,
    {
      [ATTR.flow]: flow ?? "unknown",
      // Two separate facts, because they answer different questions. `mfaEnabled`
      // is a property of the account; `mfaSatisfied` is a property of this login.
      // Collapsing them into one "requiresMfa" flag produces a value that is true
      // for a TOTP user who just authenticated with a password and already
      // satisfied their second factor — which is to say, true always, for anyone
      // who has TOTP on. A flag that is always true is a flag that reports nothing.
      [ATTR.mfaEnabled]: user.totpEnabled,
      [ATTR.mfaSatisfied]: Boolean(opts.mfaFactor),
      [ATTR.mfaFactor]: (opts.mfaFactor as string | undefined) ?? "none",
      [ATTR.clientId]: opts.clientId ?? "none",
    },
    (span) => mintTokenSet(user, ip, userAgent, opts, deviceFingerprint, span)
  );
}

async function mintTokenSet(
  user: User,
  ip: string | undefined,
  userAgent: string | undefined,
  opts: AccessTokenOptions,
  deviceFingerprint: string | undefined,
  span: Span
): Promise<TokenSet> {
  const accessToken = await createAccessToken(user, opts);
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_SECONDS * 1000);

  const [inserted] = await db.insert(refreshTokens).values({
    userId: user.id,
    appId: opts.appId ?? null,
    tokenHash: refreshTokenHash,
    expiresAt,
    ipAddress: ip ?? null,
    userAgent: userAgent ?? null,
    deviceFingerprint: deviceFingerprint ?? null,
    mfaFactor: opts.mfaFactor ?? null,
    scopes: opts.scopes ?? [],
  }).returning();

  try {
    const sessions = new SessionRepository();
    await sessions.create({
      userId: user.id,
      refreshTokenId: inserted.id,
      deviceFingerprint,
      ipAddress: ip,
      userAgent,
      expiresAt,
    });
  } catch {
    // Session tracking is best-effort; token creation must not fail because of it.
  }

  span.setAttribute(ATTR.outcome, "issued");
  return { accessToken, refreshToken, refreshTokenHash, expiresAt, userId: user.id };
}

export async function verifyAccessToken(token: string): Promise<TokenClaims> {
  if (!activeKey) await loadSigningKeys();

  const header = decodeProtectedHeader(token);
  const keyPair = header.kid ? validKeys.get(header.kid) : undefined;
  const publicKey = keyPair?.publicKey ?? activeKey?.publicKey;

  if (!publicKey) {
    throw new Error("JWT signing keys not loaded");
  }

  const { payload } = await jwtVerify(token, publicKey, {
    issuer: issuer(),
    audience: "hilbras",
  });
  return payload as unknown as TokenClaims;
}

export async function rotateRefreshToken(
  token: string,
  ip?: string,
  userAgent?: string,
  clientId?: string,
  expectedAppId?: string
): Promise<TokenSet | null> {
  const hash = hashToken(token);
  const now = new Date();

  const [existing] = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, hash),
        gt(refreshTokens.expiresAt, now),
        isNull(refreshTokens.revokedAt)
      )
    )
    .limit(1);
  if (!existing) {
    // Not a rotation. Whether it was a replay is decided by the caller, which
    // does the state lookup; this records the refusal so a spike is visible.
    // The span represents the *decision*, not the query — the query is already
    // covered by the postgres auto-instrumentation.
    recordSpan(SPAN.tokenRotation, {
      [ATTR.flow]: "refresh",
      [ATTR.rotated]: false,
      [ATTR.outcome]: "not-rotated",
    });
    return null;
  }

  const [user] = await db.select().from(users).where(eq(users.id, existing.userId)).limit(1);
  if (!user?.isActive || user.accountReviewRequired) return null;

  // A session may only keep rotating while it still represents an MFA-verified
  // login. Sessions created before MFA was enabled, or without a recorded
  // factor, are refused rather than silently upgraded.
  if (user.totpEnabled && !existing.mfaFactor) return null;

  let appId: string | undefined;
  let orgId: string | undefined;
  if (existing.appId) {
    if (expectedAppId && expectedAppId !== existing.appId) return null;
    const [application] = await db
      .select({ id: applications.id, orgId: applications.orgId, clientId: applications.clientId })
      .from(applications)
      .where(and(eq(applications.id, existing.appId), eq(applications.isActive, true)))
      .limit(1);
    if (!application || !clientId || application.clientId !== clientId) return null;

    const [membership] = await db
      .select({ id: orgMemberships.id })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, application.orgId), eq(orgMemberships.userId, user.id)))
      .limit(1);
    if (!membership) return null;
    appId = application.id;
    orgId = application.orgId;
  } else if (clientId || expectedAppId) {
    return null;
  }

  // Claim only after all client, application, membership, and account checks
  // pass. The conditional update makes concurrent rotations single-use.
  const [claimed] = await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(refreshTokens.id, existing.id),
        eq(refreshTokens.tokenHash, hash),
        gt(refreshTokens.expiresAt, now),
        isNull(refreshTokens.revokedAt)
      )
    )
    .returning();
  if (!claimed) {
    recordSpan(SPAN.tokenRotation, {
      [ATTR.flow]: "refresh",
      [ATTR.rotated]: false,
      [ATTR.outcome]: "claim-lost",
    });
    return null;
  }

  recordSpan(SPAN.tokenRotation, {
    [ATTR.flow]: "refresh",
    [ATTR.rotated]: true,
    [ATTR.outcome]: "rotated",
    [ATTR.clientId]: clientId ?? "none",
  });

  return createTokenSet(
    user,
    ip,
    userAgent,
    {
      appId,
      orgId,
      clientId,
      deviceFingerprint: claimed.deviceFingerprint ?? undefined,
      // Carried forward from the token being rotated. A refresh may narrow the
      // grant but never widen it, so the stored set is authoritative rather than
      // anything the caller supplies.
      ...(claimed.scopes?.length ? { scopes: claimed.scopes } : {}),
      ...(claimed.mfaFactor
        ? { mfaFactor: claimed.mfaFactor as MfaAssertion }
        : {}),
    },
    claimed.deviceFingerprint ?? undefined,
    "refresh"
  );
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const hash = hashToken(token);
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, hash));
}

export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, userId));
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Re-exported from secrets service for backwards compatibility.
export { hashApiKey, generateApiKey } from "./secrets.js";
