import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "chokepoint-span-test";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

// The webhook span case below delivers to a collector this file starts on
// `127.0.0.1`, because asserting "a span exists for a webhook delivery" needs a
// real HTTP exchange. The outbound URL policy refuses loopback destinations
// precisely because a tenant-supplied webhook must not be able to reach one —
// which is correct, and is why this suite has to opt out explicitly rather than
// discover the refusal as an unexplained throw from `createEndpoint`.
//
// Set before any import of the server, because `config` reads the environment
// once at module load.
process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "true";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

void path;
void fileURLToPath;
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { hashPassword } = await import("../../services/secrets/index.js");
const { ATTR, SPAN } = await import("../../services/spans.js");
const { migrationsFolder } = await import("../helpers/paths.js");
const { startTracing, stopTracing } = await import("../../plugins/tracing.js");
const {
  users,
  organizations,
  orgMemberships,
  scimConnections,
  scimGroups,
  scimGroupMembers,
  webhookEndpoints,
  webhookDeliveries,
} = await import("../../db/schema.js");

/**
 * The chokepoint spans must be *created*, not merely present in the source.
 *
 * The v3.0.1 analysis found this codebase carried OpenTelemetry as a production
 * dependency, wired it into the bootstrap, and instrumented nothing — zero
 * custom spans. Every trace was HTTP-and-database auto-instrumentation, which
 * cannot distinguish a correct argon2id cost from a database query in a loop, and
 * cannot tell a replayed refresh token from an ordinary one.
 *
 * A test asserting the source contains `startSpan` would have passed on that
 * codebase, because the bootstrap contained the SDK. So each span below is
 * produced by driving the real route or service and reading what the collector
 * actually received. Delete a span from a call site and these fail.
 */
let exporter: {
  getFinishedSpans: () => { name: string; attributes: Record<string, unknown> }[];
  reset: () => void;
};

let app: FastifyInstance;
let collector: http.Server;
let collectorUrl: string;
const PASSWORD = "Chokepoint-Span-Passw0rd!";
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

function spansNamed(name: string): { attributes: Record<string, unknown> }[] {
  return exporter
    .getFinishedSpans()
    .filter((s) => s.name === name)
    .map((s) => ({ attributes: s.attributes }));
}

function allSpanNames(): string[] {
  return exporter.getFinishedSpans().map((s) => s.name);
}

