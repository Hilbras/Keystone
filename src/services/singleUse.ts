import { and, eq, gt, isNull, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import { magicLinks, passwordResetTokens, smsOtpCodes } from "../db/schema.js";

/**
 * Atomic consumption of single-use credentials.
 *
 * A single-use credential has one dangerous shape, and it is always the same:
 *
 * ```text
 * SELECT ... WHERE used_at IS NULL      <- conditional
 * if (!row) return
 * UPDATE ... SET used_at = now()        <- UNCONDITIONAL: the race
 * ```
 *
 * Between the SELECT and the UPDATE, any number of concurrent requests can pass
 * the same check. A magic link redeemed by ten parallel requests logs in ten
 * times; a password reset token spent ten times over writes ten different
 * passwords, last writer winning.
 *
 * The fix is to make the write itself the gate:
 *
 * ```text
 * UPDATE ... SET used_at = now()
 * WHERE token_hash = ? AND expires_at > now() AND used_at IS NULL
 * RETURNING ...
 * ```
 *
 * PostgreSQL evaluates that predicate while holding a row lock, so exactly one
 * transaction can update the row and see a returned row. Everyone else matches
 * zero rows. The claim and the validation are one statement, so there is no
 * window between them to lose.
 *
 * All consumption goes through here so the pattern exists once. A credential
 * that consumes its own token inline is a credential that can be raced.
 */

export type ConsumeOutcome =
  /** This caller claimed the credential. */
  | "consumed"
  /** A row exists but was already spent. Somebody replayed it. */
  | "replayed"
  /** A row exists but has passed its expiry. */
  | "expired"
  /** No row for this value. */
  | "not_found";

export interface ConsumeResult<T> {
  outcome: ConsumeOutcome;
  /** Present only when `outcome` is `consumed`. */
  record?: T;
  /**
   * Why the credential was refused. Set for `replayed` and `expired`; omitted
   * for `not_found`, so a caller cannot distinguish "never existed" from
   * "deleted", which is itself information.
   */
  reason?: "replayed" | "expired";
}

/** The columns every single-use table shares. */
interface SingleUseShape {
  usedAt: Date | null;
  expiresAt: Date;
}

/**
 * Drizzle's column generics cannot express "any table with these three
 * columns", and the alternative is a cast per call site — which is worse,
 * because it is three places to get the predicate wrong instead of one. So the
 * cast lives here, once, and the concurrency tests in
 * `src/tests/security/single-use.test.ts` are the proof that the predicate this
 * writes is actually correct.
 */
type SingleUseTable = PgTable & {
  usedAt: PgColumn;
  expiresAt: PgColumn;
};

async function claimAndClassify<T extends SingleUseShape>(
  table: SingleUseTable,
  hashColumn: PgColumn,
  hashValue: string,
  now: Date,
  extra?: SQL
): Promise<ConsumeResult<T>> {
  const predicate = and(
    eq(hashColumn, hashValue),
    gt(table.expiresAt, now),
    isNull(table.usedAt),
    extra
  );

  const claimed = (await db
    .update(table)
    .set({ usedAt: now })
    .where(predicate)
    .returning()) as T[];

  if (claimed.length === 1) {
    return { outcome: "consumed", record: claimed[0] };
  }
  if (claimed.length > 1) {
    // The hash column is not unique, so "single use" cannot mean anything.
    throw new Error(
      `atomic claim matched ${claimed.length} rows; the hash column must be unique`
    );
  }

  // Why could we not claim it? Only worth distinguishing a replay, because that
  // means the credential leaked and somebody came back with it.
  const [existing] = (await db
    .select()
    .from(table)
    .where(and(eq(hashColumn, hashValue), extra))
    .limit(1)) as T[];

  if (!existing) return { outcome: "not_found" };
  if (existing.usedAt) return { outcome: "replayed", reason: "replayed" };
  if (existing.expiresAt.getTime() <= now.getTime()) {
    return { outcome: "expired", reason: "expired" };
  }

  // Present, unused, and unexpired, yet the claim matched nothing: another
  // transaction won the race between the two statements. From here that is a
  // replay.
  return { outcome: "replayed", reason: "replayed" };
}

export type MagicLinkRow = typeof magicLinks.$inferSelect;
export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type SmsOtpCodeRow = typeof smsOtpCodes.$inferSelect;

/** Atomically consume a magic link. */
export function consumeMagicLinkRow(
  tokenHash: string,
  now: Date
): Promise<ConsumeResult<MagicLinkRow>> {
  return claimAndClassify<MagicLinkRow>(magicLinks, magicLinks.tokenHash, tokenHash, now);
}

/** Atomically consume a password reset token. */
export function consumePasswordResetTokenRow(
  tokenHash: string,
  now: Date
): Promise<ConsumeResult<PasswordResetTokenRow>> {
  return claimAndClassify<PasswordResetTokenRow>(
    passwordResetTokens,
    passwordResetTokens.tokenHash,
    tokenHash,
    now
  );
}

/**
 * Atomically consume an SMS OTP code.
 *
 * Scoped to the user as well as the code. A code is six digits, so a lookup on
 * the hash alone could let one user's code be spent against another's row.
 */
export function consumeSmsOtpCodeRow(
  userId: string,
  codeHash: string,
  now: Date
): Promise<ConsumeResult<SmsOtpCodeRow>> {
  return claimAndClassify<SmsOtpCodeRow>(
    smsOtpCodes,
    smsOtpCodes.codeHash,
    codeHash,
    now,
    eq(smsOtpCodes.userId, userId)
  );
}
