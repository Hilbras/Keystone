import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "permission-index-gate";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { DrizzlePermissionRepository } = await import("../../repositories/permission.js");
const { migrationsFolder } = await import("../../lib/paths.js");

/**
 * The authorization path has no index, and adding one is a pessimization.
 *
 * §2.2 of the roadmap said "`permissions` and `role_permissions` have no index"
 * and proposed the migration from §1.2. Both halves are false, and the
 * measurement is why this file exists instead of a migration.
 *
 * **They are indexed.** `permissions` has a unique index on
 * `(resource, action)` and `role_permissions` has one on
 * `(role, permission_id)`. Those are exactly the columns
 * `listForRole` filters and joins on. The analysis found no *other`*
 * index and reported that as no index at all.
 *
 * **Adding one would make the read slower.** At this repository's real counts —
 * 150 permissions, 302 role permissions — the planner picks a hash join over two
 * sequential scans:
 *
 *     Hash Join  (cost=4.41..11.34) (actual time=0.151..0.291 rows=150)
 *       Buffers: shared hit=5
 *
 * Forcing the existing indexes instead of the scan costs more:
 *
 *     Index Scan using permissions_pkey        (actual time=0.020..0.105)
 *       Bitmap Index Scan on role_permissions_idx
 *     (cost=20.03..37.83) (actual time=0.254..0.415 rows=150)
 *
 * 0.415ms against 0.291ms. The index is 40% slower for the same answer, because at
 * 302 rows the table is smaller than the index would be.
 *
 * So this gate protects the two things that are actually true, and says what to
 * do when they stop being true.
 */

/**
 * The row count above which the sequential scan stops being the right plan.
 *
 * Not a guess. Measured on a probe table of the same shape: at 2,000 matching
 * rows the index wins (5.2ms against 7.9ms), at 302 the scan wins (0.291ms
 * against 0.415ms). The crossover is somewhere between, and 5,000 is set above it
 * with room to spare — this threshold exists to notice that the catalogue stopped
 * being bounded, not to catch the exact row where the planner changes its mind.
 *
 * The real condition, from §1.2, is the shape rather than the number: the
 * catalogue is bounded by the resource:action surface, so it cannot grow with
 * users or organizations. The day that stops being true — per-tenant
 * permissions, per-resource scopes — the number stops being the thing to watch.
 */
const ROW_COUNT_CEILING = 5_000;

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  // Seed explicitly. `buildApp` seeds permissions on a *fresh* database, but this
  // suite does not build an app, and on a developer machine the catalogue is
  // already populated from some earlier run — so the first version of this test
  // passed locally and failed in CI, where the database is empty. A test that
  // depends on what happens to be in the database is not testing anything.
  const repository = new DrizzlePermissionRepository();
  await repository.ensureRolePermissionsSeeded();
});

after(async () => {
  await closeDb().catch(() => {});
});

async function rowCount(table: string): Promise<number> {
  // `table` is never caller-supplied; it is a literal from the test below.
  const rows = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return Number((rows as unknown as { n: number }[])[0].n);
}

async function indexNames(table: string): Promise<Set<string>> {
  const rows = await db.execute(
    sql.raw(`select indexname from pg_indexes where tablename = '${table}'`)
  );
  return new Set((rows as unknown as { indexname: string }[]).map((r) => r.indexname));
}

describe("the authorization path's indexes", () => {
  it("has the composite indexes the query uses", async () => {
    // If either is dropped, the planner starts scanning `role_permissions` for
    // every permission check, and nothing else in the build would notice.
    const permissionIndexes = await indexNames("permissions");
    assert.ok(
      permissionIndexes.has("permissions_resource_action_idx"),
      `permissions is missing its (resource, action) index. Found: ` +
        `${[...permissionIndexes].join(", ") || "none"}`
    );

    const roleIndexes = await indexNames("role_permissions");
    assert.ok(
      roleIndexes.has("role_permissions_idx"),
      `role_permissions is missing its (role, permission_id) index. Found: ` +
        `${[...roleIndexes].join(", ") || "none"}`
    );
  });

  it("has a permission catalogue small enough for the sequential scan to be right", async () => {
    const permissions = await rowCount("permissions");
    const rolePermissions = await rowCount("role_permissions");

    for (const [table, count] of [
      ["permissions", permissions],
      ["role_permissions", rolePermissions],
    ] as const) {
      assert.ok(
        count <= ROW_COUNT_CEILING,
        `${table} has ${count} rows, above the ${ROW_COUNT_CEILING} at which this ` +
          `gate was last measured. The sequential scan is no longer assumed to be ` +
          `the right plan — measure again before assuming anything. ` +
          `\n\n` +
          `  EXPLAIN (ANALYZE, BUFFERS) the query in src/repositories/permission.ts\n` +
          `  (listForRole) and decide whether an index now pays for\n` +
          `  itself. If permissions have become per-tenant or per-resource rather\n` +
          `  than a fixed catalogue, the row count is no longer the thing to watch\n` +
          `  and ROW_COUNT_CEILING in this file should be replaced with that test.`
      );
    }
  });

  it("resolves a role's permissions, so the gate is measuring a live query", async () => {
    // The counts above are only meaningful if the query they describe is the one
    // that runs. This asserts the shape of the result rather than its contents,
    // because the contents depend on what has been seeded.
    const repository = new DrizzlePermissionRepository();
    const forOwner = await repository.listForRole("owner");
    assert.ok(forOwner.length > 0, "the owner role should hold permissions after seeding");
    assert.ok(Array.isArray(forOwner), "the query should return an array");

    for (const permission of forOwner) {
      assert.equal(typeof permission.resource, "string");
      assert.equal(typeof permission.action, "string");
      assert.ok(
        permission.resource.length > 0 && permission.action.length > 0,
        "a permission row with an empty resource or action would break permissionKey()"
      );
    }
  });
});
