import crypto from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { refreshTokens, userSessions } from "../db/schema.js";

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

/**
 * The hash a refresh token is stored under.
 *
 * A local copy rather than an import from `tokens.ts`: the token service
 * imports this module to detect a replay, and importing `hashToken` back from
 * there would close a cycle between the two. The same one-line helper is
 * already written out this way in `routes/sessions.ts` and
 * `services/emailVerification.ts`, and it must stay byte-identical to
 * `tokens.ts` — it is the same function, not a variant of it.
 */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

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
