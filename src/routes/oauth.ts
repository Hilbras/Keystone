import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { buildConnector, listSupportedProviders } from "../services/connectors/registry.js";
import { findIdentityProviderByType, upsertOAuthUser } from "../services/users.js";
import { createTokenSet } from "../services/tokens.js";
import { setSessionCookies, clearSessionCookies } from "../plugins/auth.js";
import { findApplicationByClientId } from "../services/applications.js";
import type { Application } from "../db/schema.js";
import { buildOAuthErrorRedirect, buildOAuthErrorResponse } from "../lib/errors.js";

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

/**
 * The OIDC nonce, kept in its own httpOnly cookie alongside `state`.
 *
 * `state` proves the callback belongs to a login this browser started, which is
 * CSRF protection. The nonce proves the *ID token* belongs to that same login.
 * Without it, any ID token the provider considers valid is accepted, including
 * one that was minted for a different user or session.
 */
function setOAuthNonce(reply: FastifyReply, nonce: string): void {
  reply.setCookie("oauth_nonce", nonce, {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax" as const,
    domain: config.COOKIE_DOMAIN || undefined,
    maxAge: 600,
  });
}

function clearOAuthNonce(reply: FastifyReply): void {
  reply.clearCookie("oauth_nonce", {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    domain: config.COOKIE_DOMAIN || undefined,
  });
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
    if (query.client_id && !(await findApplicationByClientId(query.client_id))) {
      return reply.status(400).send({ error: "Unknown application" });
    }
    const state = randomState();
    setOAuthState(reply, state);
    const nonce = randomState();
    setOAuthNonce(reply, nonce);
    setOAuthClientId(reply, query.client_id);

    try {
      const connector = buildConnector(provider);
      const url = await connector.getAuthorizeUrl({
        state,
        nonce,
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

  app.get("/callback/:provider", {
    preHandler: [
      rateLimit({
        keyPrefix: "oauth-callback",
        maxAttempts: config.LOGIN_MAX_ATTEMPTS,
        windowSeconds: config.LOGIN_WINDOW_SECONDS,
        // As above, for the other federation route.
        //
        // A Redis outage must not remove the limit on an endpoint worth
        // brute-forcing, so this falls back to a bounded per-process budget
        // rather than failing open.
        emergencyLocalLimit: true,
      }),
    ],
  }, async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!isProvider(provider)) {
      return reply.status(400).send({ error: "Unsupported provider" });
    }

    const { code, state } = request.query as { code?: string; state?: string };
    const cookieState = request.cookies.oauth_state;
    const expectedNonce = request.cookies.oauth_nonce;
    const clientId = getOAuthClientId(request);

    // A missing nonce is a failure rather than something to tolerate: this
    // browser always set one when it started the flow, so its absence means the
    // callback did not come from a flow this server initiated.
    if (!code || !state || state !== cookieState || !expectedNonce) {
      clearOAuthState(reply);
      clearOAuthNonce(reply);
      clearOAuthClientId(reply);
      return reply.redirect(`${redirectTargetUrl(clientId)}?error=${encodeURIComponent("Invalid OAuth state")}`);
    }
    clearOAuthState(reply);
    clearOAuthNonce(reply);
    clearOAuthClientId(reply);

    try {
      const connector = buildConnector(provider);
      const identity = await connector.exchangeCode(code, callbackRedirectUri(provider), { nonce: expectedNonce });

      const providerRecord = await findIdentityProviderByType(provider);
      const user = await upsertOAuthUser(identity, provider, providerRecord?.id);
      request.state.auditUserId = user.id;

      const app = clientId ? await findApplicationByClientId(clientId) : undefined;
      if (clientId && !app) {
        throw new Error("unknown_application");
      }
      const membership = app
        ? await request.server.container.organizationRepository.findMembership(app.orgId, user.id)
        : undefined;
      if (app && !membership) {
        throw new Error("not_member");
      }
      if (app && membership) {
        request.state.app = app;
        request.state.membership = membership;
        request.state.org = await request.server.container.organizationRepository.findById(app.orgId);
      }
      const tokens = await createTokenSet(user, request.ip, request.headers["user-agent"], {
        appId: app?.id,
        orgId: app?.orgId,
        clientId: app?.clientId,
      }, undefined, "oauth-authorize");
      setSessionCookies(reply, tokens.accessToken, tokens.refreshToken, app?.clientId);

      await request.audit("oauth_callback", {
        provider,
        externalSub: identity.sub,
        userId: user.id,
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
