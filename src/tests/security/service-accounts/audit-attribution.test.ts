import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "sa-audit-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys, hashApiKey } = await import("../../../services/tokens.js");
const { apiKeys, auditLog, orgMemberships, organizations, users } = await import(
  "../../../db/schema.js"
);
const { hashPassword } = await import("../../../services/secrets/index.js");
const { auditLogSubscriber } = await import("../../../services/events/subscribers/auditLog.js");
const { migrationsFolder } = await import("../../helpers/paths.js");

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Service-Audit-Passw0rd!";

let app: FastifyInstance;
let ownerId: string;
let serviceAccountId: string;
let apiKeyId: string;
const createdKeyIds: string[] = [];

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();

  const [owner] = await db
    .insert(users)
    .values({
      email: `sa-audit-${RUN_ID}@example.test`,
      username: `saa-${RUN_ID}`,
      name: "Service Audit Owner",
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
      isActive: true,
    })
    .returning();
  ownerId = owner.id;

  const [org] = await db
    .insert(organizations)
    .values({ name: `SA Audit ${RUN_ID}`, slug: `sa-audit-${RUN_ID}` })
    .returning();
  await db.insert(orgMemberships).values({ orgId: org.id, userId: ownerId, role: "owner" });

  // A key is issued against a service-account principal, which is what
  // `auth.ts` turns into the `sa:<uuid>` sentinel.
  serviceAccountId = crypto.randomUUID();
  const plaintext = `sk_test_${crypto.randomBytes(32).toString("base64url")}`;
  const [key] = await db
    .insert(apiKeys)
    .values({
      userId: ownerId,
      keyHash: hashApiKey(plaintext),
      name: "sa-audit-key",
      prefix: "sk_test",
      scopes: ["api_keys:read"],
    })
    .returning();
  apiKeyId = key.id;
  createdKeyIds.push(key.id);
  (globalThis as Record<string, unknown>).__saAuditPlaintext = plaintext;
});

after(async () => {
  await app?.close();
  for (const id of createdKeyIds) await db.delete(apiKeys).where(eq(apiKeys.id, id)).catch(() => {});
  await db.delete(auditLog).where(eq(auditLog.userId, ownerId)).catch(() => {});
  await db.delete(orgMemberships).where(eq(orgMemberships.userId, ownerId)).catch(() => {});
  await db.delete(users).where(eq(users.id, ownerId)).catch(() => {});
  const { closeDb } = await import("../../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

/**
 * The row for a marker, without relying on result order.
 *
 * `select()` without an `ORDER BY` makes "the last row" arbitrary, so a test that
 * asserts on `.at(-1)` is asserting on whatever Postgres happened to return. Each
 * row written here carries a unique marker, so the row can be found instead.
 */
async function rowWithMarker(marker: string) {
  const all = await db.select().from(auditLog);
  const hit = all
    .map((r) => ({ row: r, meta: (r.metadata ?? {}) as Record<string, unknown> }))
    .find(({ meta }) => meta.marker === marker);
  assert.ok(hit, `expected an audit row carrying marker ${marker}`);
  return hit;
}

// ---------------------------------------------------------------------------
// SEC-046 — a service-account request produced no audit record at all
// ---------------------------------------------------------------------------
describe("Service-account requests are audited", () => {
  it("records a human principal against its user id", async () => {
    const before = (await db.select().from(auditLog).where(eq(auditLog.userId, ownerId))).length;

    await auditLogSubscriber({
      type: "user_login",
      version: 1,
      payload: { userId: ownerId, metadata: { marker: `human-${RUN_ID}` } },
    } as never);

    const after = await db.select().from(auditLog).where(eq(auditLog.userId, ownerId));
    assert.equal(after.length, before + 1, "an ordinary principal must be recorded against its user");
    const { row } = await rowWithMarker(`human-${RUN_ID}`);
    assert.equal(row.userId, ownerId);
  });

  it("records a service-account request rather than dropping it", async () => {
    // The sentinel `auth.ts` assigns to a machine principal. It is not a uuid, so
    // writing it into `audit_log.user_id` made Postgres reject the whole insert —
    // the subscriber logged a failure and the audit record was lost, silently,
    // for every request made with an API key or an mTLS service account.
    const before = (await db.select().from(auditLog)).length;

    await auditLogSubscriber({
      type: "api_key_used",
      version: 1,
      payload: {
        userId: `sa:${serviceAccountId}`,
        metadata: { apiKeyId, marker: `machine-${RUN_ID}` },
      },
    } as never);

    const after = await db.select().from(auditLog);
    assert.equal(
      after.length,
      before + 1,
      "the row must exist; before this fix the insert failed and the event was lost"
    );

    const { row, meta } = await rowWithMarker(`machine-${RUN_ID}`);
    assert.equal(row.userId, null, "the sentinel is not a user, so user_id must be null");
    assert.equal(
      meta.serviceAccountId,
      serviceAccountId,
      "the service account must still be identifiable, or the record identifies nothing"
    );
    assert.equal(meta.apiKeyId, apiKeyId, "the original metadata must survive the rewrite");
  });

  it("keeps the event name and version", async () => {
    await auditLogSubscriber({
      type: "rate_limit_triggered",
      version: 1,
      payload: { userId: `sa:${serviceAccountId}`, metadata: { marker: `version-${RUN_ID}` } },
    } as never);

    const { row, meta } = await rowWithMarker(`version-${RUN_ID}`);
    assert.equal(row.event, "rate_limit_triggered:v1");
    assert.equal(meta.eventVersion, 1);
  });

  it("treats an absent principal as null rather than inventing one", async () => {
    const before = (await db.select().from(auditLog)).length;
    await auditLogSubscriber({
      type: "unauthorized_access",
      version: 1,
      payload: { metadata: { marker: `anon-${RUN_ID}` } },
    } as never);
    assert.equal((await db.select().from(auditLog)).length, before + 1);
    const { row, meta } = await rowWithMarker(`anon-${RUN_ID}`);
    assert.equal(row.userId, null);
    assert.equal(meta.serviceAccountId, undefined);
  });

  /**
   * A general guard that a key-authenticated request leaves an audit record.
   *
   * This does **not** exercise the sentinel: `/auth/validate` resolves the key to
   * its owning user, so the principal is a real uuid and the row would be written
   * either way. It is here as a regression guard on the surrounding path, not as
   * proof of SEC-046 — the subscriber tests above are what prove that, and they
   * fail without the fix while this one does not.
   */
  it("a real request made with a key leaves an audit record", async () => {
    const plaintext = (globalThis as Record<string, unknown>).__saAuditPlaintext as string;
    const before = (await db.select().from(auditLog)).length;

    // `/auth/validate` is the route that accepts an API key directly;
    // `app.authenticate` is JWT-only by design.
    const response = await app.inject({
      method: "GET",
      url: "/auth/validate",
      headers: { authorization: `Bearer ${plaintext}` },
    });
    assert.ok(response.statusCode < 500, `the request itself must succeed: ${response.body}`);

    const after = await db.select().from(auditLog);
    assert.ok(
      after.length > before,
      "a request authenticated by an API key must produce an audit record"
    );
  });
});
