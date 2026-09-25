import { z } from "zod";
import { config } from "../config.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import {
  buildRegistrationOptions,
  verifyAndStoreRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
  consumeChallenge,
} from "../services/webauthn.js";
import { createTokenSet, MfaRequiredError } from "../services/tokens.js";
import { requireStepUp } from "../services/stepUp.js";
import { setSessionCookies } from "../plugins/auth.js";
import { fingerprintFromRequest, recordDevice } from "../services/devices.js";
import { toSelfUser } from "../types.js";

const ChallengeCookieName = "keystone_webauthn_challenge";

function setChallengeCookie(reply: FastifyReply, challenge: string): void {
  reply.setCookie(ChallengeCookieName, challenge, {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: 300,
  });
}

function getChallengeCookie(request: FastifyRequest): string | undefined {
  return request.cookies[ChallengeCookieName];
}

function clearChallengeCookie(reply: FastifyReply): void {
  reply.clearCookie(ChallengeCookieName, { path: "/" });
}

const RegisterVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()),
  deviceName: z.string().max(100).optional(),
  // Required to register a passkey on an account that already has TOTP: a
  // stolen session token must not be enough to mint a new second factor.
  password: z.string().max(128).optional(),
});

const AuthenticateOptionsSchema = z.object({
  email: z.string().email().optional(),
});

const AuthenticateVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()),
});

export default async function webauthnRoutes(app: FastifyInstance) {
  app.get(
    "/webauthn/register/options",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const options = await buildRegistrationOptions(user);
      setChallengeCookie(reply, options.challenge);
      return options;
    }
  );

  app.post(
    "/webauthn/register/verify",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const body = RegisterVerifySchema.parse(request.body);

      if (user.totpEnabled) {
        const stepUp = await requireStepUp(
          request.server.container.userRepository,
          user,
          body.password
        );
        if (!stepUp.ok) {
          await request.audit("mfa_bypass_blocked", { userId: user.id, action: "webauthn_register" });
          return reply.status(stepUp.error!.statusCode ?? 401).send({
            error: stepUp.error!.message,
            code: stepUp.error!.code,
          });
        }
      }

      const challenge = getChallengeCookie(request);
      if (!challenge) {
        return reply.status(400).send({ error: "Challenge expired or missing" });
      }

      const stored = consumeChallenge(challenge);
      if (!stored || stored.userId !== user.id) {
        clearChallengeCookie(reply);
        return reply.status(400).send({ error: "Invalid challenge" });
      }

      try {
        await verifyAndStoreRegistration(
          user,
          body.response as unknown as RegistrationResponseJSON,
          challenge,
          body.deviceName
        );
        clearChallengeCookie(reply);
        await request.audit("webauthn_registered", { userId: user.id });
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Registration failed";
        return reply.status(400).send({ error: message });
      }
    }
  );

  app.post("/webauthn/authenticate/options", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = AuthenticateOptionsSchema.parse(request.body);
    const options = await buildAuthenticationOptions(body.email);
    setChallengeCookie(reply, options.challenge);
    return options;
  });

  app.post("/webauthn/authenticate/verify", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = AuthenticateVerifySchema.parse(request.body);
    const challenge = getChallengeCookie(request);
    if (!challenge) {
      return reply.status(400).send({ error: "Challenge expired or missing" });
    }

    const stored = consumeChallenge(challenge);
    if (!stored) {
      clearChallengeCookie(reply);
      return reply.status(400).send({ error: "Invalid challenge" });
    }

    try {
      const { user, credentialRegisteredAt } = await verifyAuthentication(
        body.response as unknown as AuthenticationResponseJSON,
        challenge
      );
      clearChallengeCookie(reply);

      // A passkey registered *after* TOTP was enabled must not be able to
      // satisfy the TOTP requirement on its own, otherwise a leaked session
      // token could be traded for a permanent second-factor bypass.
      const enrolledAfterTotp =
        user.totpEnabled &&
        !!user.totpVerifiedAt &&
        credentialRegisteredAt.getTime() > user.totpVerifiedAt.getTime();

      if (enrolledAfterTotp) {
        await request.audit("mfa_bypass_blocked", { userId: user.id, action: "webauthn_after_totp" });
        return reply.status(403).send({
          error:
            "This passkey was registered after multi-factor authentication was enabled and cannot be used to sign in on its own.",
          code: "MFA_REQUIRED",
        });
      }

      const fingerprint = fingerprintFromRequest(request);
      await recordDevice(user.id, fingerprint, request.ip, request.headers["user-agent"]);
      const tokens = await createTokenSet(
        user,
        request.ip,
        request.headers["user-agent"],
        // A verified WebAuthn assertion is itself a possession factor.
        { mfaFactor: "webauthn" },
        fingerprint
      );
      setSessionCookies(reply, tokens.accessToken, tokens.refreshToken);

      await request.audit("webauthn_authenticated", { userId: user.id });
      return {
        user: toSelfUser(user),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    } catch (err) {
      if (err instanceof MfaRequiredError) {
        return reply.status(403).send({
          error: "Multi-factor authentication is required for this account.",
          code: "MFA_REQUIRED",
        });
      }
      const message = err instanceof Error ? err.message : "Authentication failed";
      return reply.status(400).send({ error: message });
    }
  });
}
