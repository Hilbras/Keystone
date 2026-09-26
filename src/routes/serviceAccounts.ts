import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  createServiceAccount,
  findServiceAccountsByOrgId,
  findServiceAccountById,
  updateServiceAccount,
  setServiceAccountCertificate,
  revokeServiceAccount,
  listServiceAccountApiKeys,
} from "../services/serviceAccounts.js";
import { canonicalFingerprint, isValidFingerprint } from "../services/trustedProxies.js";
import { generateApiKey, hashApiKey } from "../services/tokens.js";
import { toPublicApiKey } from "../types.js";

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
});

/**
 * A SHA-256 client-certificate fingerprint, in hex or the colon-separated form
 * AWS ALB emits. Stored canonicalized so the two spellings cannot become two
 * distinct bindings for one certificate.
 */
const FingerprintSchema = z
  .string()
  .refine((value) => isValidFingerprint(value), {
    message: "fingerprint must be a SHA-256 digest (64 hex characters)",
  })
  .transform(canonicalFingerprint);

const CertificateSchema = z.object({
  /** `null` removes the binding, leaving API keys as the only credential. */
  fingerprint: FingerprintSchema.nullable(),
});

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export default async function serviceAccountRoutes(app: FastifyInstance) {
  app.post(
    "/organizations/:id/service-accounts",
    { preHandler: [app.requirePermission("service_account", "create")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = CreateSchema.parse(request.body);

      const record = await createServiceAccount({
        orgId: id,
        name: body.name,
        description: body.description,
      });

      await request.audit("service_account_created", { orgId: id, serviceAccountId: record.id });
      return reply.status(201).send(record);
    }
  );

  app.get(
    "/organizations/:id/service-accounts",
    { preHandler: [app.requirePermission("service_account", "read")] },
    async (request: FastifyRequest) => {
      const { id } = request.params as { id: string };
      const accounts = await findServiceAccountsByOrgId(id);
      return { serviceAccounts: accounts };
    }
  );

  app.get(
    "/organizations/:id/service-accounts/:accountId",
    { preHandler: [app.requirePermission("service_account", "read")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, accountId } = request.params as { id: string; accountId: string };
      const record = await findServiceAccountById(accountId, id);
      if (!record) {
        return reply.status(404).send({ error: "Service account not found" });
      }
      const keys = await listServiceAccountApiKeys(accountId);
      return { ...record, apiKeys: keys };
    }
  );

  app.patch(
    "/organizations/:id/service-accounts/:accountId",
    { preHandler: [app.requirePermission("service_account", "update")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, accountId } = request.params as { id: string; accountId: string };
      const body = UpdateSchema.parse(request.body);

      const updated = await updateServiceAccount(accountId, id, body);
      if (!updated) {
        return reply.status(404).send({ error: "Service account not found" });
      }

      await request.audit("service_account_updated", {
        orgId: id,
        serviceAccountId: updated.id,
      });
      return updated;
    }
  );

  app.put(
    "/organizations/:id/service-accounts/:accountId/certificate",
    { preHandler: [app.requirePermission("service_account", "update")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, accountId } = request.params as { id: string; accountId: string };
      const body = CertificateSchema.parse(request.body);

      const account = await findServiceAccountById(accountId, id);
      if (!account) {
        return reply.status(404).send({ error: "Service account not found" });
      }

      let updated;
      try {
        updated = await setServiceAccountCertificate(accountId, id, body.fingerprint);
      } catch {
        // The unique index on cert_fingerprint rejects a certificate that is
        // already bound elsewhere. Report it as a conflict, not a 500.
        return reply.status(409).send({
          error: "That certificate is already bound to another service account",
        });
      }
      if (!updated) {
        return reply.status(404).send({ error: "Service account not found" });
      }

      await request.audit(body.fingerprint ? "service_account_certificate_bound" : "service_account_certificate_unbound", {
        orgId: id,
        serviceAccountId: updated.id,
        fingerprint: body.fingerprint,
      });

      return updated;
    }
  );

  app.post(
    "/organizations/:id/service-accounts/:accountId/revoke",
    { preHandler: [app.requirePermission("service_account", "update")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, accountId } = request.params as { id: string; accountId: string };

      const account = await findServiceAccountById(accountId, id);
      if (!account) {
        return reply.status(404).send({ error: "Service account not found" });
      }

      const revoked = await revokeServiceAccount(accountId, id);
      if (!revoked) {
        return reply.status(409).send({ error: "Service account is already revoked" });
      }

      await request.audit("service_account_revoked", {
        orgId: id,
        serviceAccountId: revoked.id,
      });

      return revoked;
    }
  );

  app.post(
    "/organizations/:id/service-accounts/:accountId/api-keys",
    { preHandler: [app.requirePermission("api_key", "create")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, accountId } = request.params as { id: string; accountId: string };
      const body = CreateKeySchema.parse(request.body);

      const account = await findServiceAccountById(accountId, id);
      if (!account) {
        return reply.status(404).send({ error: "Service account not found" });
      }

      const { key, prefix } = generateApiKey();
      const record = await app.container.apiKeyRepository.create({
        serviceAccountId: account.id,
        orgId: id,
        name: body.name,
        prefix,
        keyHash: hashApiKey(key),
        scopes: body.scopes?.length ? body.scopes : ["api:read"],
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });

      await request.audit("api_key_created", {
        orgId: id,
        serviceAccountId: account.id,
        keyId: record.id,
      });

      return { key, apiKey: toPublicApiKey(record) };
    }
  );
}
