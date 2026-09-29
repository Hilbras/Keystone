import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailVerificationTokens, users, type User } from "../db/schema.js";
import { emailProvider } from "./email.js";
import { consumeEmailVerificationTokenRow } from "./singleUse.js";

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateVerificationToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(48).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export async function storeVerificationToken(userId: string, tokenHash: string) {
  const [record] = await db
    .insert(emailVerificationTokens)
    .values({
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
    })
    .returning();
  return record;
}

/**
 * Verify an address from a token, exactly once.
 *
 * The claim is atomic and lives in `singleUse.ts` with the other three single-use
 * credentials. It used to be a read followed by an update, which is not a claim:
 * two requests arriving together both saw `usedAt IS NULL`, both wrote it, and
 * both returned the user. Verification is idempotent so nothing extra was granted,
 * but "single use" was not true, and the old shape is the one people copy.
 */
export async function consumeVerificationToken(token: string): Promise<User | undefined> {
  const result = await consumeEmailVerificationTokenRow(hashToken(token), new Date());
  if (result.outcome !== "consumed" || !result.record) return undefined;

  const [user] = await db
    .update(users)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(users.id, result.record.userId))
    .returning();

  return user;
}

function verificationUrl(token: string): string {
  const base = process.env.CLIENT_APP_URL || "http://localhost:5173";
  return `${base}/#verify-email=${encodeURIComponent(token)}`;
}

export async function sendVerificationEmail(user: { id: string; email: string; name?: string | null }): Promise<void> {
  const { token, tokenHash } = generateVerificationToken();
  await storeVerificationToken(user.id, tokenHash);

  const url = verificationUrl(token);
  await emailProvider.send({
    to: user.email,
    subject: "Verify your email address",
    text: `Hi${user.name ? ` ${user.name}` : ""},\n\nPlease verify your email address by clicking the link below:\n\n${url}\n\nThis link expires in 24 hours.`,
    html: `<p>Hi${user.name ? ` ${user.name}` : ""},</p><p>Please verify your email address by clicking <a href="${url}">here</a>.</p><p>This link expires in 24 hours.</p>`,
  });
}
