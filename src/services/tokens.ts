import crypto from "node:crypto";
import {
  SignJWT,
  importPKCS8,
  importSPKI,
  jwtVerify,
  decodeProtectedHeader,
  exportJWK,
} from "jose";
import { eq, and, gt, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  refreshTokens,
  userSessions,
  users,
  applications,
  orgMemberships,
  type User,
  type Application,
} from "../db/schema.js";
import { config } from "../config.js";
import type { Span } from "@opentelemetry/api";
import { ATTR, SPAN, recordSpan, withSpan } from "./spans.js";
import { recordTokenOperation } from "../plugins/operationalMetrics.js";
import { emit } from "./events/bus.js";
import type { TokenClaims } from "../types.js";
import {
  getActiveSigningKey,
  listValidSigningKeys,
  type SigningKeyPair,
} from "./secrets.js";
import { resolve } from "../container.js";

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
  return config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
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
  /**
   * The credential family the refresh token belongs to. A login omits it and
   * gets a fresh family; a rotation passes the family of the token it replaces,
   * so the whole chain stays one credential that can be revoked as a unit.
   */
  familyId?: string;
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
    (span) =>
      mintTokenSet(user, ip, userAgent, opts, deviceFingerprint, span).then((tokens) => {
        // Counted here, at the same door as the span, so a metric and a trace of
        // "a token was issued" cannot disagree. An issuance that throws is not
        // counted: the counter answers "how many tokens exist", and a token that
        // was never minted is not one.
        recordTokenOperation("issue", "success");
        return tokens;
      })
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
    // A login starts a family; a rotation names the family it continues. The
    // family id is generated here rather than derived from the user, so two
    // devices logging in as the same person are two families and revoking one
    // does not sign the other out.
    familyId: opts.familyId ?? crypto.randomUUID(),
  }).returning();

  try {
    // Resolved through the container rather than constructed here so every
    // session row comes from the same repository instance the routes read.
    const sessions = resolve("sessionRepository");
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

  /**
   * **Strict `kid` resolution** — SEC-076.
   *
   * This used to be:
   *
   * ```ts
   * const publicKey = keyPair?.publicKey ?? activeKey?.publicKey;
   * ```
   *
   * so an unknown `kid` silently fell back to the active key. Two things wrong
   * with that, and the first is the one that matters:
   *
   * 1. **It is not a bypass.** A token signed by *any* other key still fails
   *    signature verification, so an attacker gains nothing by naming a `kid`
   *    this server does not know. The plan describes this as validation to add;
   *    it was never a live exploit and the entry says so.
   * 2. **It is a diagnostic lie.** A token from a retired key, a token from a
   *    different issuer, or a forged token with an invented `kid` all produce
   *    the *same* signature error as an expired or tampered token from a key
   *    this server does hold. An operator rotating keys cannot tell "this token
   *    predates the rotation and its key is gone" from "this token was forged",
   *    because the two are indistinguishable in the output. Rejecting an unknown
   *    `kid` *before* the signature check is what makes those two different
   *    errors.
   *
   * **Rotation is not broken by this.** `listValidSigningKeys()` returns the
   * active key plus every key still inside its grace period, and `validKeys` is
   * populated from exactly that set. A token signed by a key rotated out an hour
   * ago still resolves, because its key is still in the map. Only a key that has
   * genuinely left the grace period is refused — which is the point of a grace
   * period, and which the old fallback silently defeated by verifying such a
   * token against the *wrong* key and reporting a signature failure.
   */
  if (header.kid) {
    const keyPair = validKeys.get(header.kid);
    if (!keyPair) {
      // A named key this server does not hold. Distinct from a signature failure
      // and it must stay distinct: the message is the operator's only clue about
      // whether a rotation went wrong.
      throw new Error(`unknown key id: ${header.kid}`);
    }
    return verifyWithKey(token, keyPair.publicKey);
  }

  // **No `kid` at all** — the explicit legacy policy, unchanged.
  //
  // Tokens issued before `kid` was added carry no key id, and they are verified
  // against the active key. That is a deliberate, documented compatibility
  // allowance rather than the same accident as an unknown `kid`: the difference
  // is that a token with *no* `kid` makes no claim about which key signed it,
  // while one with an unrecognised `kid` makes a claim this server cannot
  // honour, and honouring it by guessing is how the old line went wrong.
  if (!activeKey) {
    throw new Error("JWT signing keys not loaded");
  }
  return verifyWithKey(token, activeKey.publicKey);
}

/**
 * Verify against one specific key.
 *
 * The parameter type is `CryptoKey` because that is what `jose`'s
 * `importSPKI`/`generateKeyPair` return and what `SigningKeyPair.publicKey`
 * holds. Narrowing it to `crypto.KeyObject` compiles only because
 * `jwtVerify` accepts both, and then fails on the call site — which is why the
 * first version of this helper annotated it as `KeyObject` and did not build.
 */
