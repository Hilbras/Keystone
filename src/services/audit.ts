import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditLog } from "../db/schema.js";
import { emit } from "./events/bus.js";
import type { AuditEventType, EventPayload } from "./events/types.js";

export type AuditEvent = AuditEventType;

export interface AuditInput extends EventPayload {
  event: AuditEvent;
}

export async function persistAudit(input: AuditInput): Promise<void> {
  const { userId, orgId, appId, requestId, ip, userAgent, metadata } = input;
  await db.insert(auditLog).values({
    userId: userId ?? null,
    orgId: orgId ?? null,
    appId: appId ?? null,
    requestId: requestId ?? null,
    event: `${input.event}:v1`,
    ipAddress: ip ?? null,
    userAgent: userAgent ?? null,
    metadata: { ...metadata, eventVersion: 1 },
  });
}

export async function audit(input: AuditInput): Promise<void> {
  await emit({ type: input.event, version: 1, payload: input });
}

export async function listAuditLogs(opts: {
  orgId?: string;
  appId?: string;
  userId?: string;
  event?: string;
  limit?: number;
  offset?: number;
}): Promise<typeof auditLog.$inferSelect[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const conditions = [];
  if (opts.orgId) conditions.push(eq(auditLog.orgId, opts.orgId));
  if (opts.appId) conditions.push(eq(auditLog.appId, opts.appId));
  if (opts.userId) conditions.push(eq(auditLog.userId, opts.userId));
  if (opts.event) conditions.push(eq(auditLog.event, opts.event));

  return db
    .select()
    .from(auditLog)
    .where(conditions.length ? and(...conditions) : sql`true`)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);
}
