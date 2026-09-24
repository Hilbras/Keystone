import { and, eq } from "drizzle-orm";
import { buildConnector } from "./connectors/registry.js";
import { upsertOAuthUser } from "./users.js";
import { createTokenSet } from "./tokens.js";
import { db } from "../db/index.js";
import { users, orgMemberships } from "../db/schema.js";
import type { User } from "../db/schema.js";
import type { IdentityConnector } from "./connectors/types.js";

export interface FederationApplicationContext {
  id: string;
  orgId: string;
  clientId: string;
}

export function getFederationConnector(providerType: string): IdentityConnector {
  return buildConnector(providerType);
}

export async function getFederationAuthorizeUrl(providerType: string, state: string, redirectUri: string): Promise<string> {
  const connector = getFederationConnector(providerType);
  return connector.getAuthorizeUrl({
    state,
    redirectUri,
    scopes: ["openid", "profile", "email"],
  });
}

export async function completeFederationLogin(
  providerType: string,
  code: string,
  redirectUri: string,
  application?: FederationApplicationContext
): Promise<{ user: User; tokens: { accessToken: string; refreshToken: string } }> {
  const connector = getFederationConnector(providerType);
  const identity = await connector.exchangeCode(code, redirectUri);
  const email = identity.email.toLowerCase().trim();

  if (application) {
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing && !existing.isActive) throw new Error("User account is deactivated");
    if (existing) {
      const [membership] = await db
        .select({ id: orgMemberships.id })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, application.orgId), eq(orgMemberships.userId, existing.id)))
        .limit(1);
      if (!membership) throw new Error("Federation user must be explicitly invited to the application organization");
    }
  }

  const user = await upsertOAuthUser(identity, providerType);
  if (application) {
    const [membership] = await db
      .select({ id: orgMemberships.id })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, application.orgId), eq(orgMemberships.userId, user.id)))
      .limit(1);
    if (!membership) {
      await db.insert(orgMemberships).values({ orgId: application.orgId, userId: user.id, role: "member" });
    }
  }
  const tokens = await createTokenSet(
    user,
    undefined,
    undefined,
    application
      ? { appId: application.id, orgId: application.orgId, clientId: application.clientId }
      : {}
  );
  return { user, tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } };
}
