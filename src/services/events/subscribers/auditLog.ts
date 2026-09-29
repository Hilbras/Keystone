import { db } from "../../../db/index.js";
import { auditLog } from "../../../db/schema.js";
import type { KeystoneEvent } from "../types.js";
import { serviceLogger } from "../../../lib/logger.js";

const moduleLog = serviceLogger("events");

/**
 * A service-account principal is represented in-memory by an id of
 * `sa:<uuid>` so that routes expecting `request.user` keep working without a
 * matching user row.
 *
 * `audit_log.user_id` is a uuid column, so that sentinel cannot be written to it
 * as-is. Passing it through unfiltered made Postgres reject the whole insert, the
 * subscriber logged "failed to write event", and the audit record was lost.
 *
 * The practical effect was that **every request made with an API key or an mTLS
 * service account produced no audit entry at all** — the privileged, non-human
 * path, which is the one an attacker would most want to use quietly, was the one
 * that left no trace. Nothing failed visibly: the request succeeded, the
 * subscriber's `catch` swallowed the error, and the absence of a record looked
 * exactly like a request that never happened.
 *
 * So the sentinel is stripped and the service account is recorded in `metadata`
 * instead, which keeps the information without violating the column type.
 */
const SERVICE_ACCOUNT_PREFIX = "sa:";

function splitServiceAccountId(value: string | null | undefined): {
  userId: string | null;
  serviceAccountId: string | null;
} {
  if (value == null) return { userId: null, serviceAccountId: null };
  if (!value.startsWith(SERVICE_ACCOUNT_PREFIX)) return { userId: value, serviceAccountId: null };
  return { userId: null, serviceAccountId: value.slice(SERVICE_ACCOUNT_PREFIX.length) };
}

export async function auditLogSubscriber(event: KeystoneEvent): Promise<void> {
  try {
    const { userId: rawUserId, orgId, appId, requestId, ip, userAgent, metadata } = event.payload;
    const { userId, serviceAccountId } = splitServiceAccountId(rawUserId);

    await db.insert(auditLog).values({
      userId,
      orgId: orgId ?? null,
      appId: appId ?? null,
      requestId: requestId ?? null,
      event: `${event.type}:v${event.version}`,
      ipAddress: ip ?? null,
      userAgent: userAgent ?? null,
      metadata: {
        ...metadata,
        ...(serviceAccountId ? { serviceAccountId } : {}),
        eventVersion: event.version,
      },
    });
  } catch (err) {
    // A failure here means a security-relevant action went unrecorded, so it is
    // logged at error level and the reason is kept: an operator seeing a gap in
    // the audit log needs to know the write was attempted.
    moduleLog.error({ err }, "events");
  }
}
