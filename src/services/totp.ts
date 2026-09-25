import crypto from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { totpBackupCodes, users, type User } from "../db/schema.js";

/**
 * TOTP / backup-code primitives.
 *
 * The secret-level helpers below operate on raw base32 secrets and are only
 * used by enrollment flows. Interactive verification must always go through
 * {@link verifyUserTotpCode} or {@link verifyUserBackupCode}, which load the
 * user record, decrypt the stored secret, and apply replay protection. Never
 * pass a user id (or any other identifier) to a secret-level function.
 */

const LEGACY_ALGORITHM = "aes-256-cbc";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const SECRET_VERSION_PREFIX = "v2";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const BACKUP_CODE_COUNT = 10;

const CODE_PATTERN = /^[0-9]{6}$/;

function getEncryptionKey(): Buffer {
  const raw = config.TOTP_ENCRYPTION_KEY || config.INTERNAL_API_KEY;
  if (raw && raw.length >= 32) {
    return Buffer.from(raw.slice(0, 32));
  }
  return crypto.createHash("sha256").update(raw || "keystone-totp-default").digest();
}

/**
 * Keyed hash used for backup codes so that a leaked database dump cannot be
 * brute-forced offline without the server secret.
 */
function getPepperKey(): Buffer {
  return crypto
    .createHmac("sha256", getEncryptionKey())
    .update("keystone-totp-backup-code-pepper")
    .digest();
}

export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function buildProvisioningUri(input: { secret: string; email: string; issuer?: string }): string {
  const issuer = input.issuer || config.TOTP_ISSUER;
  const totp = new TOTP({
    issuer,
    label: input.email,
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(input.secret),
  });
  return totp.toString();
}

function createTotp(secret: string): TOTP {
  return new TOTP({
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  });
}

/**
 * Validate a raw base32 secret against a code, returning the matching TOTP
 * time-step counter (or null). The counter is required for replay protection.
 */
export function validateTotpCode(secret: string, code: string, window = 1, at = Date.now()): number | null {
  if (!CODE_PATTERN.test(code)) return null;
  try {
    const totp = createTotp(secret);
    const delta = totp.validate({ token: code, window, timestamp: at });
    if (delta === null) return null;
    return Math.floor(at / 1000 / TOTP_PERIOD_SECONDS) + delta;
  } catch {
    return null;
  }
}

/**
 * Secret-level verification for enrollment flows where the caller already holds
 * the plaintext secret. Interactive logins must not use this directly.
 */
export function verifyTOTP(secret: string, code: string, window = 1): boolean {
  return validateTotpCode(secret, code, window) !== null;
}

export function encryptSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_VERSION_PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a stored TOTP secret.
 *
 * Two formats exist in the wild:
 *   - `v2.<iv>.<tag>.<ciphertext>` — AES-256-GCM, written by this version.
 *   - `<iv>:<ciphertext>`          — legacy AES-256-CBC, still readable so
 *     authenticators enrolled before the upgrade are not locked out.
 */
export function decryptSecret(encrypted: string): string {
  if (encrypted.startsWith(`${SECRET_VERSION_PREFIX}.`)) {
    const [, ivBase64, tagBase64, dataBase64] = encrypted.split(".");
    if (!ivBase64 || !tagBase64 || !dataBase64) throw new Error("Invalid encrypted secret format");

    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(ivBase64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagBase64, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataBase64, "base64url")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }

  if (encrypted.includes(":")) {
    const [ivBase64, dataBase64] = encrypted.split(":");
    if (!ivBase64 || !dataBase64) throw new Error("Invalid encrypted secret format");

    const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, getEncryptionKey(), Buffer.from(ivBase64, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataBase64, "base64url")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }

  throw new Error("Invalid encrypted secret format");
}

export interface TotpVerificationResult {
  valid: boolean;
  /** Time-step counter when the code matched, so callers can audit the step. */
  counter?: number;
}

/**
 * Verify a TOTP code for a user using the user's decrypted secret, and consume
 * the time-step so a captured code cannot be replayed.
 */
export async function verifyUserTotpCode(
  user: Pick<User, "id" | "totpEnabled" | "totpSecret">,
  code: string,
  options: { window?: number; consume?: boolean; requireEnabled?: boolean } = {}
): Promise<TotpVerificationResult> {
  const requireEnabled = options.requireEnabled ?? true;
  if (requireEnabled && !user.totpEnabled) return { valid: false };
  if (!user.totpSecret) return { valid: false };
  if (!CODE_PATTERN.test(code)) return { valid: false };

  let secret: string;
  try {
    secret = decryptSecret(user.totpSecret);
  } catch {
    return { valid: false };
  }

  const counter = validateTotpCode(secret, code, options.window ?? 1);
  if (counter === null) return { valid: false };

  if (options.consume === false) return { valid: true, counter };

  const consumed = await consumeTotpStep(user.id, counter);
  if (!consumed) return { valid: false };
  return { valid: true, counter };
}

/**
 * Atomically advance the user's last accepted TOTP step. Returns false when the
 * step was already consumed (replay) or is older than the recorded step.
 */
async function consumeTotpStep(userId: string, counter: number): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ totpLastStep: counter })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.totpLastStep), sql`${users.totpLastStep} < ${counter}`)
      )
    )
    .returning({ id: users.id });
  return rows.length === 1;
}

export function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]/g, "").trim().toUpperCase();
}

export function hashBackupCode(code: string): string {
  return crypto
    .createHmac("sha256", getPepperKey())
    .update(normalizeBackupCode(code))
    .digest("hex");
}

export function generateBackupCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    // 80 bits of entropy, formatted for legibility.
    const raw = crypto.randomBytes(10).toString("hex").toUpperCase();
    const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
    codes.push(code);
    hashes.push(hashBackupCode(code));
  }
  return { codes, hashes };
}

function backupCodeExpiry(from = new Date()): Date {
  return new Date(from.getTime() + config.TOTP_BACKUP_CODE_TTL_SECONDS * 1000);
}

/**
 * Replace a user's backup codes atomically so a regeneration failure can never
 * leave the account without codes.
 */
export async function storeBackupCodes(userId: string, codeHashes: string[]): Promise<void> {
  if (codeHashes.length === 0) return;
  const expiresAt = backupCodeExpiry();
  await db.transaction(async (tx) => {
    await tx.delete(totpBackupCodes).where(eq(totpBackupCodes.userId, userId));
    await tx.insert(totpBackupCodes).values(codeHashes.map((codeHash) => ({ userId, codeHash, expiresAt })));
  });
}

export async function deleteBackupCodes(userId: string): Promise<void> {
  await db.delete(totpBackupCodes).where(eq(totpBackupCodes.userId, userId));
}

/**
 * Consume a backup code with a single conditional update so concurrent attempts
 * can never both succeed, and expired codes are rejected.
 */
export async function verifyBackupCode(userId: string, code: string): Promise<boolean> {
  if (typeof code !== "string" || code.trim().length === 0) return false;
  const codeHash = hashBackupCode(code);
  const now = new Date();

  const consumed = await db
    .update(totpBackupCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(totpBackupCodes.userId, userId),
        eq(totpBackupCodes.codeHash, codeHash),
        isNull(totpBackupCodes.usedAt),
        gt(totpBackupCodes.expiresAt, now)
      )
    )
    .returning({ id: totpBackupCodes.id });

  return consumed.length === 1;
}
