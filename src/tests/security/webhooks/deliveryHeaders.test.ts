import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "webhook-headers-test";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "true";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { encryptSecret } = await import("../../../services/totp.js");
const { organizations, webhookEndpoints, webhookDeliveries } = await import("../../../db/schema.js");
const { deliverNow, eventIdOf } = await import("../../../services/webhooks.js");

/**
 * SEC-083 — a webhook consumer had no header it could deduplicate on.
 *
 * The identifiers needed existed, or could be derived, but none was reachable
 * without parsing the body: the event id was sent *inside* the JSON, the delivery
 * id was sent as `X-Keystone-Delivery`, and the attempt number was not sent at all.
 *
 * The consequence is not that a consumer *cannot* dedupe — it can read `id` out of
 * the payload. It is that dedup requires understanding Keystone's payload shape, so
 * a consumer that routes on headers, or that discards the body before storing
 * anything, has no key at all. And a consumer wanting to distinguish "attempt 1"
 * from "attempt 3" has nothing to compare.
 *
 * These cases read the headers off a **real HTTP delivery**, because the claim is
 * about what a consumer receives.
 */
describe("webhook deliveries carry deduplication headers (SEC-083)", () => {
  let collector: http.Server;
  let collectorUrl: string;
  let received: http.IncomingHttpHeaders[];
  const createdOrgIds: string[] = [];
  const createdEndpointIds: string[] = [];

  before(async () => {
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../db/migrations") });
    await loadSigningKeys();
    collector = http.createServer((req, res) => {
      received.push(req.headers);
      req.resume();
      req.on("end", () => {
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

  async function seedDelivery(payload: unknown): Promise<string> {
    const suffix = crypto.randomBytes(4).toString("hex");
    const [org] = await db
      .insert(organizations)
      .values({ name: "Header Org", slug: `hdr-${suffix}` })
      .returning();
    createdOrgIds.push(org.id);
    const [endpoint] = await db
      .insert(webhookEndpoints)
      .values({
        url: collectorUrl,
        events: ["user.login"],
        isActive: true,
        secret: encryptSecret(`whsec_${crypto.randomBytes(24).toString("base64url")}`),
      })
      .returning();
    createdEndpointIds.push(endpoint.id);
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({ endpointId: endpoint.id, eventType: "user.login", payload })
      .returning();
    return delivery.id;
  }

  it("sends an event id, a delivery id and an attempt number", async () => {
    const eventId = crypto.randomUUID();
    await deliverNow(await seedDelivery({ id: eventId, type: "user.login", payload: {} }));

    assert.equal(received.length, 1);
    const h = received[0]!;
    assert.equal(h["x-keystone-event-id"], eventId, "the event id must be the body's id");
    assert.ok(h["x-keystone-delivery"], "the delivery id was already sent");
    assert.equal(h["x-keystone-attempt"], "1", "the first attempt is 1");
  });

  it("the attempt number tracks the attempt, not the delivery", async () => {
    // Two deliveries, both first attempts: both must be 1. A counter that grew per
    // delivery would make the header useless for identifying a retry.
    await deliverNow(await seedDelivery({ id: crypto.randomUUID(), payload: {} }));
    await deliverNow(await seedDelivery({ id: crypto.randomUUID(), payload: {} }));
    assert.deepEqual(received.map((h) => h["x-keystone-attempt"]), ["1", "1"]);
  });

  it("a row without a payload id still gets an event id", async () => {
    // `payload` is plain jsonb, so a row written before 3.8.0 may have no `id`. The
    // header must still be present: a consumer written to dedupe on this treats an
    // absent header as "my parsing failed" and skips the dedup entirely.
    await deliverNow(await seedDelivery({ type: "user.login" }));
    const h = received[0]!;
    assert.ok(
      h["x-keystone-event-id"],
      "an absent event id is worse than an approximate one"
    );
    assert.equal(
      h["x-keystone-event-id"],
      h["x-keystone-delivery"],
      "and it falls back to the delivery id"
    );
  });

  it("a non-object payload still gets an event id", async () => {
    /**
     * Exercised against `eventIdOf` directly rather than through a delivery.
     *
     * The first version tried to insert each shape as a delivery row, and
     * **Postgres rejected it** — `payload` is a `jsonb` column and Drizzle cannot
     * bind a scalar or a string to one through this path. So a whole layer of the
     * claim was untestable that way, and the right move is to test the reader
     * directly: what is under test is that `eventIdOf` returns a usable string for
     * any payload shape, and a queue worker crashing on a malformed row is exactly
     * what that guards against.
     */
    for (const payload of [null, undefined, "a string", 42, true, [], { id: 123 }, { id: "" }]) {
      const id = crypto.randomUUID();
      assert.equal(
        eventIdOf({ id, payload }),
        id,
        `payload ${JSON.stringify(payload)} must fall back to the delivery id, not throw`
      );
    }
    // And the shapes that do carry an id are honoured rather than overridden.
    const real = crypto.randomUUID();
    assert.equal(eventIdOf({ id: "delivery-1", payload: { id: real } }), real);
  });

  it("the existing headers are unchanged", async () => {
    const eventId = crypto.randomUUID();
    await deliverNow(await seedDelivery({ id: eventId, type: "user.login", payload: {} }));
    const h = received[0]!;
    assert.equal(h["x-keystone-event"], "user.login", "the event type header must not change");
    assert.match(String(h["x-keystone-signature"]), /^t=\d+,v1=[0-9a-f]{64}$/);
  });
});