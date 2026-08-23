import crypto from "node:crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { config, isZitadelConfigured } from "../../config.js";
import { db } from "../../db/index.js";
import { users, passwordResetTokens, type User } from "../../db/schema.js";
import { createHumanUser, verifyPassword as verifyZitadelPassword } from "../zitadel.js";
import { createTokenSet, rotateRefreshToken, revokeRefreshToken, type TokenSet } from "../tokens.js";
import { isPasswordBreached } from "../hibp.js";
import { recordFailedLogin, isFailedLoginAnomaly } from "../anomalyDetection.js";
import { emit } from "../events/bus.js";
import type { UserRepository } from "../../repositories/types.js";
import { ok, err, type Result } from "../../lib/result.js";

export interface AuthContext {
  app?: { id: string; clientId: string; orgId: string };
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
}

export interface TokenResponse {
  user: User;
  tokens: TokenSet;
  context: AuthContext;
}

export class AuthenticationDomainService {
  constructor(private readonly users: UserRepository) {}

  private async loadAppContext(clientId?: string): Promise<AuthContext> {
    if (!clientId) return {};
    const { DrizzleApplicationRepository } = await import("../../repositories/application.js");
    const apps = new DrizzleApplicationRepository();
    const app = await apps.findByClientId(clientId);
    if (!app) return {};
    return {
      app: { id: app.id, clientId: app.clientId, orgId: app.orgId },
      org: { id: app.orgId },
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

    const passwordHash = await (await import("../secrets/index.js")).hashPassword(input.password);
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
        console.warn("Zitadel user mirror failed; continuing with local user", err);
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
      const { sendVerificationEmail } = await import("../emailVerification.js");
      sendVerificationEmail(user).catch((err: unknown) => {
        console.error("[auth] failed to send verification email:", err);
      });
    }

    const context = await this.loadAppContext(input.clientId);
    const tokens = await createTokenSet(user, undefined, undefined, {
      appId: context.app?.id,
      orgId: context.org?.id,
      clientId: context.app?.clientId,
    });

    await emit({
      type: "user_registered",
      payload: {
        provider: "password",
        zitadelUserId,
        userId: user.id,
        username: user.username,
        email: user.email,
        client_id: input.clientId,
        appId: context.app?.id,
        orgId: context.org?.id,
      },
    });

    return ok({ user, tokens, context });
  }

  async login(input: LoginInput): Promise<Result<TokenResponse>> {
    const user = await this.users.findByEmail(input.email);

    if (!user) {
      if (isZitadelConfigured()) {
        await verifyZitadelPassword(input.email, input.password).catch(() => {});
      }
      await recordFailedLogin(input.email);
      await emit({ type: "user_login_failed", payload: { reason: "unknown_user" } });
      if (await isFailedLoginAnomaly(input.email)) {
        return err({ code: "TOO_MANY_ATTEMPTS", message: "Too many failed attempts. Please try again later.", statusCode: 429 });
      }
      return err({ code: "INVALID_CREDENTIALS", message: "Invalid email or password.", statusCode: 401 });
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await emit({ type: "user_login_failed", payload: { reason: "account_locked", userId: user.id } });
      return err({ code: "ACCOUNT_LOCKED", message: "Account is temporarily locked due to too many failed attempts. Try again later.", statusCode: 403 });
    }

    const { verifyPassword } = await import("../secrets/index.js");
    let valid = false;
    if (user.passwordHash) {
      valid = await verifyPassword(input.password, user.passwordHash);
    } else if (user.provider === "zitadel" && isZitadelConfigured()) {
      valid = await verifyZitadelPassword(input.email, input.password);
    }

    if (!valid) {
      const updated = await this.users.recordFailedLogin(user.id);
      await emit({ type: "user_login_failed", payload: { reason: "invalid_password", userId: user.id } });

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
    await this.users.updateLastSeen(user.id);
    const context = await this.loadAppContext(input.clientId);
    const tokens = await createTokenSet(user, undefined, undefined, {
      appId: context.app?.id,
      orgId: context.org?.id,
      clientId: context.app?.clientId,
    });

    await emit({
      type: "user_login",
      payload: { provider: user.provider, userId: user.id, appId: context.app?.id, orgId: context.org?.id },
    });

    return ok({ user, tokens, context });
  }

  async refresh(refreshToken: string, clientId?: string): Promise<Result<{ tokens: TokenSet; userId?: string }>> {
    const tokens = await rotateRefreshToken(refreshToken, undefined, undefined);
    if (!tokens) {
      await emit({ type: "token_refresh_failed", payload: { reason: "invalid_refresh_token" } });
      return err({ code: "INVALID_REFRESH_TOKEN", message: "Invalid or expired session.", statusCode: 401 });
    }

    await emit({ type: "token_refresh", payload: {} });
    return ok({ tokens, userId: undefined });
  }

  async logout(refreshToken?: string): Promise<Result<void>> {
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    return ok(undefined);
  }

  async createPasswordResetToken(email: string): Promise<Result<{ token: string; user: User } | null>> {
    const user = await this.users.findByEmail(email);
    if (!user) return ok(null);

    const token = crypto.randomBytes(48).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    await emit({ type: "password_reset_requested", payload: { userId: user.id } });
    return ok({ token, user });
  }

  async resetPasswordWithToken(token: string, newPassword: string): Promise<Result<User>> {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = new Date();

    const [record] = await db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          gt(passwordResetTokens.expiresAt, now),
          isNull(passwordResetTokens.usedAt)
        )
      )
      .limit(1);

    if (!record) {
      return err({ code: "INVALID_TOKEN", message: "Invalid or expired reset token.", statusCode: 400 });
    }

    const user = await this.users.findById(record.userId);
    if (!user) {
      return err({ code: "USER_NOT_FOUND", message: "User not found.", statusCode: 400 });
    }

    if (config.HIBP_CHECK_ENABLED) {
      const breached = await isPasswordBreached(newPassword);
      if (breached) {
        return err({ code: "BREACHED_PASSWORD", message: "This password has appeared in a data breach.", statusCode: 400 });
      }
    }

    const passwordHash = await (await import("../secrets/index.js")).hashPassword(newPassword);
    await db.transaction(async (tx) => {
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(eq(passwordResetTokens.id, record.id));
      await tx
        .update(users)
        .set({ passwordHash, updatedAt: now })
        .where(eq(users.id, user.id));
    });

    await emit({ type: "password_reset_completed", payload: { userId: user.id } });
    return ok(user);
  }
}
