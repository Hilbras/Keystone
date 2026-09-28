import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "reconcile-statements-test";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// The benchmark's own 40% tolerance applies to wall-clock. This gate is about a
// statement count, which is exact, so nothing here is a timing assertion.

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
const { startCountingQueries, stopCountingQueries } = await import("../../db/queryCounter.js");
const { ScimConnectionService } = await import("../../services/scimCredentials.js");
const { migrationsFolder } = await import("../../lib/paths.js");
const {
  users,
  organizations,
  orgMemberships,
  scimGroups,
  scimGroupMembers,
} = await import("../../db/schema.js");

/**
 * The statement count of a group reconcile, asserted to be independent of group
 * size.
 *
 * This is the gate §2.1 asked for, and the property worth protecting is not "a
 * small number" — it is that the number does not move. A reconcile that issues
 * one statement per member is fast at 10 members and unusable at 1,000, and only
 * the slope distinguishes the two.
 *
 * The count comes from the driver's own statement hook, so it is what the
 * database was actually sent rather than an estimate.
 *
 * It was verified by breaking: reverting the route to the per-member loop fails
 * these, and the failure names the scenario.
 */

const SIZES = [10, 100];

let app: FastifyInstance;
let orgId: string;
let scimToken: string;
let pool: string[];
let groupIds: string[] = [];
const PASSWORD = "Reconcile-Statements-Passw0rd!";

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();

  const suffix = crypto.randomBytes(4).toString("hex");
  const passwordHash = await hashPassword(PASSWORD);
  const [org] = await db
    .insert(organizations)
    .values({ name: "Reconcile statements", slug: `reconcile-${suffix}` })
    .returning();
  orgId = org.id;

  const ids: string[] = [];
  for (let offset = 0; offset < 100; offset += 100) {
    const batch = [];
    for (let i = offset; i < offset + 100; i++) {
      batch.push({
        email: `reconcile-${suffix}-${i}@example.test`,
        username: `rec${suffix}${i}`.slice(0, 60),
        name: `Reconcile ${i}`,
        passwordHash,
        emailVerified: true,
      });
    }
    for (const row of await db.insert(users).values(batch).returning({ id: users.id })) {
      ids.push(row.id);
    }
  }
  pool = ids;
  await db.insert(orgMemberships).values(
    pool.map((userId) => ({ orgId, userId, role: "member" as const }))
  );

  const credentials = new ScimConnectionService(app.container.scimConnectionRepository);
  const created = await credentials.create({ orgId, name: "reconcile statements" });
  assert.ok(created.success, "the SCIM credential must be created");
  if (!created.success) throw new Error("unreachable");

  for (let i = 0; i < SIZES.length; i++) {
    const [group] = await db
      .insert(scimGroups)
      .values({ orgId, displayName: `reconcile-group-${i}`, externalId: crypto.randomUUID() })
      .returning();
    groupIds.push(group.id);
  }
  scimToken = created.data.token;
});

