import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireOrganizationRole } from "./helpers.js";
import { config } from "../../config.js";
import { escapeXml } from "../helpers.js";
import { toPublicOidcConnection, toPublicSamlConnection } from "../../types.js";
import { validateSsoEndpoint } from "../../services/ssoEndpointPolicy.js";
import { ScimConnectionService } from "../../services/scimCredentials.js";
import { sendResultError } from "../helpers.js";

const ScimConnectionSchema = z.object({
  name: z.string().min(1).max(255),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  rotationGraceSeconds: z.number().int().min(0).max(30 * 24 * 3600).optional(),
});

const ScimRotateSchema = z.object({
  rotationGraceSeconds: z.number().int().min(0).max(30 * 24 * 3600).optional(),
});

const SamlConnectionSchema = z.object({
  name: z.string().min(1).max(255),
  idpEntityId: z.string().min(1).optional(),
  idpSsoUrl: z.string().url().optional(),
  idpCertificate: z.string().optional(),
  spEntityId: z.string().min(1),
  spAcsUrl: z.string().url(),
  attributeMapping: z.record(z.string(), z.array(z.string())).optional(),
  isActive: z.boolean().optional(),
});

const OidcConnectionSchema = z.object({
  name: z.string().min(1).max(255),
  issuer: z.string().url(),
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  userinfoEndpoint: z.string().url().optional(),
  jwksUri: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  attributeMapping: z.record(z.string(), z.array(z.string())).optional(),
  isActive: z.boolean().optional(),
});

