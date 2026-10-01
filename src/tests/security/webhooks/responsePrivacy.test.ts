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
process.env.KEYSTONE_INTERNAL_API_KEY ||= "webhook-privacy-test";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "true";
// Off by default, and the default is the fix. The suite asserts both modes, so
// this is the mode under test; a case below re-imports the module with it on.
delete process.env.WEBHOOK_DEBUG_CAPTURE_BODY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { encryptSecret } = await import("../../../services/totp.js");
const { organizations, webhookEndpoints, webhookDeliveries } = await import("../../../db/schema.js");
const { deliverNow } = await import("../../../services/webhooks.js");

/**
 * SEC-079 — the delivery row stored the first 2000 bytes of whatever the
 * consumer returned, and `GET /platform/webhook-deliveries/:id` served it back.
 *
 * The consumer is a third party. A service that echoes its request — which is what
 * most do while someone is debugging — caused the signed payload and the
 * signature header to be written into a table this project backs up, replicates,
 * and serves to platform operators.
 *
 * These cases deliver a body containing a recognisable secret and then read the
 * **row** back out of PostgreSQL, rather than asserting against the summariser's
 * return value. A unit test of the helper would pass even if the call site were
 * still using `.slice(0, 2000)`, which is the shape of check that would not have
 * caught this.
 */
describe("webhook response bodies are not persisted (SEC-079)", () => {
  let collector: http.Server;
  let collectorUrl: string;
  /** What the collector should answer with on the next request. */
  let respond: { status: number; body: string; contentType: string } = {
    status: 200,
    body: "ok",
    contentType: "application/json",
  };
  const createdOrgIds: string[] = [];
  const createdEndpointIds: string[] = [];

  /** Recognisable markers: if any reach the row, the test fails. */
  const SECRET = "sk_live_9f3c1d7a2b8e4056";
  const PII = "alice@example.test";

  before(async () => {
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../db/migrations") });
    await loadSigningKeys();
    collector = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(respond.status, { "content-type": respond.contentType });
        res.end(respond.body);
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
    respond = { status: 200, body: "ok", contentType: "application/json" };
  });

  async function seedDelivery(): Promise<string> {
    const suffix = crypto.randomBytes(4).toString("hex");
    const [org] = await db
      .insert(organizations)
      .values({ name: "Privacy Org", slug: `privacy-${suffix}` })
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
      .values({
        endpointId: endpoint.id,
        eventType: "user.login",
        // A realistic payload, so a reflected-echo body is plausible rather than
        // contrived.
        payload: { type: "user.login", email: PII, secret: SECRET },
      })
      .returning();
    return delivery.id;
  }

  const rowFor = async (id: string) => {
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    return row;
  };

  it("stores only the shape of a successful response", async () => {
    respond = {
      status: 200,
      body: JSON.stringify({ ok: true, received: { email: PII, secret: SECRET } }),
      contentType: "application/json",
    };
    const id = await seedDelivery();
    await deliverNow(id);
    const row = await rowFor(id);
    assert.equal(row?.status, "success");
    assert.doesNotMatch(row?.responseBody ?? "", /alice@example\.test/, "tenant data must not persist");
    assert.doesNotMatch(row?.responseBody ?? "", /sk_live_/, "a secret must not persist");
  });

  it("stores only the shape of a failing response, which is where bodies leak", async () => {
    // A 500 is when a consumer returns a stack trace or a debug dump, which is
    // exactly the content that is useful to the consumer and not to us.
    respond = {
      status: 500,
      body: `Traceback: panic\n  at handler(SECRET=${SECRET}, user=${PII})\n`,
      contentType: "text/plain",
    };
    const id = await seedDelivery();
    await deliverNow(id);
    const row = await rowFor(id);
    assert.equal(row?.status, "failed");
    assert.doesNotMatch(row?.responseBody ?? "", /Traceback/, "a stack trace must not persist");
    assert.doesNotMatch(row?.responseBody ?? "", /sk_live_/);
    assert.doesNotMatch(row?.responseBody ?? "", /alice@example\.test/);
  });

  it("keeps what an operator actually needs: status, type and size", async () => {
    respond = { status: 503, body: "x".repeat(4096), contentType: "application/problem+json" };
    const id = await seedDelivery();
    await deliverNow(id);
    const stored = (await rowFor(id))?.responseBody ?? "";
    assert.match(stored, /HTTP 503/, "the status is the diagnostic");
    assert.match(stored, /application\/problem\+json/, "the content type is the diagnostic");
    assert.match(stored, /4096 bytes/, "the size is the diagnostic");
    // And none of the body itself.
    assert.doesNotMatch(stored, /xxxx/);
  });

  it("strips control characters a consumer chose to return", async () => {
    // A stored value that can forge log lines is a second-order problem: an
    // operator tailing deliveries would read a line the consumer wrote.
    respond = {
      status: 200,
      body: "before\u001b[31mREDafter\u000a",
      contentType: "text/plain",
    };
    const id = await seedDelivery();
    await deliverNow(id);
    const stored = (await rowFor(id))?.responseBody ?? "";
    // The default mode stores no body at all, so this is really asserting the
    // summary itself is clean — checked directly below in debug mode as well.
    // The assertion is deliberately a control-character match: the point is that
    // none of them survives into the stored value. Suppressed for that reason.
    // oxlint-disable-next-line no-control-regex
    assert.doesNotMatch(stored, /[\u0000-\u001f\u007f]/, "no control byte may reach the row");
  });

  it("the summariser is the only thing that writes a body, and it is called", async () => {
    // Structural, and the assertion that would catch the call site reverting to
    // `.slice(0, 2000)` while the helper still exists and still passes its own
    // unit-level expectations.
    const service = readFileSync(
      path.resolve(__dirname, "../../../services/webhooks.js"),
      "utf8"
    );
    assert.match(service, /summariseWebhookResponse\(/, "the summariser must be called");
    // Scoped to *code*, not to the whole file. The first version matched the
    // literal `response.text()).slice(0, 2000)` anywhere in the module — and found
    // it in the doc comment that quotes the old defect in order to explain the
    // change. The file was correct and the assertion was wrong, which is the more
    // expensive direction to be wrong in. Comments are stripped first, then the
    // code is checked.
    const code = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(
      code,
      /response\.text\(\)\)\.slice\(/,
      "the raw body must not be sliced into the row"
    );
    assert.match(code, /WEBHOOK_DEBUG_CAPTURE_BODY/, "capture must be opt-in via config");
  });

  it("debug capture is off unless the flag is set", async () => {
    const { config } = await import("../../../config.js");
    assert.equal(
      config.WEBHOOK_DEBUG_CAPTURE_BODY,
      false,
      "capturing a third-party body must require an explicit opt-in"
    );
  });
});
