import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  scimGroupMembers,
  scimGroups,
  orgMemberships,
  users,
  type ScimGroup,
} from "../db/schema.js";
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
      // Only users who are *currently* members: a removed member's email and
      // name must stop being readable by the organization that removed them.
      .innerJoin(
        orgMemberships,
        and(
          eq(orgMemberships.userId, scimGroupMembers.userId),
          eq(orgMemberships.orgId, orgId)
        )
      )
      .where(and(eq(scimGroups.id, groupId), eq(scimGroups.orgId, orgId)));
  }

  /**
   * Add a member, enforcing both halves in one statement: the group must belong
   * to `orgId`, and the user must be a member of `orgId`. Callers cannot bypass
   * the tenancy check by passing a foreign group or user id.
   */
  async addMember(orgId: string, groupId: string, userId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [group] = await tx
        .select({ id: scimGroups.id })
        .from(scimGroups)
        .where(and(eq(scimGroups.id, groupId), eq(scimGroups.orgId, orgId)))
        .limit(1);
      if (!group) return false;

      const [member] = await tx
        .select({ id: orgMemberships.id })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        .limit(1);
      if (!member) return false;

      const rows = await tx
        .insert(scimGroupMembers)
        .values({ groupId, userId })
        .onConflictDoNothing({ target: [scimGroupMembers.groupId, scimGroupMembers.userId] })
        .returning({ id: scimGroupMembers.id });

      return rows.length === 1;
    });
  }

  async removeMember(orgId: string, groupId: string, userId: string): Promise<boolean> {
    const group = await this.findByIdInOrg(orgId, groupId);
    if (!group) return false;

    const rows = await db
      .delete(scimGroupMembers)
      .where(and(eq(scimGroupMembers.groupId, groupId), eq(scimGroupMembers.userId, userId)))
      .returning({ id: scimGroupMembers.id });
    return rows.length === 1;
  }
}
