import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { buildConnector, listSupportedProviders } from "../services/connectors/registry.js";
import { upsertOAuthUser } from "../services/users.js";
import { createTokenSet } from "../services/tokens.js";
import { setSessionCookies, clearSessionCookies } from "../plugins/auth.js";
import { findApplicationByClientId } from "../services/applications.js";
import type { Application } from "../db/schema.js";
import { buildOAuthErrorRedirect, buildOAuthErrorResponse } from "../lib/errors.js";

const REDIRECT_TARGET = process.env.AUTH_SUCCESS_REDIRECT || "/chat";

const OAuthStartSchema = {
  querystring: {
    type: "object",
    properties: {
      client_id: { type: "string" },
    },
  },
};

function isProvider(value: string): boolean {
  return listSupportedProviders().includes(value);
}

function randomState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function setOAuthState(reply: FastifyReply, state: string): void {
  reply.setCookie("oauth_state", state, {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax" as const,
    domain: config.COOKIE_DOMAIN || undefined,
    maxAge: 600,
  });
}

function clearOAuthState(reply: FastifyReply): void {
  reply.clearCookie("oauth_state", {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax" as const,
    domain: config.COOKIE_DOMAIN || undefined,
  });
}

function setOAuthClientId(reply: FastifyReply, clientId?: string): void {
  if (!clientId) return;
  reply.setCookie("oauth_client_id", clientId, {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax" as const,
    domain: config.COOKIE_DOMAIN || undefined,
    maxAge: 600,
  });
}

function getOAuthClientId(request: FastifyRequest): string | undefined {
  return request.cookies.oauth_client_id;
}

function clearOAuthClientId(reply: FastifyReply): void {
  reply.clearCookie("oauth_client_id", {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax" as const,
    domain: config.COOKIE_DOMAIN || undefined,
  });
}

function publicUrl(): string {
  return config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
}

function callbackRedirectUri(provider: string): string {
  return `${publicUrl()}/auth/callback/${provider}`;
}

export default async function oauthRoutes(app: FastifyInstance) {
  app.get("/oauth/:provider", { schema: OAuthStartSchema }, async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!isProvider(provider)) {
      return reply.status(400).send({ error: "Unsupported provider" });
    }

    const query = request.query as { client_id?: string };
    const state = randomState();
    setOAuthState(reply, state);
    setOAuthClientId(reply, query.client_id);

    try {
      const connector = buildConnector(provider);
      const url = await connector.getAuthorizeUrl({
        state,
        redirectUri: callbackRedirectUri(provider),
        scopes: ["openid", "profile", "email"],
      });
      return reply.redirect(url);
    } catch (err) {
      request.log.error({ err }, "OAuth start failed");
      const { statusCode, body } = buildOAuthErrorResponse(err);
      return reply.status(statusCode).send(body);
    }
  });

  app.get("/callback/:provider", async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!isProvider(provider)) {
      return reply.status(400).send({ error: "Unsupported provider" });
    }

    const { code, state } = request.query as { code?: string; state?: string };
    const cookieState = request.cookies.oauth_state;
    const clientId = getOAuthClientId(request);

    if (!code || !state || state !== cookieState) {
      clearOAuthState(reply);
      clearOAuthClientId(reply);
      return reply.redirect(`${redirectTargetUrl(clientId)}?error=${encodeURIComponent("Invalid OAuth state")}`);
    }
    clearOAuthState(reply);
    clearOAuthClientId(reply);

    try {
      const connector = buildConnector(provider);
      const identity = await connector.exchangeCode(code, callbackRedirectUri(provider));

      const user = await upsertOAuthUser(identity, provider);

      const app = clientId ? await findApplicationByClientId(clientId) : undefined;
      const tokens = await createTokenSet(user, request.ip, request.headers["user-agent"], {
        appId: app?.id,
        orgId: app?.orgId,
        clientId: app?.clientId,
      });
      setSessionCookies(reply, tokens.accessToken, tokens.refreshToken, app?.clientId);

      await request.audit("oauth_callback", {
        provider,
        externalSub: identity.sub,
        appId: app?.id,
        orgId: app?.orgId,
      });

      return reply.redirect(redirectTargetUrl(clientId, app));
    } catch (err) {
      request.log.error({ err }, "OAuth callback failed");
      clearSessionCookies(reply);
      const url = buildOAuthErrorRedirect(err, redirectTargetUrl(clientId), { state });
      return reply.redirect(url);
    }
  });
}

function redirectTargetUrl(clientId?: string, app?: Application): string {
  if (app?.redirectUris?.length) {
    return app.redirectUris[0];
  }
  return process.env.CLIENT_APP_URL || "http://localhost:5173";
}
