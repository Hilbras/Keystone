import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { samlConnections, type SamlConnection } from "../db/schema.js";

export type SamlConnectionListItem = {
  id: string;
  name: string;
  idpEntityId: string | null;
  idpSsoUrl: string | null;
  spEntityId: string;
  spAcsUrl: string;
  isActive: boolean;
  createdAt: Date;
};

export interface SamlConnectionRepository {
  listByOrgId(orgId: string): Promise<SamlConnectionListItem[]>;
  findById(id: string): Promise<SamlConnection | undefined>;
  findByIdAndOrgId(id: string, orgId: string): Promise<SamlConnection | undefined>;
  findActiveById(id: string): Promise<SamlConnection | undefined>;
  create(input: {
    orgId: string;
    name: string;
    idpEntityId?: string;
    idpSsoUrl?: string;
    idpCertificate?: string;
    spEntityId: string;
    spAcsUrl: string;
    attributeMapping?: Record<string, unknown>;
    isActive?: boolean;
  }): Promise<SamlConnection>;
  deleteByIdAndOrgId(id: string, orgId: string): Promise<SamlConnection | undefined>;
}

export class DrizzleSamlConnectionRepository implements SamlConnectionRepository {
  async listByOrgId(orgId: string) {
    return db
      .select({
        id: samlConnections.id,
        name: samlConnections.name,
        idpEntityId: samlConnections.idpEntityId,
        idpSsoUrl: samlConnections.idpSsoUrl,
        spEntityId: samlConnections.spEntityId,
        spAcsUrl: samlConnections.spAcsUrl,
        isActive: samlConnections.isActive,
        createdAt: samlConnections.createdAt,
      })
      .from(samlConnections)
      .where(eq(samlConnections.orgId, orgId));
  }

  async findById(id: string) {
    const [connection] = await db.select().from(samlConnections).where(eq(samlConnections.id, id)).limit(1);
    return connection;
  }

  async findByIdAndOrgId(id: string, orgId: string) {
    const [connection] = await db
      .select()
      .from(samlConnections)
      .where(and(eq(samlConnections.id, id), eq(samlConnections.orgId, orgId)))
      .limit(1);
    return connection;
  }

  async findActiveById(id: string) {
    const [connection] = await db.select().from(samlConnections).where(and(eq(samlConnections.id, id), eq(samlConnections.isActive, true))).limit(1);
    return connection;
  }

  async create(input: {
    orgId: string;
    name: string;
    idpEntityId?: string;
    idpSsoUrl?: string;
    idpCertificate?: string;
    spEntityId: string;
    spAcsUrl: string;
    attributeMapping?: Record<string, unknown>;
    isActive?: boolean;
  }) {
    const [connection] = await db
      .insert(samlConnections)
      .values({
        orgId: input.orgId,
        name: input.name,
        idpEntityId: input.idpEntityId,
        idpSsoUrl: input.idpSsoUrl,
        idpCertificate: input.idpCertificate,
        spEntityId: input.spEntityId,
        spAcsUrl: input.spAcsUrl,
        attributeMapping: input.attributeMapping ?? {},
        isActive: input.isActive ?? true,
      })
      .returning();
    return connection;
  }

  async deleteByIdAndOrgId(id: string, orgId: string) {
    const [record] = await db
      .delete(samlConnections)
      .where(and(eq(samlConnections.id, id), eq(samlConnections.orgId, orgId)))
      .returning();
    return record;
  }
}
