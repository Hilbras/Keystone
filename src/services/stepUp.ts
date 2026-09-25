import { verifyPassword } from "./secrets/index.js";
import { verifyUserTotpCode } from "./totp.js";
import { err, ok, type KeystoneError, type Result } from "../lib/result.js";
import type { UserRepository } from "../repositories/types.js";
import type { User } from "../db/schema.js";

/**
 * Step-up authentication for endpoints that change how an account proves its
 * identity (enrolling a factor, registering a passkey).
 *
 * A stolen access token must not be enough to permanently take over an
 * account's second factor, so these endpoints require the current password in
 * addition to a valid session.
 */
export class StepUpService {
  constructor(private readonly users: UserRepository) {}

  /**
   * Verify the account password. Returns the same shape as the password step of
   * login, so callers get identical error codes and lockout accounting.
   */
  async verifyPassword(user: User, password: string): Promise<Result<{ user: User }>> {
    if (!user.isActive) {
      return err({ code: "ACCOUNT_DEACTIVATED", message: "This account is deactivated", statusCode: 403 });
    }
    if (user.accountReviewRequired) {
      return err({ code: "ACCOUNT_REVIEW_REQUIRED", message: "This account is pending review.", statusCode: 403 });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return err({ code: "ACCOUNT_LOCKED", message: "Account is temporarily locked due to too many failed attempts. Try again later.", statusCode: 403 });
    }
    if (!user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      const updated = await this.users.recordFailedLogin(user.id);
      if ((updated?.failedLoginAttempts ?? 0) >= 5) {
        await this.users.lockAccount(
          user.id,
          new Date(Date.now() + 30 * 60 * 1000)
        );
        return err({ code: "ACCOUNT_LOCKED", message: "Account locked due to too many failed attempts. Try again later.", statusCode: 403 });
      }
      return err({ code: "INVALID_CREDENTIALS", message: "Invalid password.", statusCode: 401 });
    }

    await this.users.resetFailedLogins(user.id);
    return ok({ user });
  }
}

export interface StepUpResult {
  ok: boolean;
  error?: KeystoneError;
}

/**
 * Require a current password for factor-management endpoints. Factor code
 * verification is handled separately by the caller, because the correct factor
 * depends on whether the account already has one.
 */
export async function requireStepUp(
  users: UserRepository,
  user: User,
  password: string | undefined
): Promise<StepUpResult> {
  if (!password) {
    return {
      ok: false,
      error: {
        code: "STEP_UP_REQUIRED",
        message: "Confirm your password to change how you sign in.",
        statusCode: 401,
      },
    };
  }

  const result = await new StepUpService(users).verifyPassword(user, password);
  if (result.success) return { ok: true };
  return { ok: false, error: result.error };
}

export { verifyUserTotpCode };
