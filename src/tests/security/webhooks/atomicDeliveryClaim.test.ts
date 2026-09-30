import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "webhook-claim-test";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// A local collector, so the delivery really performs an HTTP request. The
// outbound policy refuses loopback by design, so this suite opts out — which is
// also what makes the *claim* the thing under test rather than the policy.
process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "true";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { encryptSecret } = await import("../../../services/totp.js");
const { organizations, webhookEndpoints, webhookDeliveries } = await import("../../../db/schema.js");
const { deliverNow, reclaimStaleDeliveries } = await import("../../../services/webhooks.js");

/**
 * SEC-078 — webhook delivery had no atomic claim.
 *
 * `deliverNow` selected the row, sent the request, and wrote the result back,
 * with nothing in between that said "this worker owns it". Two workers holding
 * the same `deliveryId` both sent the payload, and the consumer received the same
 * event twice. Each worker's own write succeeded, so nothing reported it.
 *
 * The claim is a single conditional `UPDATE … WHERE status = 'pending'`, so the
 * database decides the winner. These cases drive real concurrent `deliverNow`
 * calls against a real HTTP collector and count what actually arrived, because a
 * claim that is only asserted structurally is a claim nobody has seen work.
 */
describe("webhook delivery is claimed atomically (SEC-078)", () => {
  let collector: http.Server;
  let collectorUrl: string;
  /** Every delivery id the collector was asked to process, in arrival order. */
  let received: string[] = [];
  const createdOrgIds: string[] = [];
  const createdEndpointIds: string[] = [];

  before(async () => {
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../db/migrations") });
    await loadSigningKeys();

    collector = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(req.headers["x-keystone-delivery"] as string);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const { port } = collector.address() as AddressInfo;
    collectorUrl = `http://127.0.0.1:${port}/hook`;
  });

  after(async () => {
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    for (const id of createdEndpointIds) {
      await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).catch(() => {});
    }
    for (const id of createdOrgIds) {
      await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
    }
    const { closeDb } = await import("../../../db/index.js");
    await closeDb().catch(() => {});
  });

  beforeEach(() => {
    received = [];
  });

  async function seedDelivery(): Promise<string> {
    const suffix = crypto.randomBytes(4).toString("hex");
    const [org] = await db
      .insert(organizations)
      .values({ name: "Claim Org", slug: `claim-${suffix}` })
      .returning();
    createdOrgIds.push(org.id);

    const [endpoint] = await db
      .insert(webhookEndpoints)
      .values({
        url: collectorUrl,
        description: "claim test",
        events: ["user.login"],
        isActive: true,
        secret: encryptSecret(`whsec_${crypto.randomBytes(24).toString("base64url")}`),
      })
      .returning();
    createdEndpointIds.push(endpoint.id);

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({ endpointId: endpoint.id, eventType: "user.login", payload: { type: "user.login" } })
      .returning();
    return delivery.id;
  }

  const rowFor = async (id: string) => {
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    return row;
  };

  it("a single delivery is sent exactly once", async () => {
    const id = await seedDelivery();
    await deliverNow(id);
    assert.equal(received.filter((d) => d === id).length, 1);
    const row = await rowFor(id);
    assert.equal(row?.status, "success");
    // The claim must be dropped on completion, or the row looks live for another
    // lease period and the sweep would eventually re-send a successful delivery.
    assert.equal(row?.lockedAt, null, "a completed delivery must release its claim");
    assert.equal(row?.lockedBy, null);
  });

  it("two concurrent workers send the delivery exactly once", async () => {
    // **The regression.** Before the claim, both of these sent the payload.
    const id = await seedDelivery();
    await Promise.all([deliverNow(id), deliverNow(id)]);
    assert.equal(
      received.filter((d) => d === id).length,
      1,
      "the claim must give exactly one worker the delivery"
    );
  });

  it("ten concurrent workers still send it exactly once", async () => {
    // Ten rather than two, because a two-way race can pass by luck of scheduling
    // and a fan-out makes a non-atomic claim fail reliably.
    const id = await seedDelivery();
    await Promise.all(Array.from({ length: 10 }, () => deliverNow(id)));
    assert.equal(received.filter((d) => d === id).length, 1);
  });

  it("the claim is visible while the delivery is in flight", async () => {
    // The state a crashed worker would strand. Asserted directly rather than by
    // racing: the collector holds the request open, so the row is observably
    // `processing` with an owner.
    const id = await seedDelivery();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      await held;
      return originalFetch(...args);
    }) as typeof fetch;

    const inFlight = deliverNow(id);
    // Let the claim land before inspecting.
    await new Promise((r) => setTimeout(r, 150));
    const row = await rowFor(id);
    assert.equal(row?.status, "processing", "an in-flight delivery must read as processing");
    assert.ok(row?.lockedAt, "the claim must record when it was taken");
    assert.ok(row?.lockedBy, "the claim must record who took it");

    release();
    await inFlight;
    globalThis.fetch = originalFetch;
    assert.equal((await rowFor(id))?.status, "success");
  });

  it("a delivery stranded in processing is reclaimed, not lost", async () => {
    // What a crashed worker leaves behind. Without the sweep the row sits in
    // `processing` forever: not pending, so nothing retries it; not failed, so
    // nothing reports it. The delivery is simply gone.
    const id = await seedDelivery();
    // Simulate the crash: a claim that is old enough to be considered abandoned.
    await db
      .update(webhookDeliveries)
      .set({ status: "processing", lockedAt: new Date(Date.now() - 60 * 60_000), lockedBy: "dead#1" })
      .where(eq(webhookDeliveries.id, id));

    const reclaimed = await reclaimStaleDeliveries();
    assert.ok(reclaimed >= 1, "the sweep must find an abandoned claim");
    const row = await rowFor(id);
    assert.equal(row?.status, "pending", "an abandoned claim returns to pending");
    assert.equal(row?.lockedAt, null);

    // And it is deliverable again.
    await deliverNow(id);
    assert.equal(received.filter((d) => d === id).length, 1);
  });

  it("the sweep leaves a live claim alone", async () => {
    // The failure a too-short lease would cause: reclaiming a healthy worker's
    // delivery and double-sending it — the exact defect the claim exists to
    // prevent, reintroduced by the recovery path.
    const id = await seedDelivery();
    await db
      .update(webhookDeliveries)
      .set({ status: "processing", lockedAt: new Date(), lockedBy: "live#1" })
      .where(eq(webhookDeliveries.id, id));

    await reclaimStaleDeliveries();
    const row = await rowFor(id);
    assert.equal(row?.status, "processing", "a fresh claim must not be stolen");
    assert.equal(row?.lockedBy, "live#1");
  });

  it("a successful delivery is never re-sent by the sweep", async () => {
    // The other half of the claim-release contract: a completed row whose lock was
    // left set would be returned to pending and re-delivered.
    const id = await seedDelivery();
    await deliverNow(id);
    const reclaimed = await reclaimStaleDeliveries();
    const row = await rowFor(id);
    assert.equal(row?.status, "success");
    assert.equal(received.filter((d) => d === id).length, 1, "a success must not be resent");
    void reclaimed;
  });

  it("the claim is a conditional UPDATE, not a read followed by a write", async () => {
    // Structural. The behavioural cases above would pass against an
    // implementation that happened to serialise for other reasons; this is the
    // assertion that the *mechanism* is the one that works across processes.
    const service = readFileSync(
      path.resolve(__dirname, "../../../services/webhooks.js"),
      "utf8"
    );
    const claim = service.slice(service.indexOf("async function claimDelivery"));
    const body = claim.slice(0, claim.indexOf("export async function reclaimStaleDeliveries"));
    assert.match(body, /\.update\(webhookDeliveries\)/, "the claim must be an UPDATE");
    assert.match(body, /eq\(webhookDeliveries\.status, "pending"\)/, "and must be conditional on status");
    assert.doesNotMatch(
      body.slice(body.indexOf("const [claimed]")),
      /^\s*const \[delivery\] = await db\s*\n?\s*\.select\(\)/m,
      "the claim must not read-then-write"
    );
  });
});
