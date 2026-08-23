import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { userDevices, users } from "../db/schema.js";
import { sendNewDeviceAlert } from "./email.js";

export function fingerprintFromRequest(request: FastifyRequest): string {
  const ip = request.ip || "unknown";
  const userAgent = request.headers["user-agent"] || "unknown";
  const acceptLanguage = request.headers["accept-language"] || "unknown";
  const value = `${ip}:${userAgent}:${acceptLanguage}`;
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function recordDevice(
  userId: string,
  fingerprint: string,
  ip?: string,
  userAgent?: string
) {
  const now = new Date();

  const [existing] = await db
    .select({ id: userDevices.id })
    .from(userDevices)
    .where(
      and(
        eq(userDevices.userId, userId),
        eq(userDevices.fingerprintHash, fingerprint)
      )
    )
    .limit(1);

  if (existing) {
    await db
      .update(userDevices)
      .set({
        lastSeenAt: now,
        ipAddress: ip ?? null,
        userAgent: userAgent ?? null,
      })
      .where(eq(userDevices.id, existing.id));
    return existing.id;
  }

  const [record] = await db
    .insert(userDevices)
    .values({
      userId,
      fingerprintHash: fingerprint,
      ipAddress: ip ?? null,
      userAgent: userAgent ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .returning();

  // Send new-device alert asynchronously; do not block the login flow.
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user && !record.newDeviceAlertSent) {
    sendNewDeviceAlert({
      email: user.email,
      ipAddress: ip,
      userAgent: userAgent,
    }).catch((err: unknown) => {
      console.error("[devices] failed to send new-device alert:", err);
    });
    await db
      .update(userDevices)
      .set({ newDeviceAlertSent: true })
      .where(eq(userDevices.id, record.id));
  }

  return record.id;
}
