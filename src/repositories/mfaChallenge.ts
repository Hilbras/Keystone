import { and, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { mfaChallenges, type MfaChallenge } from "../db/schema.js";
import type { CreateMfaChallengeInput, MfaChallengeRepository } from "./types.js";

/**
 * Durable storage for pre-authentication MFA challenges.
 *
 * Challenges are single-use: `consume` performs a conditional update so two
 * concurrent verifications can never both complete, and only the stored hash of
 * the challenge is persisted.
 */
export class DrizzleMfaChallengeRepository implements MfaChallengeRepository {
  async create(input: CreateMfaChallengeInput): Promise<MfaChallenge> {
    const [created] = await db
      .insert(mfaChallenges)
      .values({
        challengeHash: input.challengeHash,
        userId: input.userId,
        flow: input.flow,
        clientId: input.clientId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        expiresAt: input.expiresAt,
        maxAttempts: input.maxAttempts,
      })
      .returning();
    return created;
  }

  async findByHash(challengeHash: string): Promise<MfaChallenge | undefined> {
    const [found] = await db
      .select()
      .from(mfaChallenges)
      .where(eq(mfaChallenges.challengeHash, challengeHash))
      .limit(1);
    return found;
  }

  /**
   * Record a failed attempt only while the challenge is still active and below
   * its attempt budget. Reaching the budget marks the challenge failed so it can
   * never be used again.
   */
  async recordFailedAttempt(id: string, now: Date): Promise<MfaChallenge | undefined> {
    const rows = await db
      .update(mfaChallenges)
      .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
      .where(
        and(
          eq(mfaChallenges.id, id),
          eq(mfaChallenges.status, "requires_mfa"),
          isNull(mfaChallenges.consumedAt),
          gt(mfaChallenges.expiresAt, now),
          lt(mfaChallenges.attempts, mfaChallenges.maxAttempts)
        )
      )
      .returning();
    return rows[0];
  }

  async consume(id: string, now: Date): Promise<MfaChallenge | undefined> {
    const rows = await db
      .update(mfaChallenges)
      .set({ status: "consumed", consumedAt: now })
      .where(
        and(
          eq(mfaChallenges.id, id),
          eq(mfaChallenges.status, "requires_mfa"),
          isNull(mfaChallenges.consumedAt),
          gt(mfaChallenges.expiresAt, now)
        )
      )
      .returning();
    return rows[0];
  }

  async invalidateUserChallenges(userId: string, now: Date): Promise<void> {
    await db
      .update(mfaChallenges)
      .set({ status: "failed", consumedAt: now })
      .where(
        and(
          eq(mfaChallenges.userId, userId),
          eq(mfaChallenges.status, "requires_mfa"),
          isNull(mfaChallenges.consumedAt)
        )
      );
  }

  async deleteExpired(now: Date): Promise<number> {
    const rows = await db
      .delete(mfaChallenges)
      .where(
        and(
          inArray(mfaChallenges.status, ["requires_mfa", "failed"]),
          lte(mfaChallenges.expiresAt, now)
        )
      )
      .returning({ id: mfaChallenges.id });
    return rows.length;
  }
}