export default async function ssoRoutes(app: FastifyInstance) {
  const requireSsoManager = requireOrganizationRole(["owner", "admin"], { resource: "sso_connection", action: "manage" });
  const requireSsoReader = requireOrganizationRole(["owner", "admin", "member"], { resource: "sso_connection", action: "read" });
  // Issuing, rotating, and revoking a SCIM credential is owner-only: a SCIM
  // token provisions and deactivates tenant users, so it must not be mintable
  // by a mere admin.
  const requireSsoOwner = requireOrganizationRole(["owner"], { resource: "sso_connection", action: "manage" });
  const scimCredentials = new ScimConnectionService(app.container.scimConnectionRepository);

  // SAML connections.
  app.get(
    "/organizations/:id/saml-connections",
    { preHandler: [requireSsoReader] },
    async (request) => {
      const { id } = request.params as { id: string };
      const connections = await app.container.samlConnectionRepository.listByOrgId(id);
      return { connections };
    }
  );

  app.post(
    "/organizations/:id/saml-connections",
    { preHandler: [requireSsoManager] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = SamlConnectionSchema.parse(request.body);
      try {
        if (body.idpSsoUrl) validateSsoEndpoint(body.idpSsoUrl, "idpSsoUrl");
        validateSsoEndpoint(body.spAcsUrl, "spAcsUrl");
      } catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : "Invalid SAML endpoint" });
      }
      const connection = await app.container.samlConnectionRepository.create({ orgId: id, ...body });
      await request.audit("saml_connection_created", { orgId: id, connectionId: connection.id });
      return reply.status(201).send(toPublicSamlConnection(connection));
    }
  );

  app.get(
    "/organizations/:id/saml-connections/:connectionId/metadata",
    { preHandler: [requireSsoReader] },
    async (request, reply) => {
      const { id, connectionId } = request.params as { id: string; connectionId: string };
      const connection = await app.container.samlConnectionRepository.findByIdAndOrgId(connectionId, id);
      if (!connection) return reply.status(404).send({ error: "Connection not found" });

      const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(connection.spEntityId)}">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(connection.spAcsUrl)}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
      return reply.header("Content-Type", "application/xml").send(metadata);
    }
  );

  app.delete(
    "/organizations/:id/saml-connections/:connectionId",
    { preHandler: [requireSsoManager] },
    async (request, reply) => {
      const { id, connectionId } = request.params as { id: string; connectionId: string };
      const record = await app.container.samlConnectionRepository.deleteByIdAndOrgId(connectionId, id);
      if (!record) return reply.status(404).send({ error: "Connection not found" });
      await request.audit("saml_connection_deleted", { orgId: id, connectionId: record.id });
      return { success: true };
    }
  );

  // OIDC connections.
  app.get(
    "/organizations/:id/oidc-connections",
    { preHandler: [requireSsoReader] },
    async (request) => {
      const { id } = request.params as { id: string };
      const connections = await app.container.oidcConnectionRepository.listByOrgId(id);
      return { connections };
    }
  );

  app.post(
    "/organizations/:id/oidc-connections",
    { preHandler: [requireSsoManager] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = OidcConnectionSchema.parse(request.body);
      try {
        validateSsoEndpoint(body.issuer, "issuer");
        validateSsoEndpoint(body.authorizationEndpoint, "authorizationEndpoint");
        validateSsoEndpoint(body.tokenEndpoint, "tokenEndpoint");
        if (body.userinfoEndpoint) validateSsoEndpoint(body.userinfoEndpoint, "userinfoEndpoint");
        if (body.jwksUri) validateSsoEndpoint(body.jwksUri, "jwksUri");
      } catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : "Invalid OIDC endpoint" });
      }
      const connection = await app.container.oidcConnectionRepository.create({ orgId: id, ...body });
      await request.audit("oidc_connection_created", { orgId: id, connectionId: connection.id });
      return reply.status(201).send(toPublicOidcConnection(connection));
    }
  );

  app.delete(
    "/organizations/:id/oidc-connections/:connectionId",
    { preHandler: [requireSsoManager] },
    async (request, reply) => {
      const { id, connectionId } = request.params as { id: string; connectionId: string };
      const record = await app.container.oidcConnectionRepository.deleteByIdAndOrgId(connectionId, id);
      if (!record) return reply.status(404).send({ error: "Connection not found" });
      await request.audit("oidc_connection_deleted", { orgId: id, connectionId: record.id });
      return { success: true };
    }
  );

  // --- SCIM connections --------------------------------------------------
  //
  // A SCIM credential belongs to exactly one organization. There is no global
  // SCIM configuration, and the bearer token is returned only once, at creation
  // or rotation; afterwards only its hint is visible.

  app.get(
    "/organizations/:id/scim-config",
    { preHandler: [requireSsoReader] },
    async (request) => {
      const { id } = request.params as { id: string };
      const base = config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
      const connections = await app.container.scimConnectionRepository.listByOrg(id);
      const active = connections.find((c) => c.revokedAt === null) ?? null;

      return {
        enabled: active !== null,
        baseUrl: `${base}/scim/v2`,
        orgId: id,
        activeConnection: active ? publicScimConnection(active) : null,
        connectionCount: connections.length,
      };
    }
  );

  app.get(
    "/organizations/:id/scim-connections",
    { preHandler: [requireSsoReader] },
    async (request) => {
      const { id } = request.params as { id: string };
      const connections = await app.container.scimConnectionRepository.listByOrg(id);
      return { connections: connections.map(publicScimConnection) };
    }
  );

  app.post(
    "/organizations/:id/scim-connections",
    { preHandler: [requireSsoOwner] },
    async (request, reply) => {
      const { id: orgId } = request.params as { id: string };
      const body = ScimConnectionSchema.parse(request.body);

      const organization = await app.container.organizationRepository.findById(orgId);
      if (!organization) return reply.status(404).send({ error: "Organization not found" });

      const result = await scimCredentials.create({
        orgId,
        name: body.name,
        createdByUserId: request.user?.id,
        options: {
          expiresInDays: body.expiresInDays,
          rotationGraceSeconds: body.rotationGraceSeconds,
        },
      });
      if (!result.success) return sendResultError(reply, result);

      const connection = await app.container.scimConnectionRepository.findById(
        result.data.connectionId
      );
      await request.audit("scim_connection_created", {
        orgId,
        connectionId: result.data.connectionId,
        name: body.name,
      });

      // The token is shown exactly once and is never recoverable afterwards.
      return reply.status(201).send({
        ...publicScimConnection(connection!),
        token: result.data.token,
        warning: "Store this token now. It cannot be retrieved again.",
      });
    }
  );

  app.post(
    "/organizations/:id/scim-connections/:connectionId/rotate",
    { preHandler: [requireSsoOwner] },
    async (request, reply) => {
      const { id: orgId, connectionId } = request.params as { id: string; connectionId: string };
      const body = ScimRotateSchema.parse(request.body ?? {});

      const connection = await app.container.scimConnectionRepository.findById(connectionId);
      if (!connection || connection.orgId !== orgId) {
        return reply.status(404).send({ error: "SCIM connection not found" });
      }

      const result = await scimCredentials.rotate(connectionId, {
        rotationGraceSeconds: body.rotationGraceSeconds,
      });
      if (!result.success) return sendResultError(reply, result);

      await request.audit("scim_connection_rotated", {
        orgId,
        connectionId,
        previousTokenValidUntil: result.data.previousTokenValidUntil.toISOString(),
      });

      return {
        connectionId,
        token: result.data.token,
        tokenHint: result.data.tokenHint,
        previousTokenValidUntil: result.data.previousTokenValidUntil.toISOString(),
        warning: "Store this token now. It cannot be retrieved again.",
      };
    }
  );

  app.delete(
    "/organizations/:id/scim-connections/:connectionId",
    { preHandler: [requireSsoOwner] },
    async (request, reply) => {
      const { id: orgId, connectionId } = request.params as { id: string; connectionId: string };
      const connection = await app.container.scimConnectionRepository.findById(connectionId);
      if (!connection || connection.orgId !== orgId) {
        return reply.status(404).send({ error: "SCIM connection not found" });
      }

      const result = await scimCredentials.revoke(connectionId);
      if (!result.success) return sendResultError(reply, result);

      await request.audit("scim_connection_revoked", { orgId, connectionId });
      return reply.status(204).send();
    }
  );
}

/** Never expose token material, only a short hint for identification. */
function publicScimConnection(connection: {
  id: string;
  orgId: string;
  name: string;
  tokenHint: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastRotatedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: connection.id,
    organizationId: connection.orgId,
    name: connection.name,
    tokenHint: connection.tokenHint,
    expiresAt: connection.expiresAt,
    revokedAt: connection.revokedAt,
    lastRotatedAt: connection.lastRotatedAt,
    lastUsedAt: connection.lastUsedAt,
    createdAt: connection.createdAt,
  };
}
