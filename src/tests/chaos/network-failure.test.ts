import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "chaos-network";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// The private-address policy refuses a loopback target unless it is
// explicitly allowed, and the insecure-transport exception is scoped to
// localhost. Both are read when the configuration is first loaded, so they
// have to be set here rather than in the setup hook.
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
const { hashPassword } = await import("../../services/secrets/index.js");
const { users, organizations, applications, orgMemberships, webhookEndpoints, webhookDeliveries } =
  await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");

/**
 * §8.5 — the network between Keystone and the world it calls.
 *
 * The outbound path is the webhook delivery, and it is the only place the
 * server reaches a host it does not control. The failures that matter are the
 * ones a real network produces, and each of them looks different to the code:
 *
 * - **DNS failure** — the name does not resolve. `ENOTFOUND`.
 * - **Connection refused** — the host is there and says no. `ECONNREFUSED`.
 * - **TLS failure** — the handshake does not complete.
 * - **Connection reset** — the peer disappears mid-flight. `ECONNRESET`.
 * - **Timeout** — the peer accepts and says nothing.
 * - **Slow response** — the peer answers, eventually.
 *
 * The property under test is the same for all six: the delivery is *not*
 * delivered, it is recorded as failed, and it is eligible for a retry. A
 * network failure that is recorded as a success is the worst outcome there is
 * — the sender believes the consumer has the event, and the consumer does not.
 *
 * The faults are injected by replacing the global `fetch`, which is the only
 * seam the delivery path has. Everything downstream of it — the classification,
 * the state machine, the retry, the persisted diagnostics — is the production
 * code.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdAppIds: string[] = [];
const createdEndpointIds: string[] = [];

let app: FastifyInstance;
let collector: http.Server;
let collectorUrl: string;
let originalFetch: typeof globalThis.fetch;

async function makeUser(label: string) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${RUN_ID}@example.test`,
      username: `${label}${RUN_ID}`.slice(0, 32),
      name: label,
      passwordHash: await hashPassword("Chaos-Network-Passw0rd!"),
      emailVerified: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

/** A delivery queued against a real local collector. */
async function queueDelivery(label: string): Promise<string> {
  const { encryptSecret } = await import("../../services/totp.js");
  const [org] = await db
    .insert(organizations)
    .values({ name: `Net Org ${label}`, slug: `net-${label}-${RUN_ID}` })
    .returning();
  createdOrgIds.push(org.id);
  const user = await makeUser(`net-${label}`);
  await db.insert(orgMemberships).values({ orgId: org.id, userId: user.id, role: "owner" });
  const [application] = await db
    .insert(applications)
    .values({
      orgId: org.id,
      clientId: `client-${crypto.randomBytes(10).toString("hex")}`,
      clientSecretHash: null,
      clientType: "public",
      allowedScopes: [],
      name: `Net App ${label}`,
      redirectUris: ["https://client.example.test/callback"],
    })
    .returning();
  createdAppIds.push(application.id);

  // The endpoint and the delivery are written directly, the way the other
  // webhook suites write them. Going through `createEndpoint` would exercise
  // the URL policy, and going through `dispatchEvent` would exercise the
  // endpoint's event filter — neither of which is what this suite is about,
  // and both of which would make a failure ambiguous.
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      appId: application.id,
      url: `${collectorUrl}/hook-${label}`,
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

/** Replace the global fetch with one that fails in a specific way. */
function withFailingFetch<T>(failure: (url: string) => Error | null, run: () => Promise<T>): Promise<T> {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const error = failure(String(input));
    if (error) throw error;
    return originalFetch(input as never);
  }) as typeof globalThis.fetch;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

/** A fetch that never answers, so the delivery's own timeout has to end it. */
function withHangingFetch<T>(run: () => Promise<T>): Promise<T> {
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), {
        once: true,
      });
    })) as typeof globalThis.fetch;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();

  collector = http.createServer((_req, res) => {
    res.writeHead(200).end("ok");
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  collectorUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

  // The private-address policy refuses a loopback target unless it is
  // explicitly allowed, and the exception is scoped to localhost.
  process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "true";
  process.env.KEYSTONE_ALLOW_INSECURE_WEBHOOK = "localhost";
});

after(async () => {
  globalThis.fetch = originalFetch;
  await app?.close();
  collector?.close();
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

describe("a network failure is never a delivered event (§8.5)", () => {
  const faults: Array<{ name: string; error: () => Error }> = [
    { name: "a DNS failure", error: () => Object.assign(new Error("getaddrinfo ENOTFOUND hook.example.test"), { code: "ENOTFOUND" }) },
    { name: "a refused connection", error: () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) },
    { name: "a TLS handshake failure", error: () => Object.assign(new Error("TLS handshake failed"), { code: "EPROTO" }) },
    { name: "a connection reset", error: () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) },
  ];

  for (const fault of faults) {
    it(`records ${fault.name} as a failure, not a delivery`, async () => {
      const deliveryId = await queueDelivery(fault.name.replace(/\W+/g, "-").slice(0, 12));
      const { deliverNow } = await import("../../services/webhooks.js");

      await withFailingFetch(() => fault.error(), () => deliverNow(deliveryId));

      const [row] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId));
      assert.notEqual(
        row.status,
        "success",
        `${fault.name} must not be recorded as a delivery — the consumer never got the event`
      );
      assert.ok(
        row.status === "pending" || row.status === "failed",
        `the delivery must be pending or failed after ${fault.name}; it was ${row.status}`
      );
    });
  }

  it("gives up on a target that never answers, rather than waiting forever", async () => {
    const deliveryId = await queueDelivery("hang");
    const { deliverNow } = await import("../../services/webhooks.js");

    const startedAt = Date.now();
    await withHangingFetch(() => deliverNow(deliveryId));
    const elapsed = Date.now() - startedAt;

    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    assert.notEqual(row.status, "success", "a target that never answers has not received the event");
    assert.ok(
      elapsed < 60_000,
      `the delivery must be bounded by its own timeout; it took ${elapsed}ms`
    );
  });

  it("keeps the failed delivery eligible for a retry", async () => {
    // A network failure is transient by nature, so the delivery must go back
    // to `pending` rather than straight to `failed`: a permanent state would
    // mean the event is never delivered, and the consumer never learns.
    const deliveryId = await queueDelivery("retry");
    const { deliverNow } = await import("../../services/webhooks.js");

    await withFailingFetch(
      () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
      () => deliverNow(deliveryId)
    );

    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    assert.equal(
      row.status,
      "pending",
      "a failed attempt must leave the delivery pending, so it can be retried"
    );
    assert.equal(row.lockedAt, null, "the claim must be released, or the retry can never take it");
    assert.equal(row.lockedBy, null, "the claim must be released, or the retry can never take it");
  });
});
