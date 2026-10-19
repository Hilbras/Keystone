import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { config } from "../config.js";
import * as schema from "./schema.js";
import { noteQuery } from "./queryCounter.js";
import { recordDbStatement } from "../plugins/operationalMetrics.js";

let dbClient: postgres.Sql | null = null;

/**
 * Live binding for the Drizzle database client. Re-assigned by `initDb()` once
 * DATABASE_URL is known. ES module imports see the updated value, so existing
 * code that imports `db` continues to work after configuration changes.
 */
export let db: PostgresJsDatabase<typeof schema>;

export function initDb(): void {
  const databaseUrl = config.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (dbClient) {
    dbClient.end().catch(() => {});
  }
  dbClient = postgres(databaseUrl, {
    max: 10,
    // Feeds the benchmark's exact query count. `debug` fires once per statement
    // on every driver version used here, including prepared-statement execution,
    // so an N+1 regression is visible as a number rather than inferred from a
    // latency. It is a no-op unless a benchmark is counting.
    //
    // §5.2. The same callback publishes the fleet-wide statement counter. There is
    // deliberately no duration here: postgres.js calls `debug` *before* the query is
    // written to the socket, so this point has a start time and no end. Database
    // latency is measured by the readiness probe instead, which is the only place a
    // round trip can actually be timed — a number invented here would be a fiction
    // that looked like a measurement.
    debug: () => {
      noteQuery();
      recordDbStatement();
    },
  });
  db = drizzle(dbClient, { schema });
}

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!db) {
    initDb();
  }
  return db;
}

/**
 * Close the underlying connection pool. Used on graceful shutdown and in tests
 * so pooled sockets do not keep the Node process alive after work is done.
 */
export async function closeDb(): Promise<void> {
  if (dbClient) {
    const client = dbClient;
    dbClient = null;
    await client.end({ timeout: 5 });
  }
}

export { schema };

/**
 * Run `fn` while holding a Postgres **session-level** advisory lock named
 * `name`, and report whether the lock was obtained (plan §1.6).
 *
 * Session-level rather than transaction-level (`pg_try_advisory_xact_lock`)
 * because the operation it guards — the setup bootstrap — spans several
 * repository calls, each of which draws its own connection from the pool. A
 * transaction-scoped lock would be released when the *first* of those
 * transactions committed, which is exactly the window the lock exists to close.
 *
 * It is taken on a **reserved** connection for the same reason: a session lock
 * belongs to the session that took it, and a pooled client hands each statement
 * a possibly-different session, so `pg_advisory_unlock` issued later would land
 * on a connection that never held the lock and warn "you don't own a lock of
 * type ExclusiveLock" while leaving it held until that session dies. `reserve()`
 * pins one connection for the whole acquire/run/release sequence.
 *
 * `hashtext` folds the human-readable name into the `bigint` key the advisory
 * lock functions take, so no bookkeeping table of numeric ids is needed. A false
 * result is not an error: it means another process is already running the same
 * guarded operation, and the caller decides what that means (409 for setup).
 */
export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (!dbClient) throw new Error("database is not initialized");
  const reserved = await dbClient.reserve();
  try {
    const rows = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtext(${name})) as locked
    `;
    if (!rows[0]?.locked) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      // Best-effort: `release()` below returns the connection to the pool, and a
      // session that is dropped also drops its locks. A failed unlock must not
      // mask the error from `fn`, which is the one worth propagating.
      await reserved`select pg_advisory_unlock(hashtext(${name}))`.catch(() => {});
    }
  } finally {
    reserved.release();
  }
}

// Initialize immediately when DATABASE_URL is available so existing code paths
// keep working without an explicit initDb() call.
if (config.DATABASE_URL) {
  initDb();
}
