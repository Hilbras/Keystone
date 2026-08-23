import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgMemberships, type Organization } from "../db/schema.js";
import { slugifyUsername, ensureUniqueUsername } from "./users.js";

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

  let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

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
    .where(eq(orgMemberships.userId, user.id))
    .limit(1);

  if (!existingMembership) {
    await db.insert(orgMemberships).values({
      orgId,
      userId: user.id,
      role: defaultRole,
    });
  }

  return user;
}

export function defaultRoleForOrg(_org: Organization): "owner" | "admin" | "member" {
  // Future: allow org-level default SSO role configuration.
  return "member";
}
