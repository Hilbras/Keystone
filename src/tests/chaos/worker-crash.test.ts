import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "chaos-worker-crash";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "true";
process.env.KEYSTONE_ALLOW_INSECURE_WEBHOOK = "localhost";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { users, organizations, applications, orgMemberships, webhookEndpoints, webhookDeliveries } =
  await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");

/**
 * §8.3 — a worker that dies holding a job.
 *
 * A worker is a process, and a process can be killed. The question is what the
 * system looks like afterwards, and there are exactly two answers: the work is
 * stuck forever, or somebody else finishes it. The first is a job that never
 * completes and nobody notices; the second is a job that completes once.
 *
 * "Completes once" is the harder half. The obvious repair — let anybody take
 * an abandoned job — introduces a second failure: if the original worker was
 * only slow, and not dead, then two workers now hold the same job and the
 * side effect happens twice. So the claim has to be exclusive *and* it has to
 * expire, and the expiry has to be long enough that a slow worker is not
 * declared dead while it is still working.
 *
 * The worker here is killed for real, with SIGKILL, while it holds a delivery
 * mid-flight. Nothing gets a chance to clean up: no handler runs, no release
 * is called, no heartbeat is sent. Whatever the system does next, it does
 * because the *state* says the work was abandoned — not because the worker
 * told it.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdAppIds: string[] = [];
const createdEndpointIds: string[] = [];

let app: FastifyInstance;

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const id of createdEndpointIds) {
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.endpointId, id)).catch(() => {});
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).catch(() => {});
  }
  for (const id of createdAppIds) await db.delete(applications).where(eq(applications.id, id)).catch(() => {});
  for (const id of createdOrgIds) await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
  for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id)).catch(() => {});
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

/** A delivery pointed at a collector the test controls. */
async function seedDelivery(url: string): Promise<string> {
  const { encryptSecret } = await import("../../services/totp.js");
  const [org] = await db
    .insert(organizations)
    .values({
      name: `Crash Org ${RUN_ID.slice(0, 4)}`,
      slug: `crash-${RUN_ID}-${crypto.randomBytes(3).toString("hex")}`,
    })
    .returning();
  createdOrgIds.push(org.id);
  const [user] = await db
    .insert(users)
    .values({
      email: `crash-${RUN_ID}-${crypto.randomBytes(3).toString("hex")}@example.test`,
      username: `crash${RUN_ID}${crypto.randomBytes(2).toString("hex")}`.slice(0, 32),
      name: "crash",
      passwordHash: "x",
      emailVerified: true,
    })
    .returning();
  createdUserIds.push(user.id);
  await db.insert(orgMemberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  const [application] = await db
    .insert(applications)
    .values({
      orgId: org.id,
      clientId: `client-${crypto.randomBytes(10).toString("hex")}`,
      clientSecretHash: null,
      clientType: "public",
      allowedScopes: [],
      name: `Crash App ${RUN_ID.slice(0, 4)}`,
      redirectUris: ["https://client.example.test/callback"],
    })
    .returning();
  createdAppIds.push(application.id);

  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      appId: application.id,
      url,
      events: ["user.login"],
      isActive: true,
      secret: encryptSecret(`whsec_${crypto.randomBytes(24).toString("base64url")}`),
    })
    .returning();
  createdEndpointIds.push(endpoint.id);

  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      eventType: "user.login",
      payload: { type: "user.login" },
    })
    .returning();
  return delivery.id;
}

/**
 * A collector that holds every request until the test releases it.
 *
 * The point is that the *worker* must be in flight when it is killed, so the
 * collector cannot answer straight away — and that the retry, which happens
 * after the release, must be answered. A collector that hung only its first
 * request would depend on the child reaching the server before it was killed,
 * and the child is killed as soon as the *claim* appears, which is before the
 * request is even sent. So the release is explicit rather than inferred from
 * the request count.
 *
 * Every request is recorded with the delivery id the sender put on it, so the
 * test can assert that a retry is recognisable as the same delivery.
 */
function startHangingCollector(): Promise<{
  url: string;
  close: () => void;
  release: () => void;
  deliveryIds: string[];
}> {
  const deliveryIds: string[] = [];
  let released = false;
  const server = http.createServer((req, res) => {
    deliveryIds.push(req.headers["x-keystone-delivery"] as string);
    if (!released) return; // Held open: the worker stays in flight.
    res.writeHead(200).end("ok");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        close: () => server.close(),
        release: () => {
          released = true;
        },
        deliveryIds,
      });
    });
  });
}

