import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgMemberships, ssoIdentityLinks, type Organization } from "../db/schema.js";
import { slugifyUsername, ensureUniqueUsername } from "./users.js";
import { emit } from "./events/bus.js";

export interface EnterpriseUserClaims {
  email: string;
  name?: string;
  username?: string;
  externalId: string;
}

export interface EnterpriseConnectionContext {
  id: string;
  type: "saml" | "oidc";
}

export async function provisionEnterpriseUser(
  orgId: string,
  claims: EnterpriseUserClaims,
  connection: EnterpriseConnectionContext,
  defaultRole: "owner" | "admin" | "member" = "member"
) {
  const email = claims.email.toLowerCase().trim();
  const externalId = claims.externalId.trim();
  if (!["owner", "admin", "member"].includes(defaultRole)) {
    throw new Error("Invalid organization role");
  }
  if (!email || !externalId) {
    throw new Error("Enterprise SSO requires a verified email and external subject");
  }

  const [link] = await db
    .select()
    .from(ssoIdentityLinks)
    .where(
      and(
        eq(ssoIdentityLinks.connectionType, connection.type),
        eq(ssoIdentityLinks.connectionId, connection.id),
        eq(ssoIdentityLinks.externalSub, externalId)
      )
    )
    .limit(1);

  const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (byEmail && link && byEmail.id !== link.userId) {
    throw new Error("Enterprise SSO subject is already linked to a different user");
  }
  if (byEmail?.role === "owner") {
    throw new Error("Platform owners cannot authenticate through tenant SSO");
  }
  if (byEmail?.accountReviewRequired) {
    throw new Error("User account requires platform review");
  }

  let user = byEmail;
  if (link) {
    if (!user) {
      [user] = await db.select().from(users).where(eq(users.id, link.userId)).limit(1);
    }
  }
  if (!user) {
    if (byEmail || link) {
      throw new Error("Existing enterprise users require an explicit identity link");
    }
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
    await db.insert(ssoIdentityLinks).values({
      connectionType: connection.type,
      connectionId: connection.id,
      orgId,
      userId: user.id,
      externalSub: externalId,
    });
  }
  if (user?.role === "owner") {
    throw new Error("Platform owners cannot authenticate through tenant SSO");
  }
  if (user?.accountReviewRequired) {
    throw new Error("User account requires platform review");
  }
  if (byEmail && !link) {
    throw new Error("Existing enterprise users require an explicit identity link");
  }
  if (!user.isActive) {
    throw new Error("User account is deactivated");
  }

  const [existingMembership] = await db
    .select()
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, user.id)))
    .limit(1);

  if (!existingMembership) {
    if (byEmail || link) {
      throw new Error("Existing users must be explicitly invited before enterprise SSO login");
    }
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