async function verifyWithKey(token: string, publicKey: CryptoKey): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: issuer(),
    audience: "hilbras",
  });
  return payload as unknown as TokenClaims;
}

/**
 * What a refresh exchange settled as.
 *
 * The old contract was `TokenSet | null`, and `null` meant three different
 * things: an unknown token, an expired token, and a replayed one. Only the
 * third is an incident, and only the third has a consequence — the credential
 * family is revoked. A caller that cannot tell them apart either logs a
 * breach where there was a race, or fails to revoke a family where there was a
 * breach. So the outcome is named.
 */
export type RefreshExchange =
  | { outcome: "rotated"; tokens: TokenSet }
  /** The token was not usable: unknown, expired, or administratively revoked. */
  | { outcome: "rejected" }
  /** The token had already been spent, and long enough ago to be a breach. */
  | { outcome: "replayed"; userId: string; familyId: string }
  /** The token had just been spent — the same client asking twice. */
  | { outcome: "raced"; userId: string; familyId: string };

export async function exchangeRefreshToken(
  token: string,
  ip?: string,
  userAgent?: string,
  clientId?: string,
  expectedAppId?: string
): Promise<RefreshExchange> {
  // Counted at the wrapper rather than at each return, for the same reason as
  // before: this function returns `null` for three different situations — unknown
  // token, expired, and replayed — and the outcome label is richer here than at any
  // single return.
  //
  // §5.2. The label used to be the constant `"attempted"`, which carried no
  // information: a counter whose label never varies is a counter of call volume
  // wearing a different name, and it could not answer the one question a rotation
  // metric exists for — whether rotations are succeeding. It now reports the
  // settled outcome. A thrown error is counted separately from a `null` return
  // because they are different events: `refused` is the credential being rejected,
  // `error` is the rotation failing for a reason that is not the credential's
  // fault, such as the database being unreachable.
  try {
    const result = await rotateRefreshTokenInternal(token, ip, userAgent, clientId, expectedAppId);
    recordTokenOperation("rotate", result.outcome === "rotated" ? "success" : "refused");
    return result;
  } catch (err) {
    recordTokenOperation("rotate", "error");
    throw err;
  }
}

/**
 * Rotate a refresh token, or refuse it.
 *
 * The `TokenSet | null` shape is kept for the callers that only need to know
 * whether the exchange worked. `exchangeRefreshToken` is the one that says
 * *why* it did not.
 */
export async function rotateRefreshToken(
  token: string,
  ip?: string,
  userAgent?: string,
  clientId?: string,
  expectedAppId?: string
): Promise<TokenSet | null> {
  const result = await exchangeRefreshToken(token, ip, userAgent, clientId, expectedAppId);
  return result.outcome === "rotated" ? result.tokens : null;
}

