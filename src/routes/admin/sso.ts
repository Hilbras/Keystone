import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireOrganizationRole } from "./helpers.js";
import { config } from "../../config.js";
import { escapeXml } from "../helpers.js";
import { toPublicOidcConnection, toPublicSamlConnection } from "../../types.js";
import { validateSsoEndpoint } from "../../services/ssoEndpointPolicy.js";

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

  // SCIM config.
  app.get(
    "/organizations/:id/scim-config",
    { preHandler: [requireSsoReader] },
    async (request) => {
      const { id } = request.params as { id: string };
      const base = config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
      return {
        enabled: !!process.env.SCIM_BEARER_TOKEN,
        baseUrl: `${base}/scim/v2`,
        orgId: id,
      };
    }
  );
}