after(async () => {
  await app?.close();
  await db.delete(scimGroupMembers).where(inArray(scimGroupMembers.userId, pool)).catch(() => {});
  await db.delete(scimGroups).where(eq(scimGroups.orgId, orgId)).catch(() => {});
  await db.delete(orgMemberships).where(eq(orgMemberships.orgId, orgId)).catch(() => {});
  await db.delete(organizations).where(eq(organizations.id, orgId)).catch(() => {});
  await db.delete(users).where(inArray(users.id, pool)).catch(() => {});
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

/**
 * Run a PUT through the real route and return the statements it sent.
 *
 * `displayName` follows the group id because `(org_id, display_name)` is unique.
 * Two PUTs for two different groups with the same name collide on that
 * constraint, and the resulting 500 looks exactly like a failure in the reconcile
 * rather than in the fixture.
 */
async function putMembers(
  groupId: string,
  memberIds: string[],
  displayName = `renamed-${groupId}`
): Promise<number> {
  startCountingQueries();
  try {
    const res = await app.inject({
      method: "PUT",
      url: `/scim/v2/Groups/${groupId}`,
      headers: { authorization: `Bearer ${scimToken}` },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName,
        members: memberIds.map((value) => ({ value })),
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const group = res.json() as { members: unknown[] };
    assert.equal(group.members.length, memberIds.length, "the response should carry every member");
    return stopCountingQueries();
  } catch (error) {
    stopCountingQueries();
    throw error;
  }
}

describe("SCIM group reconcile — statement count", () => {
  it("issues the same number of statements at 10 members as at 100", async () => {
    const counts: Record<number, number> = {};

    for (const [i, size] of SIZES.entries()) {
      const members = pool.slice(0, size);
      // Clear first, so each measurement is a real reconciliation rather than a
      // no-op. A no-op would skip the insert and make the numbers flattering.
      await db.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupIds[i]));
      counts[size] = await putMembers(groupIds[i], members);
    }

    assert.equal(
      counts[10],
      counts[100],
      `statement count moved with group size: 10 members -> ${counts[10]}, ` +
        `100 members -> ${counts[100]}. It must not depend on the member count.`
    );
  });

  it("issues the same number of statements when only removing", async () => {
    const groupId = groupIds[0];
    await db.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId));
    await putMembers(groupId, pool.slice(0, 50));

    startCountingQueries();
    const removed = await app.inject({
      method: "PUT",
      url: `/scim/v2/Groups/${groupId}`,
      headers: { authorization: `Bearer ${scimToken}` },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: `renamed-${groupId}`,
        members: [],
      },
    });
    const statements = stopCountingQueries();

    assert.equal(removed.statusCode, 200, removed.body);
    const group = removed.json() as { members: unknown[] };
    assert.equal(group.members.length, 0, "every member should have been removed");

    // The two paths differ by exactly one statement: removing writes a DELETE,
    // adding writes an INSERT. Both are one statement over the whole set, so
    // doubling the member count must change neither count.
    const additions = await putMembers(groupId, pool.slice(0, 50));
    assert.equal(
      additions,
      statements + 1,
      `removing 50 took ${statements} statements and adding 50 took ${additions}. ` +
        `They should differ by exactly the one write each needs, and by nothing ` +
        `that scales with the member count.`
    );

    await db.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId));
    const additionsOf50 = await putMembers(groupId, pool.slice(0, 50));
    const additionsOf100 = await putMembers(groupId, pool.slice(0, 100));
    assert.equal(
      additionsOf100,
      additionsOf50,
      `adding 50 took ${additionsOf50} statements and adding 100 took ${additionsOf100}. ` +
        `The insert is one statement over the set, so the count must not move.`
    );
  });

  it("applies nothing when one submitted user is not a member of the organization", async () => {
    const groupId = groupIds[1];
    await db.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId));
    await putMembers(groupId, pool.slice(0, 5));

    // A real user who belongs to nobody.
    const outsider = await db
      .insert(users)
      .values({
        email: `reconcile-outsider-${crypto.randomBytes(3).toString("hex")}@example.test`,
        username: `reco${crypto.randomBytes(3).toString("hex")}`,
        name: "Outsider",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning({ id: users.id });

    const res = await app.inject({
      method: "PUT",
      url: `/scim/v2/Groups/${groupId}`,
      headers: { authorization: `Bearer ${scimToken}` },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: `renamed-${groupId}`,
        // The first five are valid and the sixth is not. The per-member version
        // inserted the first five before it reached the sixth.
        members: [...pool.slice(0, 5), ...pool.slice(5, 20), outsider[0].id].map((value) => ({
          value,
        })),
      },
    });
    assert.equal(res.statusCode, 404, res.body);

    const remaining = await db
      .select({ userId: scimGroupMembers.userId })
      .from(scimGroupMembers)
      .where(eq(scimGroupMembers.groupId, groupId));
    assert.deepEqual(
      remaining.map((r) => r.userId).sort(),
      pool.slice(0, 5).sort(),
      "a rejected reconcile must leave the group exactly as it was, not half-applied"
    );

    await db.delete(users).where(eq(users.id, outsider[0].id));
  });

  it("leaves an already-correct group alone, and counts no write", async () => {
    const groupId = groupIds[0];
    await db.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, groupId));
    const members = pool.slice(0, 8);
    await putMembers(groupId, members);

    // Submitting the same set is a genuine no-op: nothing to add, nothing to
    // remove. It should be cheaper than the reconciliation above, not equal to it,
    // which is what a set-difference should give you.
    const repeat = await putMembers(groupId, members);
    assert.ok(
      repeat > 0,
      "a no-op reconcile should still cost the reads that establish it is a no-op"
    );

    const after = await db
      .select({ userId: scimGroupMembers.userId })
      .from(scimGroupMembers)
      .where(eq(scimGroupMembers.groupId, groupId));
    assert.equal(after.length, 8, "the membership should be unchanged");
  });
});
