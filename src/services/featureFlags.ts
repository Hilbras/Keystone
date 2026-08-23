import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { featureFlags } from "../db/schema.js";
import { configurationService } from "./configuration.js";

const cache = new Map<string, boolean>();
let cacheLoaded = false;

async function loadIntoCache() {
  if (cacheLoaded) return;
  const rows = await db.select({ key: featureFlags.key, enabled: featureFlags.enabled }).from(featureFlags);
  for (const row of rows) {
    cache.set(row.key, row.enabled);
  }
  cacheLoaded = true;
}

export async function isFeatureEnabled(flag: string): Promise<boolean> {
  await loadIntoCache();
  if (cache.has(flag)) return cache.get(flag)!;
  return configurationService.isEnabled(flag);
}

export async function requireFeatureEnabled(flag: string): Promise<void> {
  const enabled = await isFeatureEnabled(flag);
  if (!enabled) {
    const error = new Error(`Feature '${flag}' is not enabled`) as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}

export async function listFeatureFlags(): Promise<
  Array<{ key: string; enabled: boolean; description: string | null; source: "database" | "environment" }>
> {
  await loadIntoCache();
  const dbRows = await db.select().from(featureFlags).orderBy(featureFlags.key);
  const envFlags = configurationService.get().featureFlags;

  const merged = new Map<string, { key: string; enabled: boolean; description: string | null; source: "database" | "environment" }>();

  for (const row of dbRows) {
    merged.set(row.key, { key: row.key, enabled: row.enabled, description: row.description, source: "database" });
  }

  for (const [key, enabled] of Object.entries(envFlags)) {
    if (!merged.has(key)) {
      merged.set(key, { key, enabled, description: null, source: "environment" });
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export async function setFeatureFlag(
  key: string,
  enabled: boolean,
  description?: string
): Promise<{ key: string; enabled: boolean }> {
  const existing = await db.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
  if (existing.length > 0) {
    const [row] = await db
      .update(featureFlags)
      .set({ enabled, description: description ?? existing[0].description, updatedAt: new Date() })
      .where(eq(featureFlags.key, key))
      .returning();
    cache.set(row.key, row.enabled);
    return { key: row.key, enabled: row.enabled };
  }

  const [row] = await db
    .insert(featureFlags)
    .values({ key, enabled, description: description || null })
    .returning();
  cache.set(row.key, row.enabled);
  return { key: row.key, enabled: row.enabled };
}

export async function deleteFeatureFlag(key: string): Promise<boolean> {
  const [row] = await db.delete(featureFlags).where(eq(featureFlags.key, key)).returning();
  if (row) {
    cache.delete(row.key);
  }
  return !!row;
}

export function clearFeatureFlagCache(): void {
  cache.clear();
  cacheLoaded = false;
}
