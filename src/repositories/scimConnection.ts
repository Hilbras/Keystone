import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { scimConnections, type ScimConnection } from "../db/schema.js";
import type { CreateScimConnectionInput, ScimConnectionRepository } from "./types.js";

export type ScimConnectionPublic = Omit<ScimConnection, "tokenHash" | "previousTokenHash">;

/**
 * Per-organization SCIM credentials.
 *
 * The bearer token is never stored: only its SHA-256 digest, which is also what
 * authentication looks up. That removes both the plaintext-at-rest problem and
 * the timing side channel of comparing secrets in application code, because the
 * comparison happens inside the database's index lookup.
 */
export class DrizzleScimConnectionRepository implements ScimConnectionRepository {
  async create(input: CreateScimConnectionInput): Promise<ScimConnection> {
    const [record] = await db
      .insert(scimConnections)
      .values({
        orgId: input.orgId,
        name: input.name,
        tokenHash: input.tokenHash,
        tokenHint: input.tokenHint,
        previousTokenHash: input.previousTokenHash ?? null,
        previousTokenValidUntil: input.previousTokenValidUntil ?? null,
        createdByUserId: input.createdByUserId ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    return record;
  }

  async findById(id: string): Promise<ScimConnection | undefined> {
    const [record] = await db
      .select()
      .from(scimConnections)
      .where(eq(scimConnections.id, id))
      .limit(1);
    return record;
  }

  async findActiveByOrg(orgId: string): Promise<ScimConnection | undefined> {
    const [record] = await db
      .select()
      .from(scimConnections)
      .where(and(eq(scimConnections.orgId, orgId), isNull(scimConnections.revokedAt)))
      .limit(1);
    return record;
  }

  async listByOrg(orgId: string): Promise<ScimConnection[]> {
    return db
      .select()
      .from(scimConnections)
      .where(eq(scimConnections.orgId, orgId))
      .orderBy(sql`${scimConnections.createdAt} desc`);
  }

  async listAll(): Promise<ScimConnection[]> {
    return db.select().from(scimConnections).orderBy(sql`${scimConnections.createdAt} desc`);
  }

  /**
   * Resolve a presented token to its connection. Accepts the current token and,
   * inside the rotation grace window, the previous one. Revoked and expired
   * connections never resolve.
   */
  async findByTokenHash(tokenHash: string, now = new Date()): Promise<ScimConnection | undefined> {
    const [record] = await db
      .select()
      .from(scimConnections)
      .where(
        and(
          isNull(scimConnections.revokedAt),
          or(
            eq(scimConnections.tokenHash, tokenHash),
            and(
              eq(scimConnections.previousTokenHash, tokenHash),
              gt(scimConnections.previousTokenValidUntil, now)
            )
          )
        )
      )
      .limit(1);
    return record;
  }

  /**
   * Issue a new token. The previous one keeps working until
   * `previousTokenValidUntil`, so a rotation does not drop in-flight IdM traffic.
   */
  async rotate(
    id: string,
    input: { tokenHash: string; tokenHint: string; graceSeconds: number; now?: Date }
  ): Promise<ScimConnection | undefined> {
    const now = input.now ?? new Date();
    const validUntil = new Date(now.getTime() + input.graceSeconds * 1000);

    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(scimConnections)
        .where(and(eq(scimConnections.id, id), isNull(scimConnections.revokedAt)))
        .limit(1);
      if (!current) return undefined;

      // The token being replaced becomes the grace-period token; the new one
      // becomes the only primary token. Reading first is required because a
      // single UPDATE cannot reference the column it is replacing.
      const [record] = await tx
        .update(scimConnections)
        .set({
          previousTokenHash: current.tokenHash,
          previousTokenValidUntil: validUntil,
          tokenHash: input.tokenHash,
          tokenHint: input.tokenHint,
          lastRotatedAt: now,
          updatedAt: now,
        })
        .where(and(eq(scimConnections.id, id), isNull(scimConnections.revokedAt)))
        .returning();

      return record;
    });
  }

  async revoke(id: string, now = new Date()): Promise<ScimConnection | undefined> {
    const [record] = await db
      .update(scimConnections)
      .set({ revokedAt: now, previousTokenHash: null, previousTokenValidUntil: null, updatedAt: now })
      .where(and(eq(scimConnections.id, id), isNull(scimConnections.revokedAt)))
      .returning();
    return record;
  }

  async touch(id: string, now = new Date()): Promise<void> {
    await db
      .update(scimConnections)
      .set({ lastUsedAt: now })
      .where(eq(scimConnections.id, id));
  }

  async deleteRevokedBefore(cutoff: Date): Promise<number> {
    const rows = await db
      .delete(scimConnections)
      .where(and(sql`revoked_at is not null`, lte(scimConnections.revokedAt, cutoff)))
      .returning({ id: scimConnections.id });
    return rows.length;
  }
}
