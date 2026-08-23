import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { serviceAccounts, apiKeys, type ServiceAccount } from "../db/schema.js";

export async function createServiceAccount(input: {
  orgId: string;
  name: string;
  description?: string;
}): Promise<ServiceAccount> {
  const [record] = await db
    .insert(serviceAccounts)
    .values({
      orgId: input.orgId,
      name: input.name,
      description: input.description ?? null,
    })
    .returning();
  return record;
}

export async function findServiceAccountsByOrgId(orgId: string): Promise<ServiceAccount[]> {
  return db
    .select()
    .from(serviceAccounts)
    .where(and(eq(serviceAccounts.orgId, orgId), eq(serviceAccounts.isActive, true)))
    .orderBy(serviceAccounts.name);
}

export async function findServiceAccountById(
  id: string,
  orgId: string
): Promise<ServiceAccount | undefined> {
  const [record] = await db
    .select()
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.id, id),
        eq(serviceAccounts.orgId, orgId),
        eq(serviceAccounts.isActive, true)
      )
    )
    .limit(1);
  return record;
}

export async function updateServiceAccount(
  id: string,
  orgId: string,
  updates: Partial<{ name: string; description: string; isActive: boolean }>
): Promise<ServiceAccount | undefined> {
  const [updated] = await db
    .update(serviceAccounts)
    .set({ ...updates, updatedAt: sql`now()` })
    .where(and(eq(serviceAccounts.id, id), eq(serviceAccounts.orgId, orgId)))
    .returning();
  return updated;
}

export async function listServiceAccountApiKeys(serviceAccountId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.serviceAccountId, serviceAccountId));
}
