import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { listSupportedProviders, listConfiguredProviders } from "../services/connectors/registry.js";
import { getSdk } from "../sdk/index.js";
import { setSessionCookies, clearSessionCookies } from "../plugins/auth.js";
import { findApplicationByClientId } from "../services/applications.js";
import type { Application } from "../db/schema.js";
import { buildOAuthErrorRedirect, buildOAuthErrorResponse } from "../lib/errors.js";

function isProvider(value: string): boolean {
  return listSupportedProviders().includes(value);
}

function randomState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function publicUrl(): string {
  return config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
}

function callbackRedirectUri(provider: string): string {
  return `${publicUrl()}/federation/${provider}/callback`;
}

function setFederationState(reply: FastifyReply, state: string, clientId?: string): void {
  reply.setCookie("fed_state", state, {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax" as const,
    domain: config.COOKIE_DOMAIN || undefined,
    maxAge: 600,
  });
  if (clientId) {
    reply.setCookie("fed_client_id", clientId, {
      path: "/",
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: "lax" as const,
      domain: config.COOKIE_DOMAIN || undefined,
      maxAge: 600,
    });
  }
}

function clearFederationCookies(reply: FastifyReply): void {
  const opts = {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax" as const,
    domain: config.COOKIE_DOMAIN || undefined,
  };
  reply.clearCookie("fed_state", opts);
  reply.clearCookie("fed_client_id", opts);
}

function redirectTargetUrl(clientId?: string, app?: Application): string {
  if (app?.redirectUris?.length) return app.redirectUris[0];
  return process.env.CLIENT_APP_URL || "http://localhost:5173";
}

const LinkIdentitySchema = z.object({
  providerType: z.string(),
  providerId: z.string().uuid(),
  externalSub: z.string(),
  email: z.string().email().optional(),
});

function sendResultError(reply: FastifyReply, result: { success: false; error: { statusCode?: number; message: string; code: string } }) {
  return reply.status(result.error.statusCode ?? 400).send({ error: result.error.message, code: result.error.code });
}

export default async function federationRoutes(app: FastifyInstance) {
  const sdk = getSdk();

  app.get("/:provider/start", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!isProvider(provider)) {
      return reply.status(400).send({ error: "Unsupported federation provider" });
    }
    const query = request.query as { client_id?: string; redirect_uri?: string };
    const state = randomState();
    setFederationState(reply, state, query.client_id);

    try {
      const result = await sdk.identity.getFederationAuthorizeUrl(provider, state, callbackRedirectUri(provider));
      if (!result.success) return sendResultError(reply, result);
      return reply.redirect(result.data.url);
    } catch (err) {
      request.log.error({ err }, "Federation start failed");
      clearFederationCookies(reply);
      const { statusCode, body } = buildOAuthErrorResponse(err);
      return reply.status(statusCode).send(body);
    }
  });

  app.get("/:provider/callback", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!isProvider(provider)) {
      return reply.status(400).send({ error: "Unsupported federation provider" });
    }

    const { code, state } = request.query as { code?: string; state?: string };
    const cookieState = request.cookies.fed_state;
    const clientId = request.cookies.fed_client_id;

    if (!code || !state || state !== cookieState) {
      clearFederationCookies(reply);
      return reply.redirect(`${redirectTargetUrl(clientId)}?error=${encodeURIComponent("Invalid federation state")}`);
    }
    clearFederationCookies(reply);

    try {
      const result = await sdk.identity.completeFederationLogin(provider, code, callbackRedirectUri(provider));
      if (!result.success) return sendResultError(reply, result);
      const app = clientId ? await findApplicationByClientId(clientId) : undefined;
      setSessionCookies(reply, result.data.tokens.accessToken, result.data.tokens.refreshToken, app?.clientId);
      return reply.redirect(redirectTargetUrl(clientId, app));
    } catch (err) {
      request.log.error({ err }, "Federation callback failed");
      clearSessionCookies(reply);
      const url = buildOAuthErrorRedirect(err, redirectTargetUrl(clientId), { state });
      return reply.redirect(url);
    }
  });

  app.get("/providers", async () => {
    return {
      providers: listConfiguredProviders(),
    };
  });

  app.post(
    "/link",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      const body = LinkIdentitySchema.parse(request.body);
      const result = await sdk.identity.linkUserIdentity(
        request.user!.id,
        body.providerId,
        body.providerType,
        body.externalSub,
        body.email
      );
      if (!result.success) return sendResultError(reply, result);
      return reply.status(201).send({ success: true });
    }
  );

  app.get("/identities", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    const { db } = await import("../db/index.js");
    const { userIdentities, identityProviders } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select({
        identity: userIdentities,
        provider: { id: identityProviders.id, name: identityProviders.name, providerType: identityProviders.providerType },
      })
      .from(userIdentities)
      .where(eq(userIdentities.userId, request.user!.id))
      .innerJoin(identityProviders, eq(userIdentities.providerId, identityProviders.id));
    return { identities: rows };
  });
}
