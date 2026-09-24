import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ServiceProvider, IdentityProvider, setSchemaValidator } from "samlify";
import * as samlSchemaValidator from "@authenio/samlify-node-xmllint";
import type { SamlConnection } from "../db/schema.js";
import { provisionEnterpriseUser, defaultRoleForOrg } from "../services/enterpriseSso.js";
import { createTokenSet } from "../services/tokens.js";
import { setSessionCookies } from "../plugins/auth.js";
import { fingerprintFromRequest, recordDevice } from "../services/devices.js";
import { toSelfUser } from "../types.js";
import { config } from "../config.js";
import { escapeXml } from "./helpers.js";
import { redis } from "../services/redis.js";

setSchemaValidator(samlSchemaValidator);

const SAML_TRANSACTION_COOKIE = "keystone_saml_transaction";
const SAML_TRANSACTION_TTL_SECONDS = 600;
const relayStateSecret = config.INTERNAL_API_KEY || crypto.randomBytes(32).toString("base64url");

const RelayStateSchema = z.object({
  transactionId: z.string().min(32),
  connectionId: z.string().min(1),
  orgId: z.string().uuid(),
  nonce: z.string().min(16),
  signature: z.string().min(16),
});

type SamlTransaction = {
  connectionId: string;
  orgId: string;
  nonce: string;
  requestId: string;
  browserNonce: string;
};

function signRelayState(value: { transactionId: string; connectionId: string; orgId: string; nonce: string }): string {
  return crypto.createHmac("sha256", relayStateSecret).update(JSON.stringify(value)).digest("base64url");
}

function verifyRelayState(value: z.infer<typeof RelayStateSchema>): boolean {
  const unsigned = {
    transactionId: value.transactionId,
    connectionId: value.connectionId,
    orgId: value.orgId,
    nonce: value.nonce,
  };
  const expected = signRelayState(unsigned);
  const actualBuffer = Buffer.from(value.signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function transactionKey(transactionId: string): string {
  return `keystone:saml:transaction:${transactionId}`;
}

async function storeTransaction(transactionId: string, transaction: SamlTransaction): Promise<void> {
  const stored = await redis.set(
    transactionKey(transactionId),
    JSON.stringify(transaction),
    "EX",
    SAML_TRANSACTION_TTL_SECONDS,
    "NX"
  );
  if (stored !== "OK") throw new Error("SAML transaction collision");
}

async function getTransaction(transactionId: string): Promise<SamlTransaction | undefined> {
  const raw = await redis.get(transactionKey(transactionId));
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as SamlTransaction;
  } catch {
    return undefined;
  }
}

async function consumeTransaction(transactionId: string): Promise<SamlTransaction | undefined> {
  const raw = await redis.eval(
    "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
    1,
    transactionKey(transactionId)
  );
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as SamlTransaction;
  } catch {
    return undefined;
  }
}

function setTransactionCookie(reply: FastifyReply, browserNonce: string): void {
  reply.setCookie(SAML_TRANSACTION_COOKIE, browserNonce, {
    path: "/sso/saml/acs",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SECURE ? "none" : "lax",
    maxAge: SAML_TRANSACTION_TTL_SECONDS,
  });
}

