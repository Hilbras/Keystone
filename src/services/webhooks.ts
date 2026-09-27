import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { webhookDeliveries, webhookEndpoints, type WebhookEndpoint } from "../db/schema.js";
import { signWebhookPayload } from "../lib/webhookSignature.js";
import { ATTR, SPAN, recordSpan } from "./spans.js";
import { decryptSecret, encryptSecret } from "./totp.js";
import { queue } from "./queue/index.js";
import type { KeystoneEvent } from "./events/types.js";

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 30_000;

export type { WebhookEndpoint };

/**
 * Webhook signing secrets are encrypted at rest.
 *
 * Not hashed, which is the more usual answer for a credential, because Keystone
 * *signs* outbound payloads with this secret rather than merely comparing
 * against it. Hashing would make signing impossible; the plaintext has to be
 * recoverable, so recoverable secrets are the ones that must be encrypted.
 *
 * Stored in plaintext, a database dump yielded a working signing key for every
 * endpoint, letting an attacker forge deliveries the receiving service would
 * accept as genuine.
 *
 * Rows written before this change are still plaintext. `decryptSecret` detects
 * the versioned envelope and falls back to returning the value unchanged, so
 * existing endpoints keep verifying without a migration step; re-saving or
 * rotating an endpoint upgrades it.
 */
function encryptWebhookSecret(secret: string): string {
  return encryptSecret(secret);
}

/** Mirrors the envelope prefix used by `encryptSecret`. */
const ENCRYPTED_SECRET_PREFIX = "v2";

/**
 * Read a stored secret, accepting both the encrypted envelope and legacy
 * plaintext.
 *
 * `decryptSecret` cannot be used directly: it throws on anything that is not an
 * encrypted envelope, and the alternative it offers is a legacy *CBC* form, not
 * plaintext. Every webhook secret written before this change is plain, so
 * delegating to it would have thrown on the first delivery for every existing
 * endpoint.
 *
 * So the envelope is detected here and anything else is returned unchanged.
 * A plaintext secret is `whsec_` followed by base64url, which contains neither
 * the `.` of the versioned envelope nor the `:` of the legacy CBC form, so the
 * test is unambiguous.
 */
export function readWebhookSecret(stored: string): string {
  if (stored.startsWith(`${ENCRYPTED_SECRET_PREFIX}.`)) {
    return decryptSecret(stored);
  }
  return stored;
}

export async function listEndpoints(appId?: string) {
  if (appId) {
    return db.select().from(webhookEndpoints).where(eq(webhookEndpoints.appId, appId)).orderBy(webhookEndpoints.createdAt);
  }
  return db.select().from(webhookEndpoints).orderBy(webhookEndpoints.createdAt);
}

export async function createEndpoint(input: {
  appId?: string | null;
  url: string;
  description?: string;
  events?: string[];
}): Promise<WebhookEndpoint & { signingSecret: string }> {
  const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      appId: input.appId ?? null,
      url: input.url,
      description: input.description ?? null,
      events: input.events ?? [],
      // Encrypted at rest; the plaintext is returned exactly once, at creation.
      secret: encryptWebhookSecret(secret),
    })
    .returning();
  return { ...endpoint, signingSecret: secret };
}

export async function updateEndpoint(
  id: string,
  input: Partial<{ url: string; description: string | null; events: string[]; isActive: boolean }>
) {
  const [updated] = await db
    .update(webhookEndpoints)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return updated;
}

export async function deleteEndpoint(id: string) {
  const [deleted] = await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).returning();
  return deleted;
}