async function rotateRefreshTokenInternal(
  token: string,
  ip?: string,
  userAgent?: string,
  clientId?: string,
  expectedAppId?: string
): Promise<RefreshExchange> {
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
    // The token is not live. That is three different situations, and only one
    // of them is an incident:
    //
    // - unknown, expired, or administratively revoked: a client that lost a
    //   token. Ordinary, and it must not touch anything else.
    // - spent just now: the same client asking twice. Refused, and the
    //   family survives.
    // - spent long ago: somebody came back with a token that was stolen.
    //   The family is revoked.
    //
    // The first question is which of the three it is, and only the row can
    // answer that.
    const detection = await detectRefreshTokenReplay(token, now);
    if (detection.replayed && detection.userId && detection.familyId) {
      if (detection.raced) {
        recordSpan(SPAN.tokenRotation, {
          [ATTR.flow]: "refresh",
          [ATTR.rotated]: false,
          [ATTR.outcome]: "raced",
        });
        return { outcome: "raced", userId: detection.userId, familyId: detection.familyId };
      }

      // A breach. Every token descended from this login goes, because the one
      // the attacker holds is the one the victim's client no longer has.
      const revoked = await revokeRefreshTokenFamily(detection.familyId, now);
      recordTokenOperation("replay", "detected");
      await emit({
        type: "refresh_token_replayed",
        payload: {
          userId: detection.userId,
          // The same fields the route's audit row carried, so an operator
          // reading the audit log sees one shape whether the event came from
          // here or from the request that noticed it.
          metadata: {
            replayed: true,
            familyId: detection.familyId,
            revokedTokens: revoked,
          },
        },
      });
      recordSpan(SPAN.tokenRotation, {
        [ATTR.flow]: "refresh",
        [ATTR.rotated]: false,
        [ATTR.outcome]: "replayed",
      });
      return { outcome: "replayed", userId: detection.userId, familyId: detection.familyId };
    }

    // Not a rotation. This records the refusal so a spike is visible.
    // The span represents the *decision*, not the query — the query is already
    // covered by the postgres auto-instrumentation.
    recordSpan(SPAN.tokenRotation, {
      [ATTR.flow]: "refresh",
      [ATTR.rotated]: false,
      [ATTR.outcome]: "not-rotated",
    });
    return { outcome: "rejected" };
  }

  const [user] = await db.select().from(users).where(eq(users.id, existing.userId)).limit(1);
  if (!user?.isActive || user.accountReviewRequired) return { outcome: "rejected" };

  // A session may only keep rotating while it still represents an MFA-verified
  // login. Sessions created before MFA was enabled, or without a recorded
  // factor, are refused rather than silently upgraded.
  if (user.totpEnabled && !existing.mfaFactor) return { outcome: "rejected" };

  let appId: string | undefined;
  let orgId: string | undefined;
  if (existing.appId) {
    if (expectedAppId && expectedAppId !== existing.appId) return { outcome: "rejected" };
    const [application] = await db
      .select({ id: applications.id, orgId: applications.orgId, clientId: applications.clientId })
      .from(applications)
      .where(and(eq(applications.id, existing.appId), eq(applications.isActive, true)))
      .limit(1);
    if (!application || !clientId || application.clientId !== clientId) return { outcome: "rejected" };

    const [membership] = await db
      .select({ id: orgMemberships.id })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, application.orgId), eq(orgMemberships.userId, user.id)))
      .limit(1);
    if (!membership) return { outcome: "rejected" };
    appId = application.id;
    orgId = application.orgId;
  } else if (clientId || expectedAppId) {
    return { outcome: "rejected" };
  }

  // Claim only after all client, application, membership, and account checks
  // pass. The conditional update makes concurrent rotations single-use.
  const [claimed] = await db
    .update(refreshTokens)
    .set({ revokedAt: now, consumedAt: now })
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
    // Another request claimed this token between the read above and the write
    // here. That is a race the caller lost, not a breach: the token was live
    // when this request looked at it, so the two requests are the same client
    // asking twice, and the family is left alone. A request that arrives
    // *after* the other one finished finds no live token at all, and is
    // classified by the replay detection above.
    recordSpan(SPAN.tokenRotation, {
      [ATTR.flow]: "refresh",
      [ATTR.rotated]: false,
      [ATTR.outcome]: "claim-lost",
    });
    return { outcome: "raced", userId: existing.userId, familyId: existing.familyId };
  }

  recordSpan(SPAN.tokenRotation, {
    [ATTR.flow]: "refresh",
    [ATTR.rotated]: true,
    [ATTR.outcome]: "rotated",
    [ATTR.clientId]: clientId ?? "none",
  });

  const tokens = await createTokenSet(
    user,
    ip,
    userAgent,
    {
      appId,
      orgId,
      clientId,
      deviceFingerprint: claimed.deviceFingerprint ?? undefined,
      // The family is carried forward, so the new token and the one it replaces
      // are one credential. This is what makes "revoke everything descended
      // from this login" a single statement instead of a guess.
      familyId: claimed.familyId,
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

  return { outcome: "rotated", tokens };
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

/**
 * Inspect a refresh token without consuming it.
 *
 * Rotation makes a presented token unusable, so by the time an exchange fails
 * the only way to tell a replay from a revoked-but-never-used token is to look
 * the row up. The distinction matters: re-presentation of a *consumed* token
 * means two parties hold it (the leak itself) and the account's remaining
 * sessions should be revoked, while an administratively revoked token (logout,
 * revoke-all, deactivation) tells us nothing — a stale tab retrying after
 * "log out everywhere else" must not be able to kill the session the user just
 * kept alive.
 *
 * These live here, with the minting and the rotation, because all three have
 * to agree on how a token is hashed. They were briefly a separate module with
 * its own copy of the hash, and a copy is a drift risk: if the two ever
 * disagreed, every lookup would silently find nothing, and the symptom — every
 * refresh failing, and no replay ever being detected — reads like a
 * configuration mistake rather than the divergence it is.
 */

type State = "live" | "consumed" | "revoked" | "expired" | "unknown";

interface TokenState {
  state: State;
  userId: string;
  familyId: string;
  /** When the token was spent by rotation; null unless it was. */
  consumedAt: Date | null;
}

async function stateOf(token: string): Promise<TokenState | undefined> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return undefined;
  const state: State =
    row.consumedAt !== null
      ? "consumed"
      : row.revokedAt !== null
        ? "revoked"
        : row.expiresAt.getTime() <= Date.now()
          ? "expired"
          : "live";
  return { state, userId: row.userId, familyId: row.familyId, consumedAt: row.consumedAt };
}

/** True only when the token exists and has already been spent by rotation. */
export async function findRefreshTokenState(token: string): Promise<boolean> {
  const found = await stateOf(token);
  return found?.state === "consumed";
}

/** The user a refresh token belongs to, or null if it is not known. */
export async function refreshTokenOwner(token: string): Promise<string | null> {
  const found = await stateOf(token);
  return found?.userId ?? null;
}

/**
 * What a failed exchange turned out to be.
 *
 * `replayed` is the only one of these that is an incident: the token was
 * presented twice, which means two parties hold it. Everything else — unknown,
 * expired, administratively revoked — is a client that lost a token, which is
 * an ordinary event and must not sign anyone out.
 */
export interface ReplayDetection {
  replayed: boolean;
  /** True when the token was spent so recently that this is a race, not a breach. */
  raced?: boolean;
  userId?: string;
  familyId?: string;
}

/**
 * How long after a rotation a re-presentation is still treated as a benign race.
 *
 * A client that sends two refreshes at once — two tabs, a retry after a slow
 * response, a mobile client waking twice — is the common case, and the server
 * cannot tell it apart from an attacker replaying a stolen token: both present
 * a token that has already been spent. RFC 9700 says to revoke the grant on
 * reuse, and that is right for a token that was stolen an hour ago and
 * presented again now. It is wrong for a token presented two hundred
 * milliseconds after it was spent, because there the second presentation is
 * the same client, and revoking the family would sign the client out of the
 * session it legitimately just renewed.
 *
 * So the two are separated by time, which is the only signal available. A
 * re-presentation inside this window is a race and is refused without
 * touching the family; one outside it is a breach, and the family goes.
 *
 * The window is deliberately short. The race it covers is measured in
 * milliseconds; thirty seconds is two orders of magnitude of headroom, and it
 * still means a stolen token presented half a minute after the attacker's
 * own rotation is caught.
 */
export const REPLAY_GRACE_MS = 30_000;

/**
 * Decide whether a presented refresh token was replayed.
 *
 * The lookup is by hash alone, with no expiry or revocation filter: a replayed
 * token is by definition not live, so filtering it out of the query would
 * filter out exactly the thing being looked for. The `consumedAt` marker is
 * what distinguishes a replay from a logout.
 */
export async function detectRefreshTokenReplay(
  token: string,
  now: Date = new Date()
): Promise<ReplayDetection> {
  const found = await stateOf(token);
  if (!found || found.state !== "consumed") return { replayed: false };
  // A token spent inside the grace window was almost certainly spent by the
  // same client that is now presenting it a second time. `raced` says so, and
  // the caller refuses the exchange without revoking the family.
  const raced = found.consumedAt !== null && now.getTime() - found.consumedAt.getTime() < REPLAY_GRACE_MS;
  return { replayed: true, raced, userId: found.userId, familyId: found.familyId };
}

/**
 * Revoke every token descended from one login.
 *
 * This is the response to a replay, and it is deliberately wider than the
 * token that was replayed. A stolen token was valid at the moment it was
 * stolen; the attacker may have rotated it, and the token that rotated it is
 * in the attacker's hands, not the victim's. Revoking only the presented token
 * would leave the attacker's replacement alive. The family is the set of
 * tokens that all descend from the login the attacker compromised, so
 * revoking the family is the smallest set that certainly includes the
 * attacker's current token.
 *
 * The presented token is included in the family, so it is revoked here too.
 *
 * The sessions that hang off those tokens end with them, in the same
 * transaction. A session row that outlives its refresh token is a session that
 * claims to be live and cannot be refreshed — which is the state a user sees
 * as "signed in on my phone" that no longer means anything. Revoking the
 * tokens and ending the sessions together is what keeps the two consistent.
 */
export async function revokeRefreshTokenFamily(
  familyId: string,
  at: Date = new Date()
): Promise<number> {
  return db.transaction(async (tx) => {
    // The whole family, not only the tokens this call newly revoked. The token
    // that was replayed was already revoked when it was consumed, so it is not
    // in the set of newly-revoked rows — but its session is exactly the one
    // that must end. Selecting the family first and revoking the sessions
    // against it covers both.
    const family = await tx
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId));

    if (family.length === 0) return 0;

    const revoked = await tx
      .update(refreshTokens)
      .set({ revokedAt: at })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });

    await tx
      .update(userSessions)
      .set({ revokedAt: at })
      .where(
        and(
          inArray(
            userSessions.refreshTokenId,
            family.map((row) => row.id)
          ),
          isNull(userSessions.revokedAt)
        )
      );

    return revoked.length;
  });
}
