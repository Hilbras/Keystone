import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { organizations, orgMemberships, users, type Organization, type OrgMembership } from "../db/schema.js";
import { LastOwnerInvariantError, type CreateOrganizationInput, type OrganizationRepository } from "./types.js";

export type { OrganizationRepository } from "./types.js";

const ORGANIZATION_ROLES = new Set(["owner", "admin", "member"]);

export class DrizzleOrganizationRepository implements OrganizationRepository {
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  async createWithOwner(input: CreateOrganizationInput, userId: string): Promise<Organization> {
    const baseSlug = input.slug || this.slugify(input.name);
    return db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!owner?.isActive) throw new Error("Organization owner must be an active user");

      let slug = baseSlug || "org";
      let counter = 2;
      while (true) {
        const [existing] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.slug, slug))
          .limit(1);
        if (!existing) break;
        slug = `${baseSlug}-${counter}`;
        counter++;
      }

      const [org] = await tx
        .insert(organizations)
        .values({ name: input.name, slug, plan: input.plan || "free" })
        .returning();
      await tx.insert(orgMemberships).values({ orgId: org.id, userId, role: "owner" });
      return org;
    });
  }

  async findById(id: string): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return org;
  }

  async findBySlug(slug: string): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
    return org;
  }

  async listAll(): Promise<Organization[]> {
    return db.select().from(organizations).orderBy(organizations.createdAt);
  }

  async update(id: string, input: { name?: string; branding?: Record<string, unknown> }): Promise<Organization | undefined> {
    const [updated] = await db
      .update(organizations)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.branding !== undefined ? { branding: input.branding } : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, id))
      .returning();
    return updated;
  }

  async countMembers(orgId: string): Promise<number> {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(orgMemberships)
      .where(eq(orgMemberships.orgId, orgId));
    return countRow?.count ?? 0;
  }

  async listByUserId(userId: string): Promise<Organization[]> {
    const rows = await db
      .select({ org: organizations })
      .from(orgMemberships)
      .where(eq(orgMemberships.userId, userId))
      .innerJoin(organizations, eq(orgMemberships.orgId, organizations.id));
    return rows.map((r) => r.org);
  }

  async addMembership(input: { orgId: string; userId: string; role: "owner" | "admin" | "member" }): Promise<OrgMembership> {
    if (!ORGANIZATION_ROLES.has(input.role)) throw new Error("Invalid organization role");
    const [membership] = await db
      .insert(orgMemberships)
      .values({
        orgId: input.orgId,
        userId: input.userId,
        role: input.role,
      })
      .onConflictDoNothing({ target: [orgMemberships.orgId, orgMemberships.userId] })
      .returning();

    if (membership) return membership;

    const [existing] = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.userId, input.userId)))
      .limit(1);
    return existing;
  }

  async findMembership(orgId: string, userId: string): Promise<OrgMembership | undefined> {
    const [membership] = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .limit(1);
    return membership;
  }

  async updateMembershipRole(
    orgId: string,
    userId: string,
    role: "owner" | "admin" | "member"
  ): Promise<OrgMembership | undefined> {
    if (!ORGANIZATION_ROLES.has(role)) throw new Error("Invalid organization role");

    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        .limit(1);
      if (!current) return undefined;

      if (current.role === "owner" && role !== "owner") {
        const owners = await tx
          .select({ id: orgMemberships.id })
          .from(orgMemberships)
          .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, "owner")))
          .for("update");
        if (owners.length <= 1) throw new LastOwnerInvariantError("Cannot demote the last organization owner");
      }

      const [updated] = await tx
        .update(orgMemberships)
        .set({ role, updatedAt: sql`now()` })
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        .returning();
      return updated;
    });
  }

  async removeMembership(orgId: string, userId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        .limit(1);
      if (!current) return false;

      if (current.role === "owner") {
        const owners = await tx
          .select({ id: orgMemberships.id })
          .from(orgMemberships)
          .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, "owner")))
          .for("update");
        if (owners.length <= 1) throw new LastOwnerInvariantError("Cannot remove the last organization owner");
      }

      const deleted = await tx
        .delete(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        .returning();
      return deleted.length > 0;
    });
  }

  async countOwners(orgId: string): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, "owner")));
    return rows[0]?.count ?? 0;
  }

  async listMembers(orgId: string) {
    return db
      .select({
        membership: orgMemberships,
        user: {
          id: users.id,
          email: users.email,
          username: users.username,
          name: users.name,
          avatarUrl: users.avatarUrl,
          platformRole: users.role,
        },
      })
      .from(orgMemberships)
      .where(eq(orgMemberships.orgId, orgId))
      .innerJoin(users, eq(orgMemberships.userId, users.id));
  }

}
