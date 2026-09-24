import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { provisionEnterpriseUser, defaultRoleForOrg } from "../services/enterpriseSso.js";
import { createTokenSet } from "../services/tokens.js";
import { setSessionCookies, clearSessionCookies } from "../plugins/auth.js";
import { fingerprintFromRequest, recordDevice } from "../services/devices.js";
import { toSelfUser } from "../types.js";
import { buildOAuthErrorResponse } from "../lib/errors.js";
import { decryptSecret } from "../services/secrets/index.js";

const OIDC_STATE_COOKIE = "keystone_oidc_enterprise_state";

function publicUrl(): string {
  return process.env.AUTH_API_PUBLIC_URL || "http://localhost:4001";
}

function setStateCookie(reply: FastifyReply, state: string): void {
  reply.setCookie(OIDC_STATE_COOKIE, state, {
    path: "/",
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "lax",
    maxAge: 600,
  });
}

function getStateCookie(request: FastifyRequest): string | undefined {
  return request.cookies[OIDC_STATE_COOKIE];
}

function clearStateCookie(reply: FastifyReply): void {
  reply.clearCookie(OIDC_STATE_COOKIE, { path: "/" });
}

export default async function oidcEnterpriseRoutes(app: FastifyInstance) {
  app.get("/sso/oidc/:connectionId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.params as { connectionId: string };
    const orgId = (request.query as { orgId?: string }).orgId;
    if (!orgId) return reply.status(400).send({ error: "orgId is required" });
    const connection = await app.container.oidcConnectionRepository.findActiveByIdAndOrgId(connectionId, orgId);

    if (!connection) {
      return reply.status(404).send({ error: "OIDC connection not found" });
    }

    const state = crypto.randomBytes(24).toString("base64url");
    setStateCookie(reply, `${state}:${connectionId}:${orgId}`);

    const redirectUri = `${publicUrl()}/sso/oidc/${connectionId}/callback?orgId=${encodeURIComponent(orgId)}`;
    const url = new URL(connection.authorizationEndpoint);
    url.searchParams.set("client_id", connection.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", connection.scopes.join(" "));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);

    return reply.redirect(url.toString());
  });

  app.get("/sso/oidc/:connectionId/callback", async (request: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = request.params as { connectionId: string };
    const query = request.query as { code?: string; state?: string; orgId?: string; error?: string; error_description?: string };

    if (query.error) {
      clearSessionCookies(reply);
      const idpError = new Error(
        `Identity provider error: ${query.error}${query.error_description ? ` - ${query.error_description}` : ""}`
      );
      const { statusCode, body } = buildOAuthErrorResponse(idpError);
      return reply.status(statusCode).send(body);
    }

    const cookieState = getStateCookie(request);
    clearStateCookie(reply);

    if (!query.code || !query.state || !query.orgId || !cookieState) {
      return reply.status(400).send({ error: "Invalid OIDC state" });
    }
    const [cookieStateValue, cookieConnectionId, cookieOrgId] = cookieState.split(":");
    if (cookieStateValue !== query.state || cookieConnectionId !== connectionId || cookieOrgId !== query.orgId) {
      return reply.status(400).send({ error: "Invalid OIDC state" });
    }

    const connection = await app.container.oidcConnectionRepository.findActiveByIdAndOrgId(connectionId, query.orgId);

    if (!connection) {
      return reply.status(400).send({ error: "OIDC connection not found" });
    }

    const redirectUri = `${publicUrl()}/sso/oidc/${connectionId}/callback?orgId=${encodeURIComponent(query.orgId)}`;

    try {
      let clientSecret = connection.clientSecret;
      try {
        clientSecret = await decryptSecret(connection.clientSecret);
      } catch (error) {
        if (connection.clientSecret.startsWith("aes-256-gcm$")) throw error;
        clientSecret = connection.clientSecret;
        await app.container.oidcConnectionRepository.updateClientSecret(connection.id, clientSecret);
      }
      const tokenRes = await fetch(connection.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: connection.clientId,
          client_secret: clientSecret,
          code: query.code,
          redirect_uri: redirectUri,
        }).toString(),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`);
      }

      const tokenData = (await tokenRes.json()) as { access_token: string; id_token?: string };

      const userinfoRes = await fetch(
        connection.userinfoEndpoint ||
          connection.scopes.includes("openid")
          ? `${connection.issuer}/oauth/v2/userinfo`
          : `${connection.issuer}/userinfo`,
        {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }
      );

      if (!userinfoRes.ok) {
        throw new Error(`Userinfo request failed: ${userinfoRes.status}`);
      }

      const userinfo = (await userinfoRes.json()) as {
        email?: string;
        name?: string;
        preferred_username?: string;
      };

      if (!userinfo.email) {
        throw new Error("OIDC provider did not return an email");
      }

      const org = await app.container.organizationRepository.findById(connection.orgId);

      const user = await provisionEnterpriseUser(
        connection.orgId,
        {
          email: userinfo.email,
          name: userinfo.name,
          username: userinfo.preferred_username,
        },
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

      await request.audit("oidc_enterprise_login", {
        orgId: connection.orgId,
        connectionId: connection.id,
        userId: user.id,
      });

      return { user: toSelfUser(user) };
    } catch (err) {
      request.log.error({ err }, "OIDC enterprise callback failed");
      clearSessionCookies(reply);
      const { statusCode, body } = buildOAuthErrorResponse(err);
      return reply.status(statusCode).send(body);
    }
  });
}