describe("a worker killed mid-delivery does not strand the job (§8.3)", () => {
  it("leaves the delivery claimed, then recovers it and delivers it once", async () => {
    const collector = await startHangingCollector();
    const deliveryId = await seedDelivery(collector.url);

    try {
      // A child process claims the delivery and is killed while it holds it.
      // SIGKILL, so nothing runs on the way out: no release, no heartbeat, no
      // chance to tidy up. The only evidence the worker existed is the row.
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const { deliverNow } = await import(${JSON.stringify(
            path.join(__dirname, "..", "..", "services", "webhooks.js")
          )});
           await deliverNow(${JSON.stringify(deliveryId)});`,
        ],
        {
          env: { ...process.env },
          cwd: path.join(__dirname, "..", "..", ".."),
        }
      );

      // Wait for the claim to appear in the database.
      const deadline = Date.now() + 30_000;
      let claimed = false;
      while (!claimed && Date.now() < deadline) {
        const [row] = await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, deliveryId));
        claimed = row?.status === "processing" && row?.lockedAt !== null;
        if (!claimed) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(claimed, "the child must claim the delivery before it is killed");

      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));

      // The delivery is still claimed: the worker died holding it.
      const [afterKill] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId));
      assert.equal(afterKill.status, "processing", "the killed worker left the delivery claimed");

      // Now it is reclaimed. The stale threshold is ten minutes, so the
      // timestamp is aged rather than waited out — the same thing that happens
      // when a worker really is dead for ten minutes.
      await db
        .update(webhookDeliveries)
        .set({ lockedAt: new Date(Date.now() - 60 * 60 * 1000) })
        .where(eq(webhookDeliveries.id, deliveryId));

      const { reclaimStaleDeliveries } = await import("../../services/webhooks.js");
      const reclaimed = await reclaimStaleDeliveries();
      assert.ok(reclaimed >= 1, "the sweep must find the abandoned claim");

      const [afterReclaim] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId));
      assert.equal(afterReclaim.status, "pending", "an abandoned claim returns to pending");
      assert.equal(afterReclaim.lockedAt, null, "the stale lock is released");
      assert.equal(afterReclaim.lockedBy, null, "the stale lock is released");

      // And it can be delivered — by somebody else.
      collector.release();
      const { deliverNow } = await import("../../services/webhooks.js");
      await deliverNow(deliveryId);

      const [final] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId));
      assert.equal(final.status, "success", "the recovered delivery must complete");

      // The receiver may have seen one request or two, depending on whether
      // the killed worker got as far as sending it. What must hold either way
      // is that the attempts carry the same delivery id — a consumer
      // deduplicates on it, which is what makes at-least-once delivery safe.
      assert.ok(
        collector.deliveryIds.length >= 1,
        "the receiver must have seen the delivery"
      );
      assert.equal(
        new Set(collector.deliveryIds).size,
        1,
        "every attempt must carry the same delivery id — a consumer deduplicates on it"
      );
    } finally {
      collector.close();
    }
  });

  it("does not steal a claim from a worker that is still working", async () => {
    // The other half of the repair. If an abandoned claim is reclaimed while
    // its worker is still alive, the work runs twice — and for a webhook that
    // means the consumer gets the event twice.
    const collector = await startHangingCollector();
    const deliveryId = await seedDelivery(collector.url);

    try {
      await db
        .update(webhookDeliveries)
        .set({ status: "processing", lockedAt: new Date(), lockedBy: "alive#1" })
        .where(eq(webhookDeliveries.id, deliveryId));

      const { reclaimStaleDeliveries } = await import("../../services/webhooks.js");
      await reclaimStaleDeliveries();

      const [row] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId));
      assert.equal(
        row.status,
        "processing",
        "a live claim must not be reclaimed — the worker holding it is still working"
      );
      assert.equal(row.lockedBy, "alive#1", "the claim still belongs to the worker that took it");
    } finally {
      collector.close();
    }
  });
});

describe("a queued job whose worker never ran is recovered (§8.3)", () => {
  it("re-enqueues a delivery that was queued and never picked up", async () => {
    // The other kind of loss: the job was accepted, the queue entry was
    // written, and the worker died before it got there. The delivery row is
    // still `pending` and nobody is going to deliver it.
    const { reenqueuePendingDeliveries } = await import("../../services/webhooks.js");
    const collector = await startHangingCollector();
    const deliveryId = await seedDelivery(collector.url);

    try {
      // The row is older than the re-enqueue window, which is what a job that
      // sat in a queue nobody drained looks like.
      await db
        .update(webhookDeliveries)
        .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
        .where(eq(webhookDeliveries.id, deliveryId));

      const requeued = await reenqueuePendingDeliveries();
      assert.ok(requeued >= 1, "a delivery nobody picked up must be re-enqueued");
    } finally {
      collector.close();
    }
  });
});
