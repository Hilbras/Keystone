import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { generateApiKey, hashApiKey } from "../services/tokens.js";
import { toPublicApiKey, toPublicUser } from "../types.js";
import { knownScopes, validateScopes } from "../services/scopes.js";

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
});

export default async function apiKeyRoutes(app: FastifyInstance) {
  // Credential management is scope-checked, not merely authenticated. Minting a
  // key is the one operation a leaked key must not be able to repeat, and
  // revoking one is the operation an operator most needs when a key escapes.
  app.post(
    "/api-keys",
    { preHandler: [app.authenticate, app.requireScopes("api_keys:read")] },
    async (request, reply) => {
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

      // Scopes were previously stored exactly as supplied, so a caller could
      // record any string at all — including the literal "service_account",
      // which the scope guard used to treat as a wildcard. An unrecognised scope
      // is refused rather than dropped: silently discarding one hides a typo and
      // leaves the caller believing they hold something they do not.
      const scopeCheck = validateScopes(body.scopes, { principal: "user" });
      if (!scopeCheck.ok) {
        return reply.status(400).send({
          error: "Unknown API key scope",
          unknown: scopeCheck.unknown,
          known: knownScopes(),
        });
      }

      const { key, prefix } = generateApiKey();
      const record = await app.container.apiKeyRepository.create({
        userId: user.id,
        orgId: orgId ?? null,
        appId: appId ?? null,
        name: body.name,
        prefix,
        keyHash: hashApiKey(key),
        scopes: scopeCheck.scopes,
      });

      await request.audit("api_key_created", {
        keyId: record.id,
        name: record.name,
        orgId,
        appId,
        scopes: scopeCheck.scopes,
      });

      return { key, apiKey: toPublicApiKey(record) };
    }
  );

  app.get(
    "/api-keys",
    { preHandler: [app.authenticate, app.requireScopes("api_keys:read")] },
    async (request) => {
      const user = request.user!;
      const rows = await app.container.apiKeyRepository.listByUserId(user.id);
      return { keys: rows };
    }
  );

  app.delete(
    "/api-keys/:id",
    { preHandler: [app.authenticate, app.requireScopes("api_keys:revoke")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const record = await app.container.apiKeyRepository.revokeByKeyIdAndUserId(id, user.id);
      if (!record) {
        return reply.status(404).send({ error: "API key not found" });
      }

      await request.audit("api_key_revoked", { keyId: record.id, name: record.name });
      return { success: true };
    }
  );

  app.get(
    "/validate",
    { preHandler: [app.authenticateOrApiKey, app.requireScopes("profile:read")] },
    async (request) => {
      const user = request.user!;
      return { valid: true, user: toPublicUser(user) };
    }
  );
}
