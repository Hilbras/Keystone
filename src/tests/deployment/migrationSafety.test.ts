import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { migrationsFolder } = await import("../../lib/paths.js");
const { expectedTableNames, verifySchema } = await import("../../db/verifySchema.js");

/**
 * §6.5. `drizzle-kit migrate` reports what its journal applied; it does not report
 * what is actually in the database. A half-applied migration, a restore from an
 * older dump, or a `search_path` resolving elsewhere all leave a process that
 * serves 500s while telling the orchestrator it is healthy.
 *
 * The expectation list is derived from `schema.ts` through the ORM's own
 * `isTable`/`getTableName`, so a table added to the schema cannot be forgotten here.
 */

describe("migration safety", () => {
  before(async () => {
    await migrate(db, { migrationsFolder: migrationsFolder() });
  });

  after(async () => {
    await closeDb().catch(() => {});
  });

  it("derives every table from the Drizzle schema", () => {
    const tables = expectedTableNames();
    // The exact count changes with the schema; these are the invariants that make
    // the list trustworthy.
    assert.ok(tables.length >= 30, `expected at least 30 tables, got ${tables.length}`);
    assert.ok(tables.includes("users"));
    assert.ok(tables.includes("webhook_deliveries"));
    assert.ok(tables.includes("scim_groups"));
    // Sorted, so a diff of two reports is readable.
    assert.deepEqual(tables, [...tables].sort());
    assert.equal(new Set(tables).size, tables.length, "no duplicate names");
  });

  it("reports a migrated database as complete", async () => {
    const result = await verifySchema();
    assert.deepEqual(result.missing, []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.expected, expectedTableNames());
  });
});
