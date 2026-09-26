import { eq, and, isNull, sql } from "drizzle-orm";
import { canonicalFingerprint, isValidFingerprint } from "./trustedProxies.js";
import { db } from "../db/index.js";
import { serviceAccounts, apiKeys, type ServiceAccount } from "../db/schema.js";

export async function createServiceAccount(input: {
  orgId: string;
  name: string;
  description?: string;
  certFingerprint?: string | null;
}): Promise<ServiceAccount> {
  const [record] = await db
    .insert(serviceAccounts)
    .values({
      orgId: input.orgId,
      name: input.name,
      description: input.description ?? null,
      certFingerprint: input.certFingerprint ?? null,
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

/**
 * Bind or clear the client certificate this account authenticates with.
 *
 * Clearing sets the column to null, which removes certificate authentication
 * for the account entirely — an unbound account can only use an API key. The
 * unique index on `cert_fingerprint` is what stops one certificate being bound
 * to two accounts; a conflict surfaces as an error here rather than silently
 * picking a winner.
 *
 * @throws if `fingerprint` is not a well-formed SHA-256 digest, or if the
 *   certificate is already bound to a different account.
 */
export async function setServiceAccountCertificate(
  id: string,
  orgId: string,
  fingerprint: string | null
): Promise<ServiceAccount | undefined> {
  // Canonicalize here rather than trusting the caller. The hex and
  // colon-separated spellings of one certificate must not become two bindings,
  // and this is the only place every caller is guaranteed to pass through.
  let canonical: string | null = null;
  if (fingerprint !== null) {
    const trimmed = fingerprint.trim();
    if (!isValidFingerprint(trimmed)) {
      throw new Error("fingerprint must be a SHA-256 digest (64 hex characters)");
    }
    canonical = canonicalFingerprint(trimmed);
  }

  const [updated] = await db
    .update(serviceAccounts)
    .set({ certFingerprint: canonical, updatedAt: sql`now()` })
    .where(and(eq(serviceAccounts.id, id), eq(serviceAccounts.orgId, orgId)))
    .returning();
  return updated;
}

/**
 * Permanently stop an account authenticating. Kept separate from
 * `isActive: false` so a later reactivation cannot silently restore access —
 * reactivation requires clearing `revokedAt` deliberately.
 */
export async function revokeServiceAccount(
  id: string,
  orgId: string
): Promise<ServiceAccount | undefined> {
  const [updated] = await db
    .update(serviceAccounts)
    .set({ isActive: false, revokedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(serviceAccounts.id, id), eq(serviceAccounts.orgId, orgId), isNull(serviceAccounts.revokedAt)))
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
