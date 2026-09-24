import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { oidcConnections, type OidcConnection } from "../db/schema.js";
import { encryptSecret } from "../services/secrets/index.js";

export type OidcConnectionListItem = {
  id: string;
  name: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  clientId: string;
  scopes: string[];
  isActive: boolean;
  createdAt: Date;
};

export interface OidcConnectionRepository {
  listByOrgId(orgId: string): Promise<OidcConnectionListItem[]>;
  findActiveByIdAndOrgId(id: string, orgId: string): Promise<OidcConnection | undefined>;
  updateClientSecret(id: string, clientSecret: string): Promise<boolean>;
  create(input: {
    orgId: string;
    name: string;
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint?: string;
    jwksUri?: string;
    clientId: string;
    clientSecret: string;
    scopes?: string[];
    attributeMapping?: Record<string, unknown>;
    isActive?: boolean;
  }): Promise<OidcConnection>;
  deleteByIdAndOrgId(id: string, orgId: string): Promise<OidcConnection | undefined>;
}

export class DrizzleOidcConnectionRepository implements OidcConnectionRepository {
  async listByOrgId(orgId: string) {
    return db
      .select({
        id: oidcConnections.id,
        name: oidcConnections.name,
        issuer: oidcConnections.issuer,
        authorizationEndpoint: oidcConnections.authorizationEndpoint,
        tokenEndpoint: oidcConnections.tokenEndpoint,
        userinfoEndpoint: oidcConnections.userinfoEndpoint,
        jwksUri: oidcConnections.jwksUri,
        clientId: oidcConnections.clientId,
        scopes: oidcConnections.scopes,
        isActive: oidcConnections.isActive,
        createdAt: oidcConnections.createdAt,
      })
      .from(oidcConnections)
      .where(eq(oidcConnections.orgId, orgId));
  }

  async findActiveByIdAndOrgId(id: string, orgId: string) {
    const [connection] = await db
      .select()
      .from(oidcConnections)
      .where(and(eq(oidcConnections.id, id), eq(oidcConnections.orgId, orgId), eq(oidcConnections.isActive, true)))
      .limit(1);
    return connection;
  }

  async updateClientSecret(id: string, clientSecret: string) {
    const [updated] = await db
      .update(oidcConnections)
      .set({ clientSecret: await encryptSecret(clientSecret), updatedAt: new Date() })
      .where(eq(oidcConnections.id, id))
      .returning({ id: oidcConnections.id });
    return Boolean(updated);
  }

  async create(input: {
    orgId: string;
    name: string;
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint?: string;
    jwksUri?: string;
    clientId: string;
    clientSecret: string;
    scopes?: string[];
    attributeMapping?: Record<string, unknown>;
    isActive?: boolean;
  }) {
    const [connection] = await db
      .insert(oidcConnections)
      .values({
        orgId: input.orgId,
        name: input.name,
        issuer: input.issuer,
        authorizationEndpoint: input.authorizationEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        userinfoEndpoint: input.userinfoEndpoint,
        jwksUri: input.jwksUri,
        clientId: input.clientId,
        clientSecret: await encryptSecret(input.clientSecret),
        scopes: input.scopes ?? ["openid", "profile", "email"],
        attributeMapping: input.attributeMapping ?? {},
        isActive: input.isActive ?? true,
      })
      .returning();
    return connection;
  }

  async deleteByIdAndOrgId(id: string, orgId: string) {
    const [record] = await db
      .delete(oidcConnections)
      .where(and(eq(oidcConnections.id, id), eq(oidcConnections.orgId, orgId)))
      .returning();
    return record;
  }
}
