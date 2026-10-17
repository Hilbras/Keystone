import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { refreshTokens } from "../db/schema.js";
import { hashToken } from "./tokens.js";

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
 */

type State = "live" | "consumed" | "revoked" | "expired" | "unknown";

async function stateOf(token: string): Promise<{ state: State; userId: string } | undefined> {
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
  return { state, userId: row.userId };
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