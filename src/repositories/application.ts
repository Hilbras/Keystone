import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, type Application } from "../db/schema.js";
import { generateClientSecret, hashClientSecret } from "../services/secrets.js";
import type {
  ApplicationRepository,
  CreateApplicationInput,
  UpdateApplicationInput,
} from "./types.js";

export class DrizzleApplicationRepository implements ApplicationRepository {
  private generateClientId(): string {
    return `app_${crypto.randomBytes(16).toString("base64url")}`;
  }

  async create(input: CreateApplicationInput): Promise<Application & { clientSecret: string }> {
    const clientSecret = input.clientSecret || generateClientSecret();
    const [app] = await db
      .insert(applications)
      .values({
        orgId: input.orgId,
        clientId: input.clientId || this.generateClientId(),
        clientSecretHash: hashClientSecret(clientSecret),
        name: input.name,
        redirectUris: input.redirectUris ?? [],
        allowedOrigins: input.allowedOrigins ?? [],
      })
      .returning();
    return { ...app, clientSecret };
  }

  async findByClientId(clientId: string): Promise<Application | undefined> {
    const [app] = await db
      .select()
      .from(applications)
      .where(eq(applications.clientId, clientId))
      .limit(1);
    return app;
  }

  async listByOrgId(orgId: string): Promise<Application[]> {
    return db.select().from(applications).where(eq(applications.orgId, orgId));
  }

  async update(
    appId: string,
    orgId: string,
    input: UpdateApplicationInput
  ): Promise<Application | undefined> {
    const [updated] = await db
      .update(applications)
      .set(input)
      .where(and(eq(applications.id, appId), eq(applications.orgId, orgId)))
      .returning();
    return updated;
  }

  async verifyClientSecret(clientId: string, secret: string): Promise<Application | undefined> {
    const [app] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.clientId, clientId), eq(applications.isActive, true)))
      .limit(1);

    if (!app) return undefined;
    if (app.clientSecretHash !== hashClientSecret(secret)) return undefined;
    return app;
  }
}
