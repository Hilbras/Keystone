import crypto from "node:crypto";
import { config } from "../config.js";
import { emit } from "./events/bus.js";
import { verifyBackupCode, verifyUserTotpCode } from "./totp.js";
import type { User } from "../db/schema.js";
import type { MfaChallengeRepository, MfaFlow } from "../repositories/types.js";
import { err, ok, type Result } from "../lib/result.js";

/**
 * MFA challenge lifecycle.
 *
 * ```text
 * password_step   -> password valid, MFA enabled  -> requires_mfa
 * requires_mfa    -> no access or refresh token has been issued
 * mfa_step        -> factor verified                -> mfa_verified -> authenticated
 * ```
 *
 * The opaque challenge value is only ever returned to the client; the database
 * stores a SHA-256 hash of it. Every state transition is a single conditional
 * database update so a challenge can be consumed exactly once.
 */

export type MfaFactor = "totp" | "backup_code";

export interface IssuedMfaChallenge {
  challenge: string;
  expiresAt: Date;
  flow: MfaFlow;
  clientId?: string;
}

export interface MfaChallengeMeta {
  ipAddress?: string;
  userAgent?: string;
}

export function hashMfaChallenge(challenge: string): string {
  return crypto.createHash("sha256").update(challenge).digest("hex");
}

export function isMfaChallengeUsable(
  challenge: { status: string; attempts: number; maxAttempts: number; consumedAt: Date | null; expiresAt: Date },
  now = new Date()
): boolean {
  if (challenge.status !== "requires_mfa" || challenge.consumedAt) return false;
  if (challenge.attempts >= challenge.maxAttempts) return false;
  return challenge.expiresAt > now;
}

export class MfaService {
  constructor(private readonly challenges: MfaChallengeRepository) {}

  async createChallenge(
    user: User,
    flow: MfaFlow,
    clientId: string | undefined,
    meta: MfaChallengeMeta = {}
  ): Promise<IssuedMfaChallenge> {
    // Only a single outstanding challenge per user per flow: superseding it
    // stops a leaked challenge from remaining usable after a fresh password step.
    await this.challenges.invalidateUserChallenges(user.id, new Date());

    const challenge = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + config.MFA_CHALLENGE_TTL_SECONDS * 1000);

    await this.challenges.create({
      challengeHash: hashMfaChallenge(challenge),
      userId: user.id,
      flow: normalizeFlow(flow),
      clientId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      expiresAt,
      maxAttempts: config.MFA_MAX_ATTEMPTS,
    });

    await emit({
      type: "mfa_challenge_created",
      payload: {
        userId: user.id,
        flow,
        client_id: clientId,
        ip: meta.ipAddress,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return { challenge, expiresAt, flow, clientId };
  }

  /**
   * Verify a second factor for an outstanding challenge and consume it.
   * No token is issued here: the caller decides what to issue after the state
   * transition to `mfa_verified` has succeeded.
   */
  async verifyChallenge(
    challengeToken: string,
    code: string,
    factor: MfaFactor,
    loadUser: (userId: string) => Promise<User | undefined>
  ): Promise<Result<{ challengeId: string; user: User; flow: MfaFlow; clientId?: string }>> {
    const now = new Date();
    const challenge = await this.challenges.findByHash(hashMfaChallenge(challengeToken));
    if (!challenge) {
      await emit({ type: "mfa_challenge_rejected", payload: { reason: "unknown_challenge" } });
      return err({ code: "MFA_CHALLENGE_INVALID", message: "The MFA challenge is invalid or has expired.", statusCode: 401 });
    }

    if (challenge.expiresAt <= now) {
      await emit({ type: "mfa_challenge_expired", payload: { userId: challenge.userId, reason: "expired" } });
      return err({ code: "MFA_CHALLENGE_EXPIRED", message: "The MFA challenge is invalid or has expired.", statusCode: 401 });
    }

    if (!isMfaChallengeUsable(challenge, now)) {
      const reason = challenge.status !== "requires_mfa" ? challenge.status : "attempts_exhausted";
      await emit({
        type: challenge.status === "requires_mfa" ? "mfa_challenge_failed" : "mfa_challenge_rejected",
        payload: { userId: challenge.userId, reason },
      });
      return err({
        code: challenge.status === "consumed" ? "MFA_CHALLENGE_REPLAYED" : "MFA_CHALLENGE_LOCKED",
        message: "The MFA challenge is invalid or has expired.",
        statusCode: 401,
      });
    }

    const user = await loadUser(challenge.userId);
    if (!user || !user.isActive) {
      await this.challenges.invalidateUserChallenges(challenge.userId, now);
      await emit({ type: "mfa_challenge_failed", payload: { userId: challenge.userId, reason: "account_unusable" } });
      return err({ code: "ACCOUNT_UNAVAILABLE", message: "This account cannot sign in.", statusCode: 403 });
    }

    if (!user.totpEnabled) {
      // The factor was disabled while the challenge was outstanding.
      await this.challenges.invalidateUserChallenges(user.id, now);
      await emit({ type: "mfa_challenge_failed", payload: { userId: user.id, reason: "mfa_disabled" } });
      return err({ code: "MFA_NOT_REQUIRED", message: "Multi-factor authentication is no longer required.", statusCode: 409 });
    }

    const verified =
      factor === "totp"
        ? (await verifyUserTotpCode(user, code)).valid
        : await verifyBackupCode(user.id, code);

    if (!verified) {
      const updated = await this.challenges.recordFailedAttempt(challenge.id, now);
      await emit({
        type: "mfa_challenge_failed",
        payload: {
          userId: user.id,
          factor,
          attempts: updated?.attempts ?? challenge.attempts + 1,
          attemptsRemaining: updated ? Math.max(0, updated.maxAttempts - updated.attempts) : 0,
        },
      });
      return err({ code: "MFA_INVALID_CODE", message: "The verification code is invalid.", statusCode: 401 });
    }

    const consumed = await this.challenges.consume(challenge.id, new Date());
    if (!consumed) {
      // Lost the race against a concurrent verification of the same challenge.
      await emit({ type: "mfa_challenge_rejected", payload: { userId: user.id, reason: "already_consumed" } });
      return err({ code: "MFA_CHALLENGE_REPLAYED", message: "The MFA challenge is invalid or has expired.", statusCode: 401 });
    }

    await emit({
      type: "mfa_verified",
      payload: { userId: user.id, factor, flow: challenge.flow },
    });

    return ok({
      challengeId: challenge.id,
      user,
      flow: normalizeFlow(challenge.flow),
      clientId: challenge.clientId ?? undefined,
    });
  }
}

function normalizeFlow(flow: string): MfaFlow {
  return flow === "token_login" ? "token_login" : "login";
}
