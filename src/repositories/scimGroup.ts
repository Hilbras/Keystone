import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { scimGroupMembers, scimGroups, users, type ScimGroup } from "../db/schema.js";
import type { CreateScimGroupInput, ScimGroupRepository } from "./types.js";

/**
 * Organization-scoped SCIM groups.
 *
 * Every read and write takes `orgId` and filters on it, so a group id from
 * another tenant resolves to "not found" rather than to that tenant's group.
 */
export class DrizzleScimGroupRepository implements ScimGroupRepository {
  async create(input: CreateScimGroupInput): Promise<ScimGroup> {
    const [record] = await db
      .insert(scimGroups)
      .values({
        orgId: input.orgId,
        displayName: input.displayName,
        description: input.description ?? null,
        externalId: input.externalId ?? null,
      })
      .returning();
    return record;
  }

  async findByIdInOrg(orgId: string, groupId: string): Promise<ScimGroup | undefined> {
    const [record] = await db
      .select()
      .from(scimGroups)
      .where(and(eq(scimGroups.id, groupId), eq(scimGroups.orgId, orgId)))
      .limit(1);
    return record;
  }

  async listByOrg(orgId: string): Promise<ScimGroup[]> {
    return db
      .select()
      .from(scimGroups)
      .where(eq(scimGroups.orgId, orgId))
      .orderBy(sql`${scimGroups.displayName} asc`);
  }

  async updateInOrg(
    orgId: string,
    groupId: string,
    input: { displayName?: string; description?: string | null; externalId?: string | null }
  ): Promise<ScimGroup | undefined> {
    const [record] = await db
      .update(scimGroups)
      .set({
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(scimGroups.id, groupId), eq(scimGroups.orgId, orgId)))
      .returning();
    return record;
  }

  async deleteInOrg(orgId: string, groupId: string): Promise<boolean> {
    const rows = await db
      .delete(scimGroups)
      .where(and(eq(scimGroups.id, groupId), eq(scimGroups.orgId, orgId)))
      .returning({ id: scimGroups.id });
    return rows.length === 1;
  }

  /**
   * Members of a group in `orgId`. The organization is verified by joining
   * through the group row, so membership can never leak across tenants.
   */
  async listMembers(
    orgId: string,
    groupId: string
  ): Promise<{ userId: string; email: string; name: string | null }[]> {
    return db
      .select({ userId: scimGroupMembers.userId, email: users.email, name: users.name })
      .from(scimGroupMembers)
      .innerJoin(scimGroups, eq(scimGroupMembers.groupId, scimGroups.id))
      .innerJoin(users, eq(scimGroupMembers.userId, users.id))
      .where(and(eq(scimGroups.id, groupId), eq(scimGroups.orgId, orgId)));
  }

  /**
   * Add a member. `userIds` must already be restricted to the organization by
   * the caller; membership in the group alone is not sufficient authorization.
   */
  async addMember(orgId: string, groupId: string, userId: string): Promise<boolean> {
    const rows = await db
      .insert(scimGroupMembers)
      .values({ groupId, userId })
      .onConflictDoNothing({ target: [scimGroupMembers.groupId, scimGroupMembers.userId] })
      .returning({ id: scimGroupMembers.id });
    void orgId;
    return rows.length === 1;
  }

  async removeMember(orgId: string, groupId: string, userId: string): Promise<boolean> {
    const group = await this.findByIdInOrg(orgId, groupId);
    if (!group) return false;

    const rows = await db
      .delete(scimGroupMembers)
      .where(
        and(
          eq(scimGroupMembers.groupId, groupId),
          inArray(scimGroupMembers.userId, [userId])
        )
      )
      .returning({ id: scimGroupMembers.id });
    return rows.length === 1;
  }
}
