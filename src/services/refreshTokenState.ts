import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { refreshTokens } from "../db/schema.js";
import { hashToken } from "./tokens.js";

/**
 * Inspect a refresh token without consuming it.
 *
 * Rotation makes a presented token unusable, so by the time an exchange fails the
 * only way to tell a replay from a typo is to look the token up and see whether
 * it was already revoked. That distinction decides the response: a replay means
 * the token leaked and the account's remaining sessions should be revoked, while
 * an unknown token does not.
 */

type State = "live" | "revoked" | "expired" | "unknown";

async function stateOf(token: string): Promise<{ state: State; userId: string } | undefined> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return undefined;
  const state: State =
    row.revokedAt !== null
      ? "revoked"
      : row.expiresAt.getTime() <= Date.now()
        ? "expired"
        : "live";
  return { state, userId: row.userId };
}

/** True only when the token exists and has already been consumed. */
export async function findRefreshTokenState(token: string): Promise<boolean> {
  const found = await stateOf(token);
  return found?.state === "revoked";
}

/** The user a refresh token belongs to, or null if it is not known. */
export async function refreshTokenOwner(token: string): Promise<string | null> {
  const found = await stateOf(token);
  return found?.userId ?? null;
}
