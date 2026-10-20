import crypto from "node:crypto";
import { config, isZitadelConfigured } from "../../config.js";
import { resolve } from "../../container.js";
import type { User } from "../../db/schema.js";
import { consumePasswordResetTokenRow } from "../singleUse.js";
import { revokeAllUserCredentials } from "../sessionRevocation.js";
import { createHumanUser, verifyPassword as verifyZitadelPassword } from "../zitadel.js";
import { createTokenSet, exchangeRefreshToken, revokeRefreshToken, type MfaAssertion, type TokenSet } from "../tokens.js";
import { isPasswordBreached } from "../hibp.js";
import { ipMatchesEntry } from "../ipControls.js";
import { isFailedLoginAnomaly } from "../anomalyDetection.js";
import { recordAuthentication } from "../../plugins/operationalMetrics.js";
import { emit } from "../events/bus.js";
import type { UserRepository, ApplicationRepository, OrganizationRepository, MfaFlow, PasswordResetTokenRepository } from "../../repositories/types.js";
import type { IssuedMfaChallenge, MfaFactor, MfaService } from "../mfa.js";
import { ok, err, type Result } from "../../lib/result.js";
import { hashPassword, verifyPassword } from "../secrets/index.js";
import { serviceLogger } from "../../lib/logger.js";

const moduleLog = serviceLogger("auth");

export interface AuthContext {
  app?: { id: string; clientId: string; orgId?: string };
  org?: { id: string };
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  name?: string;
  clientId?: string;
  metadata?: Record<string, unknown>;
}

export interface LoginInput {
  email: string;
  password: string;
  clientId?: string;
  /** Which login surface started the flow; recorded on the challenge. */
  flow?: MfaFlow;
  ipAddress?: string;
  userAgent?: string;
}

export interface TokenResponse {
  user: User;
  tokens: TokenSet;
  context: AuthContext;
}

/**
 * Result of the password step. Tokens are only ever present once the user is
 * fully authenticated; an MFA-enabled user is returned in `requires_mfa` with
 * an opaque challenge and no tokens.
 */
export type LoginResult =
  | { status: "authenticated"; user: User; tokens: TokenSet; context: AuthContext }
  | { status: "requires_mfa"; user: User; challenge: IssuedMfaChallenge; context: AuthContext };

export interface MfaCompletion {
  user: User;
  tokens: TokenSet;
  context: AuthContext;
  flow: MfaFlow;
  factor: MfaFactor;
  /** Client the challenge was created for; the session cookie is scoped to it. */
  clientId?: string;
}

export class AuthenticationDomainService {
  constructor(
    private readonly users: UserRepository,
    private readonly applications: ApplicationRepository,
    private readonly organizations: OrganizationRepository,
    private readonly mfa: MfaService,
    // Optional only because routes/setup.ts (off-limits to this change) still
    // constructs the service with four arguments; call sites fall back to the
    // container instance.
    private readonly passwordResetTokens?: PasswordResetTokenRepository
  ) {}

  private async loadAppContext(userId: string, clientId?: string): Promise<AuthContext> {
    if (!clientId) return {};
    const app = await this.applications.findByClientId(clientId);
    if (!app) return {};

    const membership = await this.organizations.findMembership(app.orgId, userId);
    return {
      app: { id: app.id, clientId: app.clientId, ...(membership ? { orgId: app.orgId } : {}) },
      ...(membership ? { org: { id: app.orgId } } : {}),
    };
  }

  async register(input: RegisterInput): Promise<Result<TokenResponse>> {
    if (config.HIBP_CHECK_ENABLED) {
      const breached = await isPasswordBreached(input.password);
      if (breached) {
        return err({ code: "BREACHED_PASSWORD", message: "This password has appeared in a data breach.", statusCode: 400 });
      }
    }

    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      return err({ code: "EMAIL_EXISTS", message: "An account with this email already exists.", statusCode: 409 });
    }

