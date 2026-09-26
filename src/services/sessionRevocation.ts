import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { passwordResetTokens, refreshTokens, userSessions } from "../db/schema.js";

/**
 * Centralized credential revocation.
 *
 * Every "this account should stop being logged in" operation routes through
 * here. Before this existed, revocation was open-coded per call site, and the
 * most important call site was missing entirely: completing a password reset
 * changed the password and left every existing session and refresh token
 * working. That defeats the purpose of a reset, which is the standard response
 * to a suspected compromise — the intruder keeps their session.
 *
 * The primitives below are deliberately separate so a caller can be precise
 * about what it invalidates, and so the composite operations are visibly
 * composed rather than reimplemented at each site.
 */

export interface RevocationCounts {
  refreshTokens: number;
  sessions: number;
  recoveryCredentials: number;
}

export interface RevokeOptions {
  /**
   * Keep this session and its refresh token alive, for a change the user is
   * making to their own account.
   *
   * Never pass it on a reset the user did not initiate themselves: the current
   * session is precisely what an attacker would be holding, and preserving it
   * would leave them in.
   */
  exceptSessionId?: string;
  /** Keep this refresh token alive, for the same reason. */
  exceptRefreshTokenId?: string;
}

const EMPTY: RevocationCounts = { refreshTokens: 0, sessions: 0, recoveryCredentials: 0 };

/**
 * Revoke the user's refresh tokens, so no further access token can be minted
 * from an existing session.
 */
export async function revokeRefreshTokens(
  userId: string,
  options: RevokeOptions = {}
): Promise<number> {
  const conditions = [eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)];
  if (options.exceptRefreshTokenId) {
    conditions.push(ne(refreshTokens.id, options.exceptRefreshTokenId));
  }
  const rows = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: refreshTokens.id });
  return rows.length;
}

/**
 * Revoke the user's authentication sessions.
 *
 * A revoked session stops authorising requests immediately; it is not merely
 * hidden from a session list.
 */
export async function revokeAuthenticationSessions(
  userId: string,
  options: RevokeOptions = {}
): Promise<number> {
  const conditions = [eq(userSessions.userId, userId), isNull(userSessions.revokedAt)];
  if (options.exceptSessionId) {
    conditions.push(ne(userSessions.id, options.exceptSessionId));
  }
  const rows = await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: userSessions.id });
  return rows.length;
}

/**
 * Revoke outstanding recovery credentials.
 *
 * A reset token already sitting in someone's inbox stays valid until it
 * expires unless it is spent here. Someone who intercepted an earlier reset
 * email could otherwise complete it after the user had already recovered.
 */
export async function revokeRecoveryCredentials(userId: string): Promise<number> {
  const rows = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)))
    .returning({ id: passwordResetTokens.id });
  return rows.length;
}

/**
 * Log the user out everywhere: sessions and refresh tokens together.
 *
 * This is what most credential changes want. Revoking only one leaves a live
 * credential behind: a session with no refresh token still authorises requests
 * until it expires, and a refresh token with no session can still mint access
 * tokens.
 */
export async function revokeUserSessions(
  userId: string,
  options: RevokeOptions = {}
): Promise<RevocationCounts> {
  const sessions = await revokeAuthenticationSessions(userId, options);
  const refreshTokensRevoked = await revokeRefreshTokens(userId, options);
  return { ...EMPTY, sessions, refreshTokens: refreshTokensRevoked };
}

/**
 * Everything: sessions, refresh tokens, and outstanding recovery credentials.
 *
 * Used after a password reset.
 *
 * API keys are deliberately **not** revoked. They are separately issued,
 * long-lived credentials belonging to integrations rather than to the person,
 * and silently killing them on a password reset breaks deployments without
 * improving the account's own security. The residual gap is real — an API key
 * minted by an attacker who already held the password survives — and the right
 * answer is key expiry and rotation rather than coupling key lifetime to a
 * human's password.
 */
export async function revokeAllUserCredentials(
  userId: string,
  options: RevokeOptions = {}
): Promise<RevocationCounts> {
  const sessions = await revokeAuthenticationSessions(userId, options);
  const refreshTokensRevoked = await revokeRefreshTokens(userId, options);
  const recoveryCredentials = await revokeRecoveryCredentials(userId);
  return { sessions, refreshTokens: refreshTokensRevoked, recoveryCredentials };
}
