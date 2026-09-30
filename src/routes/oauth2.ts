import { z } from "zod";
import { isRedirectUriRegistered, validateRedirectUri } from "../services/redirectUri.js";

/**
 * A redirect URI must survive the same validation at use time as at registration
 * time, so a value that could never have been registered is also refused here.
 */
const redirectUriParam = z.string().superRefine((value, ctx) => {
  const result = validateRedirectUri(value);
  if (!result.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
});
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import {
  storeAuthorizationCode,
  consumeAuthorizationCode,
  peekAuthorizationCode,
  verifyPKCE,
  requiresPkce,
  findConsent,
  resolveEffectiveScopes,
  grantConsent,
  revokeConsent,
  createTokenResponse,
  findApplicationByClientId,
  verifyClientSecret,
} from "../services/oauth2.js";
import { findUserById } from "../services/users.js";
import {
  revokeRefreshToken,
  createApplicationAccessToken,
  rotateRefreshToken,
  MfaRequiredError,
  type MfaAssertion,
} from "../services/tokens.js";
import { fingerprintFromRequest } from "../services/devices.js";
import { rateLimit } from "../plugins/rateLimit.js";

const AuthorizeQuerySchema = z.object({
  client_id: z.string(),
  redirect_uri: redirectUriParam,
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
  redirect_uri: redirectUriParam.optional(),
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

const MFA_ASSERTIONS = new Set<string>(["totp", "backup_code", "webauthn", "session"]);

/**
 * The MFA factor is copied out of a verified token into a column guarded by a
 * CHECK constraint, so it must be validated at runtime rather than cast.
 * An unrecognised value is treated as "no factor recorded", which fails closed.
 */
function asMfaAssertion(value: string | null | undefined): MfaAssertion | undefined {
  return value && MFA_ASSERTIONS.has(value) ? (value as MfaAssertion) : undefined;
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
        rateLimit({
        keyPrefix: "oauth2_authorize",
        maxAttempts: 10,
        windowSeconds: 60,
        // A Redis outage must not remove the limit on an endpoint worth brute-forcing.
        emergencyLocalLimit: true,
      }),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = AuthorizeQuerySchema.parse(request.query);

      const application = await findApplicationByClientId(query.client_id);
      if (!application) {
        return reply.status(400).send({ error: "invalid_client", error_description: "Unknown client" });
      }

      const membership = await app.container.organizationRepository.findMembership(
        application.orgId,
        request.user!.id
      );
      if (!membership) {
        await request.audit("unauthorized_access", {
          action: "oauth_application_tenant_membership",
          appId: application.id,
          orgId: application.orgId,
        });
        return reply.status(403).send({
          error: "not_member",
          error_description: "You are not a member of the application organization",
        });
      }

      // Exact string comparison, via the shared helper so registration-time and
      // use-time rules cannot drift apart.
      if (!isRedirectUriRegistered(application.redirectUris, query.redirect_uri)) {
        return reply
          .status(400)
          .send({ error: "invalid_redirect_uri", error_description: "Redirect URI not registered" });
      }

      // A client that cannot keep a secret gets no protection from the
      // client-authentication step, so PKCE is not optional for it: an
      // intercepted code would otherwise be redeemable by whoever intercepted
      // it. Reject here rather than at /token, so the client learns before the
      // user is redirected.
      const pkceRequired = requiresPkce(application.clientSecretHash);
      if (pkceRequired && !query.code_challenge) {
        return reply.status(400).send({
          error: "invalid_request",
          error_description: "code_challenge is required for this client",
        });
      }
      if (query.code_challenge && query.code_challenge_method !== "S256") {
        return reply.status(400).send({
          error: "invalid_request",
          error_description: "code_challenge_method must be S256; plain is not accepted",
        });
      }

      request.state.membership = membership;
      request.state.org = await app.container.organizationRepository.findById(application.orgId);
      const scopes = query.scope ? query.scope.split(" ").filter(Boolean) : [];

      // Effective scopes are the intersection of registered, requested, and
      // consented. An unregistered or unconsented scope is refused outright
      // rather than quietly dropped, so a client asking for more than it has is
      // visible instead of silently downgraded.
      const consentRecord = await findConsent(request.user!.id, application.id);
      const resolved = resolveEffectiveScopes({
        requested: scopes,
        allowed: application.allowedScopes ?? [],
        consented: consentRecord ? consentRecord.scopes : [],
      });

      if (!resolved.ok) {
        await request.audit("unauthorized_access", {
          action: "oauth_scope_not_registered",
          appId: application.id,
          orgId: application.orgId,
          scope: resolved.scope,
        });
        return reply.status(400).send({
          error: resolved.error,
          error_description: `Scope "${resolved.scope}" is not available to this client`,
        });
      }

      if (!consentRecord && resolved.scopes.length > 0) {
        return reply.status(403).send({
          error: "consent_required",
          error_description: "User consent required",
        });
      }

      // The authorization code inherits the second factor of the session that
      // approved it, so the token exchange cannot launder an unverified login.
      const sessionMfaFactor = asMfaAssertion(request.authClaims?.mfa_factor);

      const stored = await storeAuthorizationCode({
        appId: application.id,
        userId: request.user!.id,
        challenge: query.code_challenge,
        challengeMethod: query.code_challenge_method,
        redirectUri: query.redirect_uri,
        scopes: resolved.scopes,
        nonce: query.nonce,
        ...(sessionMfaFactor ? { mfaFactor: sessionMfaFactor } : {}),
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
      preHandler: [
        rateLimit({
          keyPrefix: "oauth2_token",
          maxAttempts: 20,
          windowSeconds: 60,
          // A Redis outage must not remove the limit on an endpoint worth brute-forcing.
          emergencyLocalLimit: true,
        }),
      ],
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

        // RFC 6749 3.2.1: a confidential client must authenticate at the token
        // endpoint. This grant previously looked the client up and went straight
        // to redeeming the code, so client authentication was skipped entirely
        // and the code plus its PKCE verifier were the only factors. A public
        // client is exempt because it has no secret to present -- PKCE is what it
        // authenticates with, and that is enforced immediately below.
        const authenticatesWithSecret = !requiresPkce(application.clientSecretHash);
        if (authenticatesWithSecret) {
          const authenticated = await verifyClientSecret(body.client_id, body.client_secret ?? "");
          if (!authenticated) {
            await request.audit("oauth2_token", {
              appId: application.id,
              clientId: application.clientId,
              grantType: "authorization_code",
              outcome: "invalid_client",
            });
            return reply.status(401).send({ error: "invalid_client" });
          }
        }

        // **PKCE before the consume** — SEC-077.
        //
        // Previously: `consumeAuthorizationCode` ran here and `verifyPKCE` ran
        // below it, so a request with a wrong `code_verifier` marked the code
        // used. The legitimate client, holding the correct verifier, then found
        // it spent and received `invalid_grant` — indistinguishable from an
        // expired or replayed code. A failed proof destroyed the thing it was
        // proving anything about.
        //
        // The peek is read-only; the consume below is still the only thing that
        // marks the row used, so a parallel redemption still cannot both win —
        // both callers may read the row, and the `usedAt IS NULL` predicate lets
        // exactly one consume match.
        const peeked = await peekAuthorizationCode(body.code, application.id, body.redirect_uri);
        if (!peeked) {
          return reply.status(400).send({ error: "invalid_grant" });
        }

        const pkceRequired = requiresPkce(application.clientSecretHash);
        if (!body.code_verifier && pkceRequired) {
          // Recorded on the *read*, so a client that repeatedly omits the
          // verifier leaves a trace. It did not consume the code, and deliberately
          // so: an attacker who omits it must not be able to burn the code for
          // the real client either.
          await request.audit("oauth2_token", {
            appId: application.id,
            clientId: application.clientId,
            grantType: "authorization_code",
            outcome: "pkce_verifier_missing",
          });
          return reply.status(400).send({
            error: "invalid_request",
            error_description: "code_verifier is required for this client",
          });
        }

        if (!verifyPKCE(peeked.challenge, peeked.challengeMethod, body.code_verifier, { requireChallenge: pkceRequired })) {
          await request.audit("oauth2_token", {
            appId: application.id,
            clientId: application.clientId,
            grantType: "authorization_code",
            outcome: "pkce_failed",
          });
          return reply.status(400).send({ error: "invalid_grant", error_description: "PKCE verification failed" });
        }

        // Consume only now that the proof has passed.
        const record = await consumeAuthorizationCode(body.code, application.id, body.redirect_uri);
        if (!record) {
          // Reachable when a parallel redemption won the race between the peek
          // and here. `invalid_grant` rather than a 500: the code *was* already
          // spent, which is a client error, not a server fault.
          return reply.status(400).send({ error: "invalid_grant" });
        }

        const user = await findUserById(record.userId);
        if (!user?.isActive) {
          return reply.status(400).send({ error: "invalid_grant" });
        }

        const membership = await app.container.organizationRepository.findMembership(
          application.orgId,
          user.id
        );
        if (!membership) {
          await request.audit("unauthorized_access", {
            action: "oauth_application_tenant_membership",
            appId: application.id,
            orgId: application.orgId,
          });
          return reply.status(400).send({ error: "invalid_grant" });
        }

        request.state.auditUserId = user.id;
        request.state.membership = membership;
        request.state.org = await app.container.organizationRepository.findById(application.orgId);
        await request.audit("oauth2_token", {
          appId: application.id,
          clientId: application.clientId,
          grantType: "authorization_code",
        });

        const storedMfaFactor = asMfaAssertion(record.mfaFactor);
        const fingerprint = fingerprintFromRequest(request);
        try {
          return await createTokenResponse(user, application, record.scopes, {
            ip: request.ip,
            userAgent: request.headers["user-agent"],
            deviceFingerprint: fingerprint,
            nonce: record.nonce ?? undefined,
            ...(storedMfaFactor ? { mfaFactor: storedMfaFactor } : {}),
          });
        } catch (err) {
          if (err instanceof MfaRequiredError) {
            return reply.status(400).send({
              error: "mfa_required",
              error_description:
                "The approving session did not complete multi-factor authentication. Sign in again with your verification code.",
            });
          }
          throw err;
        }
      }

      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token || !body.client_id || !body.client_secret) {
          await request.audit("oauth2_refresh_failed", {
            clientId: body.client_id,
            reason: "invalid_request",
          });
          return reply.status(400).send({ error: "invalid_request" });
        }
        const application = await verifyClientSecret(body.client_id, body.client_secret);
        if (!application) {
          await request.audit("oauth2_refresh_failed", {
            clientId: body.client_id,
            reason: "invalid_client",
          });
          return reply.status(401).send({ error: "invalid_client" });
        }

        // Lazy import to avoid circular dependency.
        const tokens = await rotateRefreshToken(
          body.refresh_token,
          request.ip,
          request.headers["user-agent"],
          body.client_id,
          application.id
        );
        if (!tokens) {
          request.state.app = application;
          request.state.org = await app.container.organizationRepository.findById(application.orgId);
          await request.audit("oauth2_refresh_failed", {
            appId: application.id,
            orgId: application.orgId,
            clientId: application.clientId,
            reason: "invalid_grant",
          });
          return reply.status(400).send({ error: "invalid_grant" });
        }

        request.state.auditUserId = tokens.userId;
        request.state.app = application;
        request.state.org = await app.container.organizationRepository.findById(application.orgId);
        request.state.membership = await app.container.organizationRepository.findMembership(application.orgId, tokens.userId);
        await request.audit("oauth2_refresh", {
          appId: application.id,
          orgId: application.orgId,
          clientId: application.clientId,
          grantType: "refresh_token",
        });
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
    { preHandler: [app.authenticate,
      // the userinfo claims describe a person. Placed after app.authenticate, which is what
      // populates request.serviceAccount.
      app.requireHumanPrincipal()] },
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

  app.post(
    "/revoke",
    {
      preHandler: [
        rateLimit({
          keyPrefix: "oauth2-revoke",
          maxAttempts: config.LOGIN_MAX_ATTEMPTS,
          windowSeconds: config.LOGIN_WINDOW_SECONDS,
          // RFC 7009 §5: "Malicious clients could attempt to use the new endpoint
          // to launch denial-of-service attacks on the authorization server.
          // Appropriate countermeasures, which should be in place for the token
          // endpoint as well, MUST be applied to the revocation endpoint."
          //
          // This endpoint had none, and it is the cheaper of the two halves of the
          // RFC's requirement to have a countermeasure in place: adding a limit
          // cannot break a conforming client, while requiring the credentials
          // §2.1 also asks for would.
          //
          // `emergencyLocalLimit` so a Redis outage degrades to a bounded
          // per-process budget rather than removing the limit.
          emergencyLocalLimit: true,
        }),
      ],
    },
    async (request) => {
      const body = z.object({ token: z.string() }).parse(request.body);
      await revokeRefreshToken(body.token);
      await request.audit("oauth2_revoke", {});
      // 200 whether or not the token existed, per RFC 7009 §2.2: "invalid tokens do
      // not cause an error response since the client cannot handle such an error in
      // a reasonable way." So this is not a token-validity oracle.
      return { success: true };
    }
  );

  app.post(
    "/consent",
    { preHandler: [app.authenticate,
      // consent is a human authorization decision. Placed after app.authenticate, which is what
      // populates request.serviceAccount.
      app.requireHumanPrincipal()] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = ConsentBodySchema.parse(request.body);
      const application = await findApplicationByClientId(body.client_id);
      if (!application) {
        return reply.status(400).send({ error: "invalid_client" });
      }

      const membership = await app.container.organizationRepository.findMembership(
        application.orgId,
        request.user!.id
      );
      if (!membership) {
        await request.audit("unauthorized_access", {
          action: "oauth_application_tenant_membership",
          appId: application.id,
          orgId: application.orgId,
        });
        return reply.status(403).send({ error: "not_member" });
      }

      request.state.membership = membership;
      request.state.org = await app.container.organizationRepository.findById(application.orgId);
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
