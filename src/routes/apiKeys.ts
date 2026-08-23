import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import { generateApiKey, hashApiKey } from "../services/tokens.js";
import { toPublicUser } from "../types.js";

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
});

export default async function apiKeyRoutes(app: FastifyInstance) {
  app.post("/api-keys", { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = CreateKeySchema.parse(request.body);
    const user = request.user!;
    const orgId = request.state?.org?.id;
    const appId = request.state?.app?.id;

    const { key, prefix } = generateApiKey();
    const [record] = await db
      .insert(apiKeys)
      .values({
        userId: user.id,
        orgId: orgId ?? null,
        appId: appId ?? null,
        name: body.name,
        prefix,
        keyHash: hashApiKey(key),
        scopes: body.scopes?.length ? body.scopes : ["api:read"],
      })
      .returning();

    await request.audit("api_key_created", {
      keyId: record.id,
      name: record.name,
    });

    return { key, apiKey: record };
  });

  app.get("/api-keys", { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user!;
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        orgId: apiKeys.orgId,
        appId: apiKeys.appId,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, user.id));
    return { keys: rows };
  });

  app.delete("/api-keys/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const [record] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
      .returning();

    if (!record) {
      return reply.status(404).send({ error: "API key not found" });
    }

    await request.audit("api_key_revoked", { keyId: record.id, name: record.name });
    return { success: true };
  });

  app.get("/validate", { preHandler: [app.authenticateOrApiKey] }, async (request) => {
    const user = request.user!;
    return { valid: true, user: toPublicUser(user) };
  });
}