function clearTransactionCookie(reply: FastifyReply): void {
  reply.clearCookie(SAML_TRANSACTION_COOKIE, { path: "/sso/saml/acs" });
}

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
    const orgId = (request.query as { orgId?: string }).orgId;
    if (!orgId) return reply.status(400).send({ error: "orgId is required" });
    const connection = await app.container.samlConnectionRepository.findActiveByIdAndOrgId(connectionId, orgId);

    if (!connection) {
      return reply.status(404).send({ error: "SAML connection not found" });
    }

    if (!connection.idpSsoUrl) {
      return reply.status(400).send({ error: "SAML connection missing IdP SSO URL" });
    }
    if (config.NODE_ENV === "production" && (!config.INTERNAL_API_KEY || config.INTERNAL_API_KEY.length < 32)) {
      return reply.status(503).send({ error: "SAML transaction signing is not configured" });
    }

    try {
      const { sp, idp } = buildSamlEntities(connection);
      const transactionId = crypto.randomBytes(24).toString("base64url");
      const browserNonce = crypto.randomBytes(24).toString("base64url");
      const relayPayload = {
        transactionId,
        connectionId,
        orgId,
        nonce: crypto.randomBytes(16).toString("base64url"),
      };
      const relayState = Buffer.from(
        JSON.stringify({ ...relayPayload, signature: signRelayState(relayPayload) })
      ).toString("base64url");
      const loginRequest = sp.createLoginRequest(idp, "redirect", { relayState });
      await storeTransaction(transactionId, {
        connectionId,
        orgId,
        nonce: relayPayload.nonce,
        requestId: loginRequest.id,
        browserNonce,
      });
      setTransactionCookie(reply, browserNonce);

      const url = new URL(connection.idpSsoUrl);
      url.searchParams.set("SAMLRequest", loginRequest.context);
      url.searchParams.set("RelayState", relayState);

      return reply.redirect(url.toString());
    } catch (err) {
      clearTransactionCookie(reply);
      request.log.error({ err }, "Failed to build SAML login request");
      const { statusCode, body } = sanitizeSamlError(err);
      return reply.status(statusCode).send(body);
    }
  });

  app.post("/saml/acs", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { SAMLResponse?: string; RelayState?: string };
    if (!body.SAMLResponse) {
      clearTransactionCookie(reply);
      return reply.status(400).send({ error: "Missing SAMLResponse" });
    }

    let relayState: z.infer<typeof RelayStateSchema> | undefined;
    try {
      relayState = RelayStateSchema.parse(
        JSON.parse(Buffer.from(body.RelayState || "", "base64url").toString("utf8"))
      );
    } catch {
      clearTransactionCookie(reply);
      return reply.status(400).send({ error: "Invalid RelayState" });
    }
    if (!relayState || !verifyRelayState(relayState)) {
      clearTransactionCookie(reply);
      return reply.status(400).send({ error: "Invalid RelayState" });
    }

    const browserNonce = request.cookies[SAML_TRANSACTION_COOKIE];
    if (!browserNonce) {
      clearTransactionCookie(reply);
      return reply.status(400).send({ error: "Invalid SAML transaction" });
    }
    const transaction = await getTransaction(relayState.transactionId);
    if (
      !transaction ||
      transaction.connectionId !== relayState.connectionId ||
      transaction.orgId !== relayState.orgId ||
      transaction.nonce !== relayState.nonce ||
      transaction.browserNonce.length !== browserNonce.length ||
      !crypto.timingSafeEqual(Buffer.from(transaction.browserNonce), Buffer.from(browserNonce))
    ) {
      clearTransactionCookie(reply);
      return reply.status(400).send({ error: "Invalid SAML transaction" });
    }

    const connection = await app.container.samlConnectionRepository.findActiveByIdAndOrgId(
      relayState.connectionId,
      relayState.orgId
    );

    if (!connection) {
      return reply.status(400).send({ error: "SAML connection not found" });
    }

    let transactionClaimed = false;
    try {
      const { sp, idp } = buildSamlEntities(connection);
      const result = await sp.parseLoginResponse(idp, "post", { body });
      const response = result.extract.response as { InResponseTo?: string };
      if (response.InResponseTo !== transaction.requestId) {
        throw new Error("SAML response request ID mismatch");
      }
      const claims = parseSamlAttributes(result.extract.attributes, connection);

      if (!claims.email) {
        return reply.status(400).send({ error: "SAML response did not contain an email" });
      }

      const claimedTransaction = await consumeTransaction(relayState.transactionId);
      if (!claimedTransaction || claimedTransaction.requestId !== transaction.requestId) {
        clearTransactionCookie(reply);
        return reply.status(400).send({ error: "SAML transaction already consumed" });
      }
      transactionClaimed = true;
      clearTransactionCookie(reply);

      const org = await app.container.organizationRepository.findById(connection.orgId);

      const user = await provisionEnterpriseUser(
        connection.orgId,
        { email: claims.email, name: claims.name },
        org ? defaultRoleForOrg(org) : "member"
      );
      request.user = user;
      if (org) request.state.org = org;

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

      return { user: toSelfUser(user) };
    } catch (err) {
      if (transactionClaimed) clearTransactionCookie(reply);
      request.log.error({ err }, "SAML ACS validation failed");
      const { statusCode, body } = sanitizeSamlError(err);
      return reply.status(statusCode).send(body);
    }
  });

  app.get("/saml/:connectionId/metadata", async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.params as { connectionId: string };
    const orgId = (request.query as { orgId?: string }).orgId;
    if (!orgId) return reply.status(400).send({ error: "orgId is required" });
    const connection = await app.container.samlConnectionRepository.findActiveByIdAndOrgId(connectionId, orgId);

    if (!connection) {
      return reply.status(404).send({ error: "SAML connection not found" });
    }

    const metadata = `
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(connection.spEntityId)}">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(connection.spAcsUrl)}" index="0"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`.trim();

    return reply.header("Content-Type", "application/xml").send(metadata);
  });
}
