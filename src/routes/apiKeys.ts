import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { generateApiKey, hashApiKey } from "../services/tokens.js";
import { toPublicApiKey, toPublicUser } from "../types.js";

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
});

export default async function apiKeyRoutes(app: FastifyInstance) {
  app.post("/api-keys", { preHandler: [app.authenticate] }, async (request) => {
    const body = CreateKeySchema.parse(request.body);
    const user = request.user!;
    let orgId = user.defaultOrgId ?? null;
    let appId: string | undefined;
    if (request.state?.app) {
      const membership = await app.container.organizationRepository.findMembership(
        request.state.app.orgId,
        user.id
      );
      if (membership) {
        orgId = request.state.app.orgId;
        appId = request.state.app.id;
        request.state.membership = membership;
        request.state.org = await app.container.organizationRepository.findById(request.state.app.orgId);
      }
    } else if (orgId) {
      const membership = await app.container.organizationRepository.findMembership(orgId, user.id);
      if (membership) {
        request.state.membership = membership;
        request.state.org = await app.container.organizationRepository.findById(orgId);
      }
    }

    const { key, prefix } = generateApiKey();
    const record = await app.container.apiKeyRepository.create({
      userId: user.id,
      orgId: orgId ?? null,
      appId: appId ?? null,
      name: body.name,
      prefix,
      keyHash: hashApiKey(key),
      scopes: body.scopes?.length ? body.scopes : ["api:read"],
    });

    await request.audit("api_key_created", {
      keyId: record.id,
      name: record.name,
      orgId,
      appId,
    });

    return { key, apiKey: toPublicApiKey(record) };
  });

  app.get("/api-keys", { preHandler: [app.authenticate] }, async (request) => {
    const user = request.user!;
    const rows = await app.container.apiKeyRepository.listByUserId(user.id);
    return { keys: rows };
  });

  app.delete("/api-keys/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const record = await app.container.apiKeyRepository.revokeByKeyIdAndUserId(id, user.id);
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
