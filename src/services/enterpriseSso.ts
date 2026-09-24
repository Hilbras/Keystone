import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgMemberships, type Organization } from "../db/schema.js";
import { slugifyUsername, ensureUniqueUsername } from "./users.js";
import { emit } from "./events/bus.js";

export interface EnterpriseUserClaims {
  email: string;
  name?: string;
  username?: string;
  externalId?: string;
}

export async function provisionEnterpriseUser(
  orgId: string,
  claims: EnterpriseUserClaims,
  defaultRole: "owner" | "admin" | "member" = "member"
) {
  const email = claims.email.toLowerCase().trim();
  if (!["owner", "admin", "member"].includes(defaultRole)) {
    throw new Error("Invalid organization role");
  }

  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (user && !user.isActive) {
    throw new Error("User account is deactivated");
  }

  if (!user) {
    const baseUsername = claims.username || claims.email.split("@")[0];
    const username = await ensureUniqueUsername(slugifyUsername(baseUsername));

    [user] = await db
      .insert(users)
      .values({
        email,
        username,
        name: claims.name || username,
        provider: "enterprise_sso",
        emailVerified: true,
      })
      .returning();
  }

  const [existingMembership] = await db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, user.id)))
    .limit(1);

  if (!existingMembership) {
    await db
      .insert(orgMemberships)
      .values({
        orgId,
        userId: user.id,
        role: defaultRole,
      })
      .onConflictDoNothing({ target: [orgMemberships.orgId, orgMemberships.userId] });
    await emit({
      type: "organization_member_invited",
      payload: {
        userId: user.id,
        orgId,
        metadata: {
          targetUserId: user.id,
          previousRole: null,
          newRole: defaultRole,
          action: "enterprise_sso_provisioned",
        },
      },
    });
  }

  return user;
}

export function defaultRoleForOrg(_org: Organization): "owner" | "admin" | "member" {
  // Future: allow org-level default SSO role configuration.
  return "member";
}
