import crypto from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { totpBackupCodes } from "../db/schema.js";

const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const raw = config.TOTP_ENCRYPTION_KEY || config.INTERNAL_API_KEY;
  if (raw && raw.length >= 32) {
    return Buffer.from(raw.slice(0, 32));
  }
  return crypto.createHash("sha256").update(raw || "keystone-totp-default").digest();
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
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(input.secret),
  });
  return totp.toString();
}

export function verifyTOTP(secret: string, code: string, window = 1): boolean {
  try {
    const totp = new TOTP({
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    });
    const delta = totp.validate({ token: code, window });
    return delta !== null;
  } catch {
    return false;
  }
}

export function encryptSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(encrypted: string): string {
  const [ivBase64, dataBase64] = encrypted.split(":");
  if (!ivBase64 || !dataBase64) throw new Error("Invalid encrypted secret format");
  const key = getEncryptionKey();
  const iv = Buffer.from(ivBase64, "base64url");
  const encryptedData = Buffer.from(dataBase64, "base64url");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString("utf8");
}

export function generateBackupCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString("hex").toLowerCase();
    codes.push(code);
    hashes.push(crypto.createHash("sha256").update(code).digest("hex"));
  }
  return { codes, hashes };
}

export async function storeBackupCodes(userId: string, codeHashes: string[]): Promise<void> {
  if (codeHashes.length === 0) return;
  await db.delete(totpBackupCodes).where(eq(totpBackupCodes.userId, userId));
  await db.insert(totpBackupCodes).values(
    codeHashes.map((hash) => ({ userId, codeHash: hash }))
  );
}

export async function verifyBackupCode(userId: string, code: string): Promise<boolean> {
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const now = new Date();

  const [record] = await db
    .select()
    .from(totpBackupCodes)
    .where(
      and(
        eq(totpBackupCodes.userId, userId),
        eq(totpBackupCodes.codeHash, codeHash),
        isNull(totpBackupCodes.usedAt)
      )
    )
    .limit(1);

  if (!record) return false;

  await db
    .update(totpBackupCodes)
    .set({ usedAt: now })
    .where(eq(totpBackupCodes.id, record.id));

  return true;
}
