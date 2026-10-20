import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
// Keep the queue in-process: these tests are about the database predicates, and a
// real BullMQ connection would make them depend on Redis timing.
process.env.KEYSTONE_QUEUE_PROVIDER = "in-process";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { webhookEndpoints, webhookDeliveries } = await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");
const { redis } = await import("../../services/redis.js");
const { queue } = await import("../../services/queue/index.js");
const { reclaimStaleDeliveries, reenqueuePendingDeliveries } = await import(
  "../../services/webhooks.js"
);

/**
 * §6.4. Two opposite recovery failures, both silent:
 *
 * - `processing` with an expired claim — the row is neither pending (so nothing
 *   retries it) nor failed (so nothing reports it);
 * - `pending` with no live job — the queue entry was lost with Redis or with an
 *   in-process process, and the row sits at `pending` forever, visible and dead.
 *
 * The stale-claim sweep covered the first. This suite pins that it still does, and
 * that the second is now re-enqueued.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
let endpointId = "";

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.invalid/recovery-${RUN_ID}`,
      secret: crypto.randomBytes(16).toString("hex"),
      description: "startup recovery test",
    })
    .returning({ id: webhookEndpoints.id });
  endpointId = endpoint.id;
  queue.process("webhook-delivery", async () => {});
});

after(async () => {
  await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId)).catch(() => {});
  await queue.close?.().catch(() => {});
  await closeDb().catch(() => {});
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("webhook delivery recovery", () => {
  it("returns a delivery stuck in processing to pending", async () => {
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        endpointId,
        eventType: "user_login",
        status: "processing",
        attempts: 1,
        lockedAt: new Date(Date.now() - 20 * 60 * 1000),
        lockedBy: "dead-worker",
      })
      .returning({ id: webhookDeliveries.id });

    const reclaimed = await reclaimStaleDeliveries();
    assert.ok(reclaimed >= 1, "an expired claim must be reclaimed");

    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, delivery.id));
    assert.equal(row.status, "pending");
    assert.equal(row.lockedAt, null);
    assert.equal(row.lockedBy, null);
  });

  it("does not reclaim a claim that is still live", async () => {
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        endpointId,
        eventType: "user_login",
        status: "processing",
        attempts: 1,
        lockedAt: new Date(),
        lockedBy: "live-worker",
      })
      .returning({ id: webhookDeliveries.id });

    await reclaimStaleDeliveries();

    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, delivery.id));
    assert.equal(row.status, "processing", "a live worker must keep its claim");
  });

  it("re-enqueues a pending delivery whose job was lost", async () => {
    await db.insert(webhookDeliveries).values({
      endpointId,
      eventType: "user_login",
      status: "pending",
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const reenqueued = await reenqueuePendingDeliveries();
    assert.ok(reenqueued >= 1, "an old pending delivery must be put back on the queue");
  });

  it("leaves a delivery younger than the grace period alone", async () => {
    const before = await reenqueuePendingDeliveries();

    await db.insert(webhookDeliveries).values({
      endpointId,
      eventType: "user_login",
      status: "pending",
      createdAt: new Date(),
    });

    const after = await reenqueuePendingDeliveries();
    assert.equal(
      after,
      before,
      "a delivery created moments ago may still have a live job; it is not re-enqueued"
    );
  });
});
