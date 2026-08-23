import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { organizations, orgMemberships, users, type Organization, type OrgMembership } from "../db/schema.js";
import type { CreateOrganizationInput, OrganizationRepository } from "./types.js";

export class DrizzleOrganizationRepository implements OrganizationRepository {
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  async create(input: CreateOrganizationInput): Promise<Organization> {
    const baseSlug = input.slug || this.slugify(input.name);
    const slug = await this.ensureUniqueSlug(baseSlug);

    const [org] = await db
      .insert(organizations)
      .values({
        name: input.name,
        slug,
        plan: input.plan || "free",
      })
      .returning();
    return org;
  }

  async findById(id: string): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return org;
  }

  async findBySlug(slug: string): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
    return org;
  }

  async listByUserId(userId: string): Promise<Organization[]> {
    const rows = await db
      .select({ org: organizations })
      .from(orgMemberships)
      .where(eq(orgMemberships.userId, userId))
      .innerJoin(organizations, eq(orgMemberships.orgId, organizations.id));
    return rows.map((r) => r.org);
  }

  async addMembership(input: { orgId: string; userId: string; role: string }): Promise<OrgMembership> {
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
    role: string
  ): Promise<OrgMembership | undefined> {
    const [updated] = await db
      .update(orgMemberships)
      .set({ role, updatedAt: sql`now()` })
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .returning();
    return updated;
  }

  async removeMembership(orgId: string, userId: string): Promise<boolean> {
    const deleted = await db
      .delete(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .returning();
    return deleted.length > 0;
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
        },
      })
      .from(orgMemberships)
      .where(eq(orgMemberships.orgId, orgId))
      .innerJoin(users, eq(orgMemberships.userId, users.id));
  }

  private async ensureUniqueSlug(base: string): Promise<string> {
    let slug = base || "org";
    let counter = 2;
    while (true) {
      const existing = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1);
      if (existing.length === 0) return slug;
      slug = `${base}-${counter}`;
      counter++;
    }
  }
}
