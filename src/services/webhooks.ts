import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { webhookDeliveries, webhookEndpoints, type WebhookEndpoint } from "../db/schema.js";
import { signWebhookPayload } from "../lib/webhookSignature.js";
import { queue } from "./queue/index.js";
import type { KeystoneEvent } from "./events/types.js";

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 30_000;

export type { WebhookEndpoint };

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
      secret,
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
    .set({ secret, updatedAt: new Date() })
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
        "X-Keystone-Signature": signWebhookPayload(endpoint.secret, delivery.payload),
        "X-Keystone-Event": delivery.eventType,
        "X-Keystone-Delivery": delivery.id,
      },
      body: JSON.stringify(delivery.payload),
      signal: AbortSignal.timeout(10_000),
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
