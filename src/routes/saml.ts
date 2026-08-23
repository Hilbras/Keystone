import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { ServiceProvider, IdentityProvider } from "samlify";
import { db } from "../db/index.js";
import { samlConnections, organizations, type SamlConnection } from "../db/schema.js";
import { provisionEnterpriseUser, defaultRoleForOrg } from "../services/enterpriseSso.js";
import { createTokenSet } from "../services/tokens.js";
import { setSessionCookies } from "../plugins/auth.js";
import { fingerprintFromRequest, recordDevice } from "../services/devices.js";
import { toPublicUser } from "../types.js";
import { config } from "../config.js";

const RelayStateSchema = z.object({
  connectionId: z.string(),
});

const DEFAULT_ATTRIBUTE_MAPPING: Record<string, string[]> = {
  email: [
    "email",
    "mail",
    "urn:oid:0.9.2342.19200300.100.1.3",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "http://schemas.microsoft.com/identity/claims/email",
  ],
  name: [
    "name",
    "displayName",
    "cn",
    "commonName",
    "urn:oid:2.16.840.1.113730.3.1.241",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "http://schemas.microsoft.com/identity/claims/displayname",
  ],
};

function buildSamlEntities(connection: SamlConnection) {
  if (!connection.idpEntityId || !connection.idpSsoUrl || !connection.idpCertificate) {
    throw new Error("SAML connection is missing IdP metadata");
  }

  const sp = ServiceProvider({
    entityID: connection.spEntityId,
    wantAssertionsSigned: true,
    wantMessageSigned: true,
    assertionConsumerService: [
      {
        Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
        Location: connection.spAcsUrl,
      },
    ],
  });

  const idp = IdentityProvider({
    entityID: connection.idpEntityId,
    signingCert: connection.idpCertificate,
    singleSignOnService: [
      {
        Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
        Location: connection.idpSsoUrl,
      },
    ],
  });

  return { sp, idp };
}

function getAttribute(
  attributes: Record<string, string | string[]> | undefined,
  key: string,
  mapping: Record<string, string[]>,
  fallbackMapping: Record<string, string[]>
): string | undefined {
  const candidates = mapping[key] ?? fallbackMapping[key] ?? [key];
  for (const candidate of candidates) {
    const value = attributes?.[candidate];
    if (value === undefined || value === null) continue;
    const normalized = Array.isArray(value) ? value[0] : value;
    if (normalized) return normalized;
  }
  return undefined;
}

function parseSamlAttributes(
  attributes: Record<string, string | string[]> | undefined,
  connection: SamlConnection
): { email?: string; name?: string } {
  const mapping = (connection.attributeMapping ?? {}) as Record<string, string[]>;
  return {
    email: getAttribute(attributes, "email", mapping, DEFAULT_ATTRIBUTE_MAPPING),
    name: getAttribute(attributes, "name", mapping, DEFAULT_ATTRIBUTE_MAPPING),
  };
}

function sanitizeSamlError(error: unknown): { statusCode: number; body: { error: string } } {
  const message = config.NODE_ENV === "development" && error instanceof Error ? error.message : "SAML validation failed";
  return { statusCode: 400, body: { error: message } };
}

export default async function samlRoutes(app: FastifyInstance) {
  app.get("/saml/:connectionId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.params as { connectionId: string };
    const [connection] = await db
      .select()
      .from(samlConnections)
      .where(and(eq(samlConnections.id, connectionId), eq(samlConnections.isActive, true)))
      .limit(1);

    if (!connection) {
      return reply.status(404).send({ error: "SAML connection not found" });
    }

    if (!connection.idpSsoUrl) {
      return reply.status(400).send({ error: "SAML connection missing IdP SSO URL" });
    }

    try {
      const { sp, idp } = buildSamlEntities(connection);
      const relayState = Buffer.from(JSON.stringify({ connectionId })).toString("base64url");
      const loginRequest = sp.createLoginRequest(idp, "redirect", { relayState });

      const url = new URL(connection.idpSsoUrl);
      url.searchParams.set("SAMLRequest", loginRequest.context);
      if (relayState) url.searchParams.set("RelayState", relayState);

      return reply.redirect(url.toString());
    } catch (err) {
      request.log.error({ err }, "Failed to build SAML login request");
      const { statusCode, body } = sanitizeSamlError(err);
      return reply.status(statusCode).send(body);
    }
  });

  app.post("/saml/acs", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { SAMLResponse?: string; RelayState?: string };
    if (!body.SAMLResponse) {
      return reply.status(400).send({ error: "Missing SAMLResponse" });
    }

    let relayState: { connectionId: string } | undefined;
    try {
      relayState = RelayStateSchema.parse(
        JSON.parse(Buffer.from(body.RelayState || "", "base64url").toString("utf8"))
      );
    } catch {
      return reply.status(400).send({ error: "Invalid RelayState" });
    }

    const [connection] = await db
      .select()
      .from(samlConnections)
      .where(and(eq(samlConnections.id, relayState.connectionId), eq(samlConnections.isActive, true)))
      .limit(1);

    if (!connection) {
      return reply.status(400).send({ error: "SAML connection not found" });
    }

    try {
      const { sp, idp } = buildSamlEntities(connection);
      const result = await sp.parseLoginResponse(idp, "post", { body });
      const claims = parseSamlAttributes(result.extract.attributes, connection);

      if (!claims.email) {
        return reply.status(400).send({ error: "SAML response did not contain an email" });
      }

      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, connection.orgId))
        .limit(1);

      const user = await provisionEnterpriseUser(
        connection.orgId,
        { email: claims.email, name: claims.name },
        org ? defaultRoleForOrg(org) : "member"
      );

      const fingerprint = fingerprintFromRequest(request);
      await recordDevice(user.id, fingerprint, request.ip, request.headers["user-agent"]);
      const tokens = await createTokenSet(
        user,
        request.ip,
        request.headers["user-agent"],
        { orgId: connection.orgId },
        fingerprint
      );
      setSessionCookies(reply, tokens.accessToken, tokens.refreshToken);

      await request.audit("saml_sso_login", {
        orgId: connection.orgId,
        connectionId: connection.id,
        userId: user.id,
      });

      return { user: toPublicUser(user) };
    } catch (err) {
      request.log.error({ err }, "SAML ACS validation failed");
      const { statusCode, body } = sanitizeSamlError(err);
      return reply.status(statusCode).send(body);
    }
  });

  app.get("/saml/:connectionId/metadata", async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.params as { connectionId: string };
    const [connection] = await db
      .select()
      .from(samlConnections)
      .where(and(eq(samlConnections.id, connectionId), eq(samlConnections.isActive, true)))
      .limit(1);

    if (!connection) {
      return reply.status(404).send({ error: "SAML connection not found" });
    }

    const metadata = `
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${connection.spEntityId}">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${connection.spAcsUrl}" index="0"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`.trim();

    return reply.header("Content-Type", "application/xml").send(metadata);
  });
}
