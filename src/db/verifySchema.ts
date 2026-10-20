import { getTableName, isTable, sql } from "drizzle-orm";
import { db } from "./index.js";
import * as schema from "./schema.js";

/**
 * §6.5. Post-migration schema verification.
 *
 * `drizzle-kit migrate` reports that it applied the files in its journal. It does
 * not report whether the result is the schema the application expects — and the
 * application's own startup path did not either: it logged "migrations applied" and
 * started serving. A half-applied migration, a restore from an older dump, or a
 * `search_path` that resolves to the wrong schema all produce a process that is
 * healthy, ready, and fails per request.
 *
 * Checking is cheap: one query against `information_schema`, and the expected list
 * is derived from the Drizzle schema itself rather than a hand-maintained list that
 * drifts the first time a table is added. `isTable`/`getTableName` are the same
 * primitives the ORM uses, so a table that exists in code but not in the database
 * cannot be forgotten here.
 *
 * This is a *presence* check, not a full schema diff. A column that is missing from
 * a table that exists still passes. That is a deliberate bound: a full diff means
 * shipping a migration engine's comparison logic, and presence catches the failures
 * that actually happen in deployment (an interrupted migration, a stale restore, a
 * misconfigured schema) without turning boot into a schema linter.
 */

export function expectedTableNames(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (isTable(value)) names.add(getTableName(value));
  }
  return [...names].sort();
}

export interface SchemaVerification {
  ok: boolean;
  expected: string[];
  missing: string[];
}

/**
 * Compare the tables declared in `schema.ts` with the tables in the current schema.
 *
 * Throws only if the database cannot be queried — a caller at boot treats that as a
 * failed migration, because it is one.
 */
export async function verifySchema(): Promise<SchemaVerification> {
  const expected = expectedTableNames();
  const rows = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = current_schema()`
  )) as unknown as Array<{ table_name: string }>;
  const present = new Set(rows.map((row) => row.table_name));
  const missing = expected.filter((table) => !present.has(table));
  return { ok: missing.length === 0, expected, missing };
}