async function makeUser(label: string) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const email = `${label}-${suffix}@example.test`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      username: `${label}${suffix}`.slice(0, 60),
      name: label,
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
      isActive: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();

  // Start the SDK with a synchronous processor *before* the app builds, so the
  // tracer the application holds is the one under test. A BatchSpanProcessor
  // would defer export to a timer and the assertions would run against nothing.
  const { InMemorySpanExporter, SimpleSpanProcessor } = await import(
    "@opentelemetry/sdk-trace-base"
  );
  const mem = new InMemorySpanExporter();
  startTracing({ spanProcessors: [new SimpleSpanProcessor(mem)], autoInstrument: false });
  exporter = mem as never;

  // A real consumer, so the webhook span records a real status code from a real
  // exchange rather than a stubbed fetch.
  collector = http.createServer((req, res) => {
    if (req.url === "/reject") {
      res.writeHead(503).end("nope");
      return;
    }
    res.writeHead(200).end("ok");
  });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  const addr = collector.address();
  if (addr === null || typeof addr === "string") throw new Error("collector has no port");
  collectorUrl = `http://127.0.0.1:${addr.port}`;

  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  await stopTracing().catch(() => {});
  await new Promise<void>((r) => collector.close(() => r()));

  for (const userId of createdUserIds) {
    await db.delete(scimGroupMembers).where(eq(scimGroupMembers.userId, userId)).catch(() => {});
    await db.delete(orgMemberships).where(eq(orgMemberships.userId, userId)).catch(() => {});
    await db.delete(users).where(eq(users.id, userId)).catch(() => {});
  }
  for (const orgId of createdOrgIds) {
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, orgId)).catch(() => {});
    await db.delete(scimConnections).where(eq(scimConnections.orgId, orgId)).catch(() => {});
    await db.delete(scimGroups).where(eq(scimGroups.orgId, orgId)).catch(() => {});
    await db.delete(orgMemberships).where(eq(orgMemberships.orgId, orgId)).catch(() => {});
    await db.delete(organizations).where(eq(organizations.id, orgId)).catch(() => {});
  }
  const { closeDb } = await import("../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("Chokepoint spans", () => {
  it("keystone.token.issue: a login mints tokens through the single chokepoint", async () => {
    exporter.reset();
    const user = await makeUser("issue");

    const response = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: PASSWORD },
    });
    assert.equal(response.statusCode, 200, response.body);

    const spans = spansNamed(SPAN.tokenIssuance);
    assert.ok(
      spans.length > 0,
      `expected a ${SPAN.tokenIssuance} span; got [${allSpanNames().join(", ")}]`
    );
    assert.equal(spans[0].attributes[ATTR.outcome], "issued");
    assert.equal(spans[0].attributes[ATTR.flow], "password");
    assert.equal(spans[0].attributes[ATTR.mfaEnabled], false);
    assert.equal(spans[0].attributes[ATTR.mfaSatisfied], false);
    assert.equal(spans[0].attributes[ATTR.mfaFactor], "none");
  });

  it("keystone.token.rotate: records the rotation and the refusal", async () => {
    exporter.reset();
    const user = await makeUser("rotate");

    const login = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);
    const token = login.json().refreshToken as string;
    const { refreshCookieName } = await import("../../plugins/auth.js");
    const cookie = `${refreshCookieName()}=${token}`;

    exporter.reset();
    const first = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie },
    });
    assert.equal(first.statusCode, 200, first.body);

    // Replaying the same token is the attack this span has to make visible.
    await app.inject({ method: "POST", url: "/auth/refresh", headers: { cookie } });

    const spans = spansNamed(SPAN.tokenRotation);
    assert.ok(spans.length > 0, `expected a ${SPAN.tokenRotation} span; got [${allSpanNames().join(", ")}]`);
    assert.ok(
      spans.some((s) => s.attributes[ATTR.rotated] === true),
      "a successful rotation must be recorded"
    );
    assert.ok(
      spans.some((s) => s.attributes[ATTR.rotated] === false),
      "a refused rotation must be recorded, or a replay spike is invisible"
    );

    // The rotation issues through the same chokepoint as a login, and has to say
    // so. A span whose flow attribute is always "unknown" cannot answer "is the
    // login page slow, or the token refresh on every page load?".
    const issued = spansNamed(SPAN.tokenIssuance);
    assert.ok(issued.length > 0, "a rotation should also cross the issuance chokepoint");
    assert.equal(
      issued[0].attributes[ATTR.flow],
      "refresh",
      "a rotated token must be attributed to the refresh flow"
    );
  });

  it("keystone.scim.group.reconcile: the route emits it with the membership counts", async () => {
    exporter.reset();
    const { ScimConnectionService } = await import("../../services/scimCredentials.js");
    const scimCredentials = new ScimConnectionService(app.container.scimConnectionRepository);

    const owner = await makeUser("scimowner");
    const member = await makeUser("scimmember");
    const [org] = await db
      .insert(organizations)
      .values({ name: "Span SCIM", slug: `span-scim-${crypto.randomBytes(4).toString("hex")}` })
      .returning();
    createdOrgIds.push(org.id);
    await db
      .insert(orgMemberships)
      .values([
        { orgId: org.id, userId: owner.id, role: "owner" },
        { orgId: org.id, userId: member.id, role: "member" },
      ]);

    const created = await scimCredentials.create({ orgId: org.id, name: "span scim" });
    assert.equal(created.success, true, "SCIM credential should be created");
    if (!created.success) throw new Error("unreachable");
    const auth = { authorization: `Bearer ${created.data.token}` };

    const [group] = await db
      .insert(scimGroups)
      .values({ orgId: org.id, displayName: "span group", externalId: crypto.randomUUID() })
      .returning();

    exporter.reset();
    const put = await app.inject({
      method: "PUT",
      url: `/scim/v2/Groups/${group.id}`,
      headers: auth,
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "span group",
        members: [{ value: member.id }],
      },
    });
    assert.equal(put.statusCode, 200, put.body);

    const spans = spansNamed(SPAN.scimGroupReconcile);
    assert.ok(
      spans.length > 0,
      `expected a ${SPAN.scimGroupReconcile} span; got [${allSpanNames().join(", ")}]`
    );
    assert.equal(spans[0].attributes[ATTR.submitted], 1);
    assert.equal(spans[0].attributes[ATTR.added], 1);
    assert.equal(spans[0].attributes[ATTR.removed], 0);
    assert.equal(spans[0].attributes[ATTR.groupId], group.id);

    // Removing the member must be counted, or a partial reconcile looks clean.
    exporter.reset();
    const second = await app.inject({
      method: "PUT",
      url: `/scim/v2/Groups/${group.id}`,
      headers: auth,
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "span group",
        members: [],
      },
    });
    assert.equal(second.statusCode, 200, second.body);
    const removal = spansNamed(SPAN.scimGroupReconcile);
    assert.equal(removal[0].attributes[ATTR.removed], 1, "a removal must be counted");
  });

  it("keystone.webhook.deliver: records the attempt and the status, on success and failure", async () => {
    const { createEndpoint, deliverNow } = await import("../../services/webhooks.js");

    // Created through the service, so the secret is encrypted the way production
    // encrypts it. `dispatchEvent` fans out to every active endpoint, which on a
    // shared database is not a deterministic thing to assert against, so the
    // delivery row is written directly and the delivery path is driven for real.
    const okEndpoint = await createEndpoint({ url: `${collectorUrl}/ok`, events: ["user.login"] });
    const badEndpoint = await createEndpoint({ url: `${collectorUrl}/reject`, events: ["user.login"] });

    const [okDelivery] = await db
      .insert(webhookDeliveries)
      .values({ endpointId: okEndpoint.id, eventType: "user.login", payload: { ok: true } })
      .returning();
    const [badDelivery] = await db
      .insert(webhookDeliveries)
      .values({ endpointId: badEndpoint.id, eventType: "user.login", payload: { ok: false } })
      .returning();

    exporter.reset();
    await deliverNow(okDelivery.id);
    const okSpans = spansNamed(SPAN.webhookDelivery);
    assert.ok(
      okSpans.length > 0,
      `expected a ${SPAN.webhookDelivery} span; got [${allSpanNames().join(", ")}]`
    );
    assert.equal(okSpans[0].attributes[ATTR.endpointId], okEndpoint.id);
    assert.equal(okSpans[0].attributes[ATTR.attempt], 1);
    assert.equal(okSpans[0].attributes[ATTR.statusCode], 200);
    assert.equal(okSpans[0].attributes[ATTR.outcome], "delivered");

    exporter.reset();
    await deliverNow(badDelivery.id);
    const badSpans = spansNamed(SPAN.webhookDelivery);
    assert.equal(badSpans.length, 1, "a rejected delivery must still be recorded");
    assert.equal(badSpans[0].attributes[ATTR.statusCode], 503);
    assert.equal(badSpans[0].attributes[ATTR.outcome], "rejected");

    // The delivery is real: the collector actually received the signed payload.
    const recorded = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, okDelivery.id));
    assert.equal(recorded[0].status, "success");
    assert.equal(recorded[0].responseStatus, 200);

    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, okDelivery.id));
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, badDelivery.id));
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, okEndpoint.id));
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, badEndpoint.id));
  });

  it("names every span the plan requires, under the keystone namespace", () => {
    // Guards against a rename that leaves dashboards and alerts matching nothing,
    // and against a new chokepoint being added without a name to query.
    const required = [
      SPAN.tokenIssuance,
      SPAN.tokenRotation,
      SPAN.scimGroupReconcile,
      SPAN.webhookDelivery,
    ];
    assert.equal(new Set(required).size, required.length, "span names must be unique");
    for (const name of required) {
      assert.match(name, /^keystone\.[a-z.]+$/, `${name} must be a namespaced lowercase span name`);
    }
  });
});