export async function rotateEndpointSecret(id: string) {
  const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  const [updated] = await db
    .update(webhookEndpoints)
    .set({ secret: encryptWebhookSecret(secret), updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return updated ? { endpoint: updated, signingSecret: secret } : undefined;
}

export async function listDeliveries(endpointId: string, limit = 50) {
  return db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, endpointId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
}

/**
 * Fan an event out to every active endpoint subscribed to it.
 * Each delivery is persisted first, then handed to the queue worker.
 */
export async function dispatchEvent(event: KeystoneEvent): Promise<void> {
  const endpoints = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.isActive, true));

  for (const endpoint of endpoints) {
    // App-scoped endpoints only receive events for their own application.
    if (endpoint.appId && event.payload.appId && endpoint.appId !== event.payload.appId) continue;
    if (endpoint.events.length > 0 && !endpoint.events.includes(event.type)) continue;

    const body = {
      id: crypto.randomUUID(),
      type: event.type,
      version: event.version,
      timestamp: event.timestamp,
      payload: event.payload,
    };

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({ endpointId: endpoint.id, eventType: event.type, payload: body })
      .returning();

    await queue.enqueue({
      type: "webhook-delivery",
      payload: { deliveryId: delivery.id },
    });
  }
}

export async function deliverNow(deliveryId: string): Promise<void> {
  const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
  if (!delivery) return;

  const [endpoint] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, delivery.endpointId)).limit(1);
  if (!endpoint || !endpoint.isActive) return;

  const attempts = delivery.attempts + 1;
  const now = new Date();

  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keystone-Signature": signWebhookPayload(readWebhookSecret(endpoint.secret), delivery.payload),
        "X-Keystone-Event": delivery.eventType,
        "X-Keystone-Delivery": delivery.id,
      },
      body: JSON.stringify(delivery.payload),
      signal: AbortSignal.timeout(10_000),
    });

    // The span covers the attempt and its outcome, which is what an operator
    // needs when a consumer starts rejecting: which endpoint, which attempt
    // number, and what came back. The HTTP exchange itself is already traced by
    // the auto-instrumentation, so it is not nested again.
    recordSpan(SPAN.webhookDelivery, {
      [ATTR.endpointId]: endpoint.id,
      [ATTR.attempt]: attempts,
      [ATTR.statusCode]: response.status,
      [ATTR.outcome]: response.ok ? "delivered" : "rejected",
    });

    const responseBody = (await response.text()).slice(0, 2000);
    await db
      .update(webhookDeliveries)
      .set({
        attempts,
        lastAttemptAt: now,
        responseStatus: response.status,
        responseBody,
        status: response.ok ? "success" : "failed",
      })
      .where(eq(webhookDeliveries.id, deliveryId));

    if (!response.ok && attempts < MAX_ATTEMPTS) {
      await retryLater(deliveryId);
    }
  } catch (err) {
    recordSpan(SPAN.webhookDelivery, {
      [ATTR.endpointId]: endpoint.id,
      [ATTR.attempt]: attempts,
      [ATTR.statusCode]: 0,
      [ATTR.outcome]: "unreachable",
    });
    await db
      .update(webhookDeliveries)
      .set({
        attempts,
        lastAttemptAt: now,
        responseBody: err instanceof Error ? err.message.slice(0, 2000) : "Delivery error",
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      })
      .where(eq(webhookDeliveries.id, deliveryId));

    if (attempts < MAX_ATTEMPTS) {
      await retryLater(deliveryId);
    }
  }
}

async function retryLater(deliveryId: string): Promise<void> {
  setTimeout(() => {
    queue.enqueue({ type: "webhook-delivery", payload: { deliveryId } }).catch((err: unknown) => {
      console.error("[webhooks] failed to re-enqueue delivery:", err);
    });
  }, RETRY_DELAY_MS).unref();
}

/** Manual retry from the dashboard: reset to pending and enqueue. */
export async function retryDelivery(deliveryId: string): Promise<boolean> {
  const [updated] = await db
    .update(webhookDeliveries)
    .set({ status: "pending" })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, "failed")))
    .returning();
  if (!updated) return false;
  await queue.enqueue({ type: "webhook-delivery", payload: { deliveryId } });
  return true;
}

/** Register the delivery worker with the queue. */
export function startWebhookWorker(): void {
  queue.process("webhook-delivery", async (job) => {
    const { deliveryId } = job.payload as { deliveryId: string };
    await deliverNow(deliveryId);
  });
}
