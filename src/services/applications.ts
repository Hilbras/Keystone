import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, type Application } from "../db/schema.js";
import { generateClientSecret, hashClientSecret } from "./secrets.js";
import { cache } from "./cache.js";

function appCacheKey(clientId: string): string {
  return `app:clientId:${clientId}`;
}

export function generateClientId(): string {
  return `app_${crypto.randomBytes(16).toString("base64url")}`;
}

// Re-exported for callers that imported these helpers from this module.
export { generateClientSecret, hashClientSecret };

export async function createApplication(input: {
  orgId: string;
  name: string;
  redirectUris?: string[];
  allowedOrigins?: string[];
  clientId?: string;
  clientSecret?: string;
}): Promise<Application & { clientSecret: string }> {
  const clientSecret = input.clientSecret || generateClientSecret();
  const [app] = await db
    .insert(applications)
    .values({
      orgId: input.orgId,
      clientId: input.clientId || generateClientId(),
      clientSecretHash: hashClientSecret(clientSecret),
      name: input.name,
      redirectUris: input.redirectUris ?? [],
      allowedOrigins: input.allowedOrigins ?? [],
    })
    .returning();
  return { ...app, clientSecret };
}

export async function findApplicationByClientId(
  clientId: string
): Promise<Application | undefined> {
  const cached = await cache.get<Application>(appCacheKey(clientId));
  if (cached) return cached;

  const [app] = await db
    .select()
    .from(applications)
    .where(eq(applications.clientId, clientId))
    .limit(1);
  if (app) await cache.set(appCacheKey(clientId), app, 60);
  return app;
}

export async function findApplicationsByOrgId(orgId: string): Promise<Application[]> {
  return db.select().from(applications).where(eq(applications.orgId, orgId));
}

export async function updateApplication(
  appId: string,
  orgId: string,
  updates: Partial<{
    name: string;
    redirectUris: string[];
    allowedOrigins: string[];
    isActive: boolean;
    branding: Record<string, unknown>;
  }>
): Promise<Application | undefined> {
  const [updated] = await db
    .update(applications)
    .set(updates)
    .where(and(eq(applications.id, appId), eq(applications.orgId, orgId)))
    .returning();
  if (updated) await cache.del(appCacheKey(updated.clientId));
  return updated;
}

export async function verifyClientSecret(
  clientId: string,
  secret: string
): Promise<Application | undefined> {
  const app = await findApplicationByClientId(clientId);
  if (!app || !app.isActive) return undefined;
  if (app.clientSecretHash !== hashClientSecret(secret)) return undefined;
  return app;
}
