import crypto from "node:crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { magicLinks, users, type User } from "../db/schema.js";
import { config } from "../config.js";

export function generateMagicLink(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(48).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export async function storeMagicLink(userId: string, tokenHash: string, expiresAt: Date) {
  const [record] = await db
    .insert(magicLinks)
    .values({
      userId,
      tokenHash,
      expiresAt,
    })
    .returning();
  return record;
}

export async function consumeMagicLink(token: string): Promise<User | undefined> {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = new Date();

  const [record] = await db
    .select()
    .from(magicLinks)
    .where(
      and(
        eq(magicLinks.tokenHash, tokenHash),
        gt(magicLinks.expiresAt, now),
        isNull(magicLinks.usedAt)
      )
    )
    .limit(1);

  if (!record) return undefined;

  await db.update(magicLinks).set({ usedAt: now }).where(eq(magicLinks.id, record.id));

  const [user] = await db.select().from(users).where(eq(users.id, record.userId)).limit(1);
  return user;
}

export function magicLinkExpiresAt(): Date {
  return new Date(Date.now() + config.MAGIC_LINK_TTL_SECONDS * 1000);
}
