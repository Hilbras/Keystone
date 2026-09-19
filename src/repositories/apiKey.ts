import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, type ApiKey } from "../db/schema.js";

type ApiKeyPublic = Omit<ApiKey, "keyHash">;

export interface ApiKeyRepository {
  create(input: {
    userId?: string | null;
    serviceAccountId?: string | null;
    orgId?: string | null;
    appId?: string | null;
    name: string;
    prefix: string;
    keyHash: string;
    scopes?: string[];
    expiresAt?: Date | null;
  }): Promise<ApiKey>;
  listByUserId(userId: string): Promise<ApiKeyPublic[]>;
  listByOrgId(orgId: string): Promise<ApiKeyPublic[]>;
  listByServiceAccountId(serviceAccountId: string): Promise<ApiKeyPublic[]>;
  revokeByKeyIdAndUserId(keyId: string, userId: string): Promise<ApiKeyPublic | undefined>;
  revokeByKeyIdAndOrgId(keyId: string, orgId: string): Promise<ApiKeyPublic | undefined>;
}

export class DrizzleApiKeyRepository implements ApiKeyRepository {
  async create(input: {
    userId?: string | null;
    serviceAccountId?: string | null;
    orgId?: string | null;
    appId?: string | null;
    name: string;
    prefix: string;
    keyHash: string;
    scopes?: string[];
    expiresAt?: Date | null;
  }): Promise<ApiKey> {
    const [record] = await db
      .insert(apiKeys)
      .values({
        userId: input.userId ?? null,
        serviceAccountId: input.serviceAccountId ?? null,
        orgId: input.orgId ?? null,
        appId: input.appId ?? null,
        name: input.name,
        prefix: input.prefix,
        keyHash: input.keyHash,
        scopes: input.scopes?.length ? input.scopes : ["api:read"],
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    return record;
  }

  async listByUserId(userId: string): Promise<ApiKeyPublic[]> {
    return db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        serviceAccountId: apiKeys.serviceAccountId,
        orgId: apiKeys.orgId,
        appId: apiKeys.appId,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId));
  }

  async listByOrgId(orgId: string): Promise<ApiKeyPublic[]> {
    return db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        serviceAccountId: apiKeys.serviceAccountId,
        orgId: apiKeys.orgId,
        appId: apiKeys.appId,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.orgId, orgId));
  }

  async listByServiceAccountId(serviceAccountId: string): Promise<ApiKeyPublic[]> {
    return db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        serviceAccountId: apiKeys.serviceAccountId,
        orgId: apiKeys.orgId,
        appId: apiKeys.appId,
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

  async revokeByKeyIdAndUserId(keyId: string, userId: string): Promise<ApiKeyPublic | undefined> {
    const [record] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
      .returning({
        id: apiKeys.id,
        userId: apiKeys.userId,
        serviceAccountId: apiKeys.serviceAccountId,
        orgId: apiKeys.orgId,
        appId: apiKeys.appId,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      });
    return record;
  }

  async revokeByKeyIdAndOrgId(keyId: string, orgId: string): Promise<ApiKeyPublic | undefined> {
    const [record] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId)))
      .returning({
        id: apiKeys.id,
        userId: apiKeys.userId,
        serviceAccountId: apiKeys.serviceAccountId,
        orgId: apiKeys.orgId,
        appId: apiKeys.appId,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      });
    return record;
  }
}
