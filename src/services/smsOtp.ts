import crypto from "node:crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { smsOtpCodes, users, type User } from "../db/schema.js";
import { smsProvider } from "./sms.js";

const CODE_TTL_SECONDS = 300;
const CODE_LENGTH = 6;

export function generateSmsCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(CODE_LENGTH, "0");
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export async function sendSmsOtp(user: User, phoneNumber: string): Promise<string> {
  const code = generateSmsCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);

  await db.insert(smsOtpCodes).values({
    userId: user.id,
    phoneNumber,
    codeHash: hashCode(code),
    expiresAt,
  });

  await smsProvider.send({
    to: phoneNumber,
    body: `Your Hilbras verification code is: ${code}`,
  });

  return code;
}

export async function verifySmsOtp(userId: string, code: string): Promise<boolean> {
  const codeHash = hashCode(code);
  const now = new Date();

  const [record] = await db
    .select()
    .from(smsOtpCodes)
    .where(
      and(
        eq(smsOtpCodes.userId, userId),
        eq(smsOtpCodes.codeHash, codeHash),
        gt(smsOtpCodes.expiresAt, now),
        isNull(smsOtpCodes.usedAt)
      )
    )
    .limit(1);

  if (!record) return false;

  await db.update(smsOtpCodes).set({ usedAt: now }).where(eq(smsOtpCodes.id, record.id));
  return true;
}

export async function hasVerifiedPhone(userId: string): Promise<boolean> {
  const [user] = await db
    .select({ phoneVerified: users.phoneVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.phoneVerified ?? false;
}

export async function markPhoneVerified(userId: string, phoneNumber: string): Promise<void> {
  await db
    .update(users)
    .set({ phoneNumber, phoneVerified: true })
    .where(eq(users.id, userId));
}