    const passwordHash = await hashPassword(input.password);
    const username = await this.users.ensureUniqueUsername(
      input.username.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)
    );

    let zitadelUserId: string | undefined;
    if (isZitadelConfigured()) {
      try {
        zitadelUserId = await createHumanUser({
          username: input.username,
          email: input.email,
          name: input.name || input.username,
          password: input.password,
        });
      } catch (err) {
        moduleLog.warn({ err }, "auth");
      }
    }

    const user = await this.users.create({
      email: input.email,
      username,
      name: input.name || input.username,
      passwordHash,
      provider: "password",
      emailVerified: !config.EMAIL_VERIFICATION_REQUIRED,
      zitadelUserId,
      metadata: input.metadata,
    });

    if (config.EMAIL_VERIFICATION_REQUIRED) {
      try {
        const { sendVerificationEmail } = await import("../emailVerification.js");
        sendVerificationEmail(user).catch((err: unknown) => {
          moduleLog.error({ err }, "auth");
        });
      } catch {
        // emailVerification module may not be available in all configurations
      }
    }

    const context = await this.loadAppContext(user.id, input.clientId);
    const tokens = await createTokenSet(user, undefined, undefined, {
      appId: context.org ? context.app?.id : undefined,
      orgId: context.org?.id,
      clientId: context.org ? context.app?.clientId : undefined,
    }, undefined, "registration");

    await emit({
      type: "user_registered",
      payload: {
        provider: "password",
        zitadelUserId,
        userId: user.id,
        username: user.username,
        email: user.email,
        client_id: input.clientId,
        appId: context.org ? context.app?.id : undefined,
        orgId: context.org?.id,
      },
    });

    return ok({ user, tokens, context });
  }

  /**
   * Authenticate, and count the outcome once.
   *
   * The counting lives here rather than at each `return` because `login` has ten
   * of them, and instrumenting ten call sites is ten chances to add a new one and
   * forget it — which would make a metric quietly wrong in exactly the direction
   * that matters, since a failure nobody counts is a failure nobody sees.
   *
   * `outcome` and `reason` are separate labels because the question an operator
   * asks is not "are logins failing" but "why". A sudden `invalid_credentials` is a
   * spray; a sudden `mfa_failed` is a user with a broken second factor; a sudden
   * `rate_limited` is a client with a bug. One label for all three reads as "logins
   * are failing" and none of them is actionable.
   */
  async login(input: LoginInput): Promise<Result<LoginResult>> {
    const result = await this.loginInternal(input);
    if (result.success) {
      recordAuthentication(
        "success",
        result.data.status === "requires_mfa" ? "mfa_required" : "none"
      );
    } else {
      // `TOO_MANY_ATTEMPTS` is a limiter decision rather than a credential
      // problem, and the two want different responses, so it gets its own label
      // rather than being folded into the failure it is not.
      const rateLimited = result.error.code === "TOO_MANY_ATTEMPTS";
      recordAuthentication(
        rateLimited ? "rate_limited" : "failure",
        rateLimited ? "too_many_attempts" : result.error.code.toLowerCase()
      );
    }
    return result;
  }

  /**
   * Burn the same argon2 work a real login does when the account does not
   * exist. Without this, an unknown address returns in ~0ms and a known one
   * costs a 24ms+ verify — a reliable existence oracle no rate limit short of
   * brute screening removes. The computed hash is of random bytes: its answer
   * is never used, only the time taken to get there.
   */
  private dummyHashPromise: Promise<string> | undefined;

  private async equalizeUnknownUserTiming(candidate: string): Promise<void> {
    this.dummyHashPromise ??= hashPassword(crypto.randomBytes(16).toString("hex"));
    try {
      await verifyPassword(candidate, await this.dummyHashPromise);
    } catch {
      // The result is irrelevant; presence of the work is the entire point.
    }
  }

  private async loginInternal(input: LoginInput): Promise<Result<LoginResult>> {
    const user = await this.users.findByEmail(input.email);

    if (!user) {
      if (isZitadelConfigured()) {
        await verifyZitadelPassword(input.email, input.password).catch(() => {});
      }
      await this.equalizeUnknownUserTiming(input.password);
      // The emit is the record. `anomalySubscriber` counts every
      // `user_login_failed` it sees, so an explicit `recordFailedLogin` here as
      // well would count one failure twice — which is what pushed the spray
      // threshold from 10 to 5 (SEC-053).
      await emit({
        type: "user_login_failed",
        payload: { reason: "unknown_user", email: input.email, ip: input.ipAddress },
      });
      if (await isFailedLoginAnomaly(input.email)) {
        return err({ code: "TOO_MANY_ATTEMPTS", message: "Too many failed attempts. Please try again later.", statusCode: 429 });
      }
      return err({ code: "INVALID_CREDENTIALS", message: "Invalid email or password.", statusCode: 401 });
    }

    if (!user.isActive) {
      await emit({ type: "user_login_failed", payload: { reason: "account_deactivated", userId: user.id, email: input.email, ip: input.ipAddress } });
      return err({ code: "ACCOUNT_DEACTIVATED", message: "This account is deactivated", statusCode: 403 });
    }

    if (user.accountReviewRequired) {
      await emit({ type: "user_login_failed", payload: { reason: "account_review_required", userId: user.id, email: input.email, ip: input.ipAddress } });
      return err({ code: "ACCOUNT_REVIEW_REQUIRED", message: "This account is pending review.", statusCode: 403 });
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await emit({ type: "user_login_failed", payload: { reason: "account_locked", userId: user.id, email: input.email, ip: input.ipAddress } });
      return err({ code: "ACCOUNT_LOCKED", message: "Account is temporarily locked due to too many failed attempts. Try again later.", statusCode: 403 });
    }

    // The per-application IP lists were enforced only when the caller
    // volunteered `client_id` in the body, so omitting it — or supplying an
    // invented one — walked straight past them. Every application the account's
    // memberships reach that carries a list now speaks for this login regardless
    // of what the body claims; the route still consults the submitted client_id
    // first for real applications. Runs before the password check so a refusal
    // proves nothing about which secret was submitted, matching how the
    // up-front client_id check already behaves.
    if (input.ipAddress) {
      const orgs = await this.organizations.listByUserId(user.id);
      for (const org of orgs) {
        for (const app of await this.applications.listByOrgId(org.id)) {
          const blocked = app.blockedIps ?? [];
          if (blocked.some((entry) => ipMatchesEntry(input.ipAddress!, entry))) {
            return err({ code: "IP_NOT_ALLOWED", message: "Your IP address is blocked for this application.", statusCode: 403 });
          }
          const allowed = app.allowedIps ?? [];
          if (allowed.length > 0 && !allowed.some((entry) => ipMatchesEntry(input.ipAddress!, entry))) {
            return err({ code: "IP_NOT_ALLOWED", message: "Your IP address is not allowed for this application.", statusCode: 403 });
          }
        }
      }
    }

    let valid = false;
    if (user.passwordHash) {
      valid = await verifyPassword(input.password, user.passwordHash);
    } else if (user.provider === "zitadel" && isZitadelConfigured()) {
      valid = await verifyZitadelPassword(input.email, input.password);
    }

    if (!valid) {
      const updated = await this.users.recordFailedLogin(user.id);
      await emit({
        type: "user_login_failed",
        // `email` as well as `userId`, because the submitted address is what makes
        // the record match a spray across many accounts, and it is what SEC-037's
        // regression test asserts. The route used to emit a second event carrying
        // exactly this; SEC-053 removed the duplicate, so the domain service
        // carries it now.
        payload: { reason: "invalid_password", userId: user.id, email: input.email, ip: input.ipAddress },
      });

      const attempts = updated?.failedLoginAttempts ?? 0;
      if (attempts >= config.ACCOUNT_LOCKOUT_THRESHOLD) {
        const lockedUntil = new Date(Date.now() + config.ACCOUNT_LOCKOUT_DURATION_SECONDS * 1000);
        await this.users.lockAccount(user.id, lockedUntil);
        return err({ code: "ACCOUNT_LOCKED", message: "Account locked due to too many failed attempts. Try again later.", statusCode: 403 });
      }

      if (await isFailedLoginAnomaly(user.id)) {
        return err({ code: "TOO_MANY_ATTEMPTS", message: "Too many failed attempts. Please try again later.", statusCode: 429 });
      }
      return err({ code: "INVALID_CREDENTIALS", message: "Invalid email or password.", statusCode: 401 });
    }

    await this.users.resetFailedLogins(user.id);
    const context = await this.loadAppContext(user.id, input.clientId);

    if (user.totpEnabled) {
      // requires_mfa: no access token, no refresh token, no session row, and no
      // `user_login` event. The only thing handed back is an opaque challenge.
      const challenge = await this.mfa.createChallenge(user, input.flow ?? "login", input.clientId, {
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      return ok({ status: "requires_mfa", user, challenge, context });
    }

    await this.users.updateLastSeen(user.id);
    const tokens = await this.issueTokens(user, context, input.ipAddress, input.userAgent);

    await emit({
      type: "user_login",
      payload: { provider: user.provider, userId: user.id, appId: context.org ? context.app?.id : undefined, orgId: context.org?.id },
    });

    return ok({ status: "authenticated", user, tokens, context });
  }

  private async issueTokens(
    user: User,
    context: AuthContext,
    ipAddress?: string,
    userAgent?: string,
    mfaFactor?: MfaAssertion
  ): Promise<TokenSet> {
    return createTokenSet(
      user,
      ipAddress,
      userAgent,
      {
        appId: context.org ? context.app?.id : undefined,
        orgId: context.org?.id,
        clientId: context.org ? context.app?.clientId : undefined,
        ...(mfaFactor ? { mfaFactor } : {}),
      },
      undefined,
      // The second step of a login is the only way to reach issuance with a
      // factor, so a token carrying one is always the MFA path.
      mfaFactor ? "mfa" : "password"
    );
  }

  /**
   * Second step of the login state machine: verify a factor against an
   * outstanding challenge and only then issue tokens. Replaying the same
   * challenge returns `MFA_CHALLENGE_REPLAYED` and issues nothing.
   */
  async completeMfa(
    challengeToken: string,
    code: string,
    factor: MfaFactor,
    ipAddress?: string,
    userAgent?: string
  ): Promise<Result<MfaCompletion>> {
    const result = await this.mfa.verifyChallenge(challengeToken, code, factor, (id) => this.users.findById(id));
    if (!result.success) return result;

    const { user, flow, clientId } = result.data;
    const context = await this.loadAppContext(user.id, clientId);

    let tokens: TokenSet;
    try {
      tokens = await this.issueTokens(user, context, ipAddress, userAgent, factor);
    } catch {
      await emit({ type: "mfa_bypass_blocked", payload: { userId: user.id, flow } });
      return err({
        code: "MFA_REQUIRED",
        message: "Multi-factor authentication could not be completed.",
        statusCode: 401,
      });
    }

    await this.users.updateLastSeen(user.id);
    await emit({
      type: "user_login",
      payload: {
        provider: user.provider,
        userId: user.id,
        mfa: factor,
        appId: context.org ? context.app?.id : undefined,
        orgId: context.org?.id,
      },
    });

    return ok({ user, tokens, context, flow, factor, clientId });
  }

  async refresh(
    refreshToken: string,
    clientId?: string,
    context?: { requestId?: string; ip?: string; userAgent?: string }
  ): Promise<Result<{ tokens: TokenSet; userId?: string }>> {
    // The outcome is named rather than a boolean, because three different
    // failures share one response and only one of them is an incident. A
    // replayed token has already had its credential family revoked by the token
    // service; a raced token is the same client asking twice; anything else is
    // a token the client lost. Collapsing them into one reason made a breach
    // indistinguishable from a stale tab, which is the distinction an operator
    // reads the log to make.
    const exchange = await exchangeRefreshToken(refreshToken, undefined, undefined, clientId);
    if (exchange.outcome !== "rotated") {
      const reason =
        exchange.outcome === "replayed"
          ? "refresh_token_replayed"
          : exchange.outcome === "raced"
            ? "refresh_token_raced"
            : "invalid_refresh_token";
      await emit({
        type: "token_refresh_failed",
        payload: {
          reason,
          // The request's own identity, so the audit row for a failed refresh
          // can be joined to the access log and to the client that reported
          // the failure.
          //
          // The route used to write a *second* event to carry this, which is
          // the duplicate SEC-053 removed elsewhere: two rows for one failure,
          // one of them misnamed. The context is passed in instead, so there is
          // one event and it says everything.
          ...(context?.requestId ? { requestId: context.requestId } : {}),
          ...(context?.ip ? { ip: context.ip } : {}),
          ...(context?.userAgent ? { userAgent: context.userAgent } : {}),
          ...(exchange.outcome === "replayed" || exchange.outcome === "raced"
            ? { userId: exchange.userId, metadata: { familyId: exchange.familyId } }
            : {}),
        },
      });
      return err({
        code: "INVALID_REFRESH_TOKEN",
        message: "Invalid or expired session.",
        statusCode: 401,
        // The reason travels with the error so a caller can act on it without
        // repeating the detection. The route used to do its own lookup, which
        // meant two places could disagree about whether a token was a replay —
        // and the OAuth grant path had no detection at all.
        //
        // `details` never reaches the client: `sendResultError` sends only
        // `{ error, code }`.
        details: {
          refreshFailure: reason,
          ...(exchange.outcome === "replayed" || exchange.outcome === "raced"
            ? { refreshFamilyId: exchange.familyId, userId: exchange.userId }
            : {}),
        },
      });
    }

    await emit({ type: "token_refresh", payload: { userId: exchange.tokens.userId } });
    return ok({ tokens: exchange.tokens, userId: exchange.tokens.userId });
  }

  async logout(refreshToken?: string): Promise<Result<void>> {
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    return ok(undefined);
  }

  async createPasswordResetToken(email: string): Promise<Result<{ token: string; user: User } | null>> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.isActive) return ok(null);

    const token = crypto.randomBytes(48).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    const tokenRepo = this.passwordResetTokens ?? resolve("passwordResetTokenRepository");
    await tokenRepo.create({ userId: user.id, tokenHash, expiresAt });

    await emit({ type: "password_reset_requested", payload: { userId: user.id } });
    return ok({ token, user });
  }

  async resetPasswordWithToken(token: string, newPassword: string): Promise<Result<User>> {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = new Date();

    // Claim the token before doing any work. A conditional SELECT followed by an
    // unconditional UPDATE would let parallel requests all pass the check and
    // each write a different password, last writer winning — so the claim is
    // the gate, and it happens first.
    const claim = await consumePasswordResetTokenRow(tokenHash, now);
    if (claim.outcome !== "consumed" || !claim.record) {
      if (claim.reason === "replayed") {
        await emit({ type: "password_reset_token_replayed", payload: {} });
      }
      return err({
        code: "INVALID_TOKEN",
        message: claim.reason === "expired" ? "This reset link has expired." : "Invalid or expired reset token.",
        statusCode: 400,
      });
    }

    const user = await this.users.findById(claim.record.userId);
    if (!user?.isActive) {
      return err({ code: "ACCOUNT_DEACTIVATED", message: "This account is deactivated.", statusCode: 403 });
    }

    if (config.HIBP_CHECK_ENABLED) {
      const breached = await isPasswordBreached(newPassword);
      if (breached) {
        return err({ code: "BREACHED_PASSWORD", message: "This password has appeared in a data breach.", statusCode: 400 });
      }
    }

    const passwordHash = await hashPassword(newPassword);
    await this.users.updatePasswordHash(user.id, passwordHash);

    // A reset is the standard response to a suspected compromise, so it has to
    // actually remove the intruder. Changing the password while leaving live
    // sessions and refresh tokens would let whoever prompted the reset keep
    // using the account. Also spends any other reset token issued alongside
    // this one, so an intercepted earlier email cannot be completed later.
    const revoked = await revokeAllUserCredentials(user.id);

    await emit({
      type: "password_reset_completed",
      payload: {
        userId: user.id,
        revokedSessions: revoked.sessions,
        revokedRefreshTokens: revoked.refreshTokens,
        revokedRecoveryCredentials: revoked.recoveryCredentials,
      },
    });
    return ok(user);
  }
}
