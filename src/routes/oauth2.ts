import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import {
  storeAuthorizationCode,
  consumeAuthorizationCode,
  verifyPKCE,
  hasConsent,
  grantConsent,
  revokeConsent,
  createTokenResponse,
  findApplicationByClientId,
  verifyClientSecret,
} from "../services/oauth2.js";
import { findUserById } from "../services/users.js";
import { revokeRefreshToken, createApplicationAccessToken } from "../services/tokens.js";
import { fingerprintFromRequest } from "../services/devices.js";
import { rateLimit } from "../plugins/rateLimit.js";

const AuthorizeQuerySchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string().url(),
  response_type: z.literal("code"),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  nonce: z.string().optional(),
});

const TokenBodySchema = z.object({
  grant_type: z.enum(["authorization_code", "refresh_token", "client_credentials"]),
  code: z.string().optional(),
  redirect_uri: z.string().url().optional(),
  code_verifier: z.string().min(43).max(128).optional(),
  refresh_token: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
});

const ConsentBodySchema = z.object({
  client_id: z.string(),
  scopes: z.array(z.string()).default([]),
  grant: z.boolean(),
});

interface ClientCredentials {
  clientId?: string;
  clientSecret?: string;
}

function extractClientCredentials(request: FastifyRequest, body: ClientCredentials): ClientCredentials {
  const authHeader = request.headers.authorization;
  if (authHeader?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const [clientId, clientSecret] = decoded.split(":");
      return { clientId, clientSecret };
    } catch {
      return body;
    }
  }
  return body;
}

export default async function oauth2Routes(app: FastifyInstance) {
  app.get(
    "/authorize",
    {
      preHandler: [
        app.authenticate,
        rateLimit({ keyPrefix: "oauth2_authorize", maxAttempts: 10, windowSeconds: 60 }),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = AuthorizeQuerySchema.parse(request.query);

      const application = await findApplicationByClientId(query.client_id);
      if (!application) {
        return reply.status(400).send({ error: "invalid_client", error_description: "Unknown client" });
      }

      if (!application.redirectUris.includes(query.redirect_uri)) {
        return reply
          .status(400)
          .send({ error: "invalid_redirect_uri", error_description: "Redirect URI not registered" });
      }

      const scopes = query.scope ? query.scope.split(" ").filter(Boolean) : [];

      const consent = await hasConsent(request.user!.id, application.id, scopes);
      if (!consent) {
        return reply.status(403).send({
          error: "consent_required",
          error_description: "User consent required",
        });
      }

      const stored = await storeAuthorizationCode({
        appId: application.id,
        userId: request.user!.id,
        challenge: query.code_challenge,
        challengeMethod: query.code_challenge_method,
        redirectUri: query.redirect_uri,
        scopes,
        nonce: query.nonce,
      });

      const url = new URL(query.redirect_uri);
      url.searchParams.set("code", stored.code);
      if (query.state) url.searchParams.set("state", query.state);

      await request.audit("oauth2_authorize", {
        appId: application.id,
        clientId: application.clientId,
      });

      return reply.redirect(url.toString());
    }
  );

  app.post(
    "/token",
    {
      preHandler: [rateLimit({ keyPrefix: "oauth2_token", maxAttempts: 20, windowSeconds: 60 })],
    },
    async (request, reply) => {
      const parsedBody = TokenBodySchema.parse(request.body);
      const credentials = extractClientCredentials(request, {
        clientId: parsedBody.client_id,
        clientSecret: parsedBody.client_secret,
      });
      const body = { ...parsedBody, client_id: credentials.clientId, client_secret: credentials.clientSecret };

      if (body.grant_type === "authorization_code") {
        if (!body.code || !body.client_id || !body.redirect_uri) {
          return reply
            .status(400)
            .send({ error: "invalid_request", error_description: "code, client_id, and redirect_uri are required" });
        }

        const application = await findApplicationByClientId(body.client_id);
        if (!application) {
          return reply.status(400).send({ error: "invalid_client" });
        }

        const record = await consumeAuthorizationCode(body.code, application.id, body.redirect_uri);
        if (!record) {
          return reply.status(400).send({ error: "invalid_grant" });
        }

        const verifier = body.code_verifier;
        if (!verifier) {
          return reply.status(400).send({ error: "invalid_request", error_description: "PKCE verifier required" });
        }

        if (!verifyPKCE(record.challenge, record.challengeMethod, verifier)) {
          return reply.status(400).send({ error: "invalid_grant", error_description: "PKCE verification failed" });
        }

        const user = await findUserById(record.userId);
        if (!user) {
          return reply.status(400).send({ error: "invalid_grant" });
        }

        await request.audit("oauth2_token", {
          appId: application.id,
          clientId: application.clientId,
          grantType: "authorization_code",
        });

        const fingerprint = fingerprintFromRequest(request);
        return createTokenResponse(user, application, record.scopes, {
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          deviceFingerprint: fingerprint,
          nonce: record.nonce ?? undefined,
        });
      }

      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token) {
          return reply.status(400).send({ error: "invalid_request" });
        }

        // Lazy import to avoid circular dependency.
        const { rotateRefreshToken } = await import("../services/tokens.js");
        const tokens = await rotateRefreshToken(body.refresh_token, request.ip, request.headers["user-agent"]);
        if (!tokens) {
          return reply.status(400).send({ error: "invalid_grant" });
        }

        return {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          token_type: "Bearer",
          expires_in: config.ACCESS_TOKEN_TTL_SECONDS,
        };
      }

      if (body.grant_type === "client_credentials") {
        if (!body.client_id || !body.client_secret) {
          return reply.status(400).send({ error: "invalid_request", error_description: "client credentials required" });
        }

        const application = await verifyClientSecret(body.client_id, body.client_secret);
        if (!application) {
          return reply.status(401).send({ error: "invalid_client" });
        }

        const scopes = body.scope ? body.scope.split(" ").filter(Boolean) : [];
        const accessToken = await createApplicationAccessToken({
          appId: application.id,
          orgId: application.orgId,
          clientId: application.clientId,
          scopes,
        });

        await request.audit("oauth2_client_credentials", {
          appId: application.id,
          clientId: application.clientId,
        });

        return {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: config.ACCESS_TOKEN_TTL_SECONDS,
          scope: scopes.join(" "),
        };
      }

      return reply.status(400).send({ error: "unsupported_grant_type" });
    }
  );

  app.get(
    "/userinfo",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const user = request.user!;
      return {
        sub: user.id,
        email: user.email,
        email_verified: user.emailVerified,
        username: user.username,
        name: user.name,
        picture: user.avatarUrl,
      };
    }
  );

  app.post("/revoke", async (request, reply) => {
    const body = z.object({ token: z.string() }).parse(request.body);
    await revokeRefreshToken(body.token);
    await request.audit("oauth2_revoke", {});
    return { success: true };
  });

  app.post(
    "/consent",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = ConsentBodySchema.parse(request.body);
      const application = await findApplicationByClientId(body.client_id);
      if (!application) {
        return reply.status(400).send({ error: "invalid_client" });
      }

      if (body.grant) {
        await grantConsent(request.user!.id, application.id, body.scopes);
      } else {
        await revokeConsent(request.user!.id, application.id);
      }

      await request.audit("oauth2_consent", {
        appId: application.id,
        granted: body.grant,
        scopes: body.scopes,
      });

      return { success: true };
    }
  );
}
