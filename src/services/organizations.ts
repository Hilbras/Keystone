import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { organizations, orgMemberships, users, type Organization, type OrgMembership } from "../db/schema.js";

export type OrgRole = "owner" | "admin" | "member";

const ROLES: OrgRole[] = ["owner", "admin", "member"];

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export async function createOrganization(input: {
  name: string;
  slug?: string;
  plan?: string;
}): Promise<Organization> {
  const baseSlug = input.slug || slugify(input.name);
  const slug = await ensureUniqueSlug(baseSlug);

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

export async function findOrganizationById(id: string): Promise<Organization | undefined> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return org;
}

export async function findOrganizationBySlug(slug: string): Promise<Organization | undefined> {
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  return org;
}

export async function findOrganizationsByUserId(userId: string): Promise<Organization[]> {
  const rows = await db
    .select({ org: organizations })
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, userId))
    .innerJoin(organizations, eq(orgMemberships.orgId, organizations.id));
  return rows.map((r) => r.org);
}

export async function addOrgMembership(input: {
  orgId: string;
  userId: string;
  role: OrgRole;
}): Promise<OrgMembership> {
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

export async function findMembership(
  orgId: string,
  userId: string
): Promise<OrgMembership | undefined> {
  const [membership] = await db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1);
  return membership;
}

export async function updateMembershipRole(
  orgId: string,
  userId: string,
  role: OrgRole
): Promise<OrgMembership | undefined> {
  const [updated] = await db
    .update(orgMemberships)
    .set({ role, updatedAt: sql`now()` })
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .returning();
  return updated;
}

export async function removeMembership(orgId: string, userId: string): Promise<boolean> {
  const deleted = await db
    .delete(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .returning();
  return deleted.length > 0;
}

export async function countOwners(orgId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, "owner")));
  return rows[0]?.count ?? 0;
}

export async function requireOrgRole(
  userId: string,
  orgId: string,
  allowedRoles: OrgRole[]
): Promise<OrgMembership> {
  const membership = await findMembership(orgId, userId);
  if (!membership) {
    const error = new Error("Not a member of this organization") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
  if (!allowedRoles.includes(membership.role as OrgRole)) {
    const error = new Error("Insufficient organization permissions") as Error & {
      statusCode: number;
    };
    error.statusCode = 403;
    throw error;
  }
  return membership;
}

export async function listOrgMembers(orgId: string) {
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

async function ensureUniqueSlug(base: string): Promise<string> {
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
