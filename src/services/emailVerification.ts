import crypto from "node:crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailVerificationTokens, users, type User } from "../db/schema.js";
import { emailProvider } from "./email.js";

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

export async function consumeVerificationToken(token: string): Promise<User | undefined> {
  const tokenHash = hashToken(token);
  const now = new Date();

  const [record] = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, tokenHash),
        gt(emailVerificationTokens.expiresAt, now),
        isNull(emailVerificationTokens.usedAt)
      )
    )
    .limit(1);

  if (!record) return undefined;

  await db.update(emailVerificationTokens).set({ usedAt: now }).where(eq(emailVerificationTokens.id, record.id));

  const [user] = await db
    .update(users)
    .set({ emailVerified: true, updatedAt: now })
    .where(eq(users.id, record.userId))
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
