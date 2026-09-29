/**
 * Database connection lifecycle, separated from the client.
 *
 * `src/routes/setup.ts` is the only caller that needs to *establish* the
 * connection rather than use it: it runs before anything else, against a
 * configuration file the operator has just written, and the pool does not exist
 * yet. It needs `initDb`, and it does not need `db`.
 *
 * Those used to come from the same import, which is why the layering rule — "a
 * route must not import the database client" — could not be written without an
 * exception for this one legitimate use. Splitting them means the rule stays
 * strict: the route imports lifecycle, and the client stays behind the
 * repository layer. A rule with a carve-out is a rule that gets carved out
 * again.
 *
 * `initDb` is re-exported from `./index.js` so nothing else has to change.
 */
export { initDb, closeDb, getDb } from "./index.js";

import { db } from "./index.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Whether the connection pool exists yet.
 *
 * Not the same question as "can I reach the database" — the pool is created
 * lazily, and before `initDb` runs there is nothing to ask. A boolean rather than
 * a `try` around a query, so a caller can distinguish "not set up" from "set up
 * and broken", which are different problems with different fixes.
 */
export function isDatabaseInitialized(): boolean {
  return db !== undefined;
}

/**
 * Apply the migrations.
 *
 * The migrator needs the client, so it cannot live behind a repository — but it
 * is connection lifecycle rather than data access, and keeping it here is what
 * lets `setup.ts` reach for it without importing `db`. The migration folder is
 * resolved from this module, so a caller cannot point the migrator somewhere
 * operator-supplied.
 */
export async function runMigrations(): Promise<void> {
  if (!db) throw new Error("database is not initialized");
  await migrate(db, { migrationsFolder: path.resolve(here, "migrations") });
}
