import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { config } from "../config.js";
import * as schema from "./schema.js";

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
  dbClient = postgres(databaseUrl, { max: 10 });
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

// Initialize immediately when DATABASE_URL is available so existing code paths
// keep working without an explicit initDb() call.
if (config.DATABASE_URL) {
  initDb();
}
