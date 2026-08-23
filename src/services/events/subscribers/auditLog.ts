import { db } from "../../../db/index.js";
import { auditLog } from "../../../db/schema.js";
import type { KeystoneEvent } from "../types.js";

export async function auditLogSubscriber(event: KeystoneEvent): Promise<void> {
  try {
    const { userId, orgId, appId, requestId, ip, userAgent, metadata } = event.payload;
    await db.insert(auditLog).values({
      userId: userId ?? null,
      orgId: orgId ?? null,
      appId: appId ?? null,
      requestId: requestId ?? null,
      event: `${event.type}:v${event.version}`,
      ipAddress: ip ?? null,
      userAgent: userAgent ?? null,
      metadata: { ...(metadata ?? {}), eventVersion: event.version },
    });
  } catch (err) {
    console.error("[audit-log-subscriber] failed to write event:", err);
  }
}
