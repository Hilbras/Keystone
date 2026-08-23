import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getSdk } from "../sdk/index.js";
import {
  setSessionCookies,
  clearSessionCookies,
  getRefreshToken,
} from "../plugins/auth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { checkImpossibleTravel } from "../services/anomalyDetection.js";
import { sendSuspiciousLoginAlert } from "../services/email.js";
import { checkIpAllowed } from "../services/ipControls.js";
import { toPublicUser } from "../types.js";

/**
 * Fire-and-forget impossible-travel check after a successful login.
 * Emits a suspicious-login email when the user's previous login came from a
 * different IP within the anomaly window.
 */
function detectImpossibleTravel(user: { id: string; email: string }, ip?: string, userAgent?: string): void {
  checkImpossibleTravel(user.id, ip)
    .then(async (suspicious) => {
      if (!suspicious) return;
      await sendSuspiciousLoginAlert({
        email: user.email,
        ipAddress: ip,
        userAgent,
        reason: "Sign-in from a new location within minutes of the previous one",
      });
    })
    .catch((err: unknown) => {
      console.error("[anomaly] impossible-travel check failed:", err);
    });
}

const RegisterSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().max(255).optional(),
  client_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const LoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
  client_id: z.string().optional(),
  totp_code: z.string().min(6).max(8).optional(),
});

const RefreshSchema = z.object({
  client_id: z.string().optional(),
});

function sendResultError(reply: FastifyReply, result: { success: false; error: { statusCode?: number; message: string; code: string } }) {
  return reply.status(result.error.statusCode ?? 400).send({ error: result.error.message, code: result.error.code });
}

export default async function authRoutes(app: FastifyInstance) {
  const sdk = getSdk();

  app.post(
    "/register",
    {
      preHandler: [
        rateLimit({
          keyPrefix: "register",
          maxAttempts: 5,
          windowSeconds: 900,
        }),
      ],
    },
    async (request, reply) => {
      const body = RegisterSchema.parse(request.body);

      const ipCheck = await checkIpAllowed(body.client_id, request.ip);
      if (!ipCheck.allowed) {
        return reply.status(403).send({ error: ipCheck.reason, code: "IP_NOT_ALLOWED" });
      }

      const result = await sdk.authentication.register({
        username: body.username,
        email: body.email,
        password: body.password,
        name: body.name,
        clientId: body.client_id,
        metadata: body.metadata,
      });

      if (!result.success) return sendResultError(reply, result);

      setSessionCookies(reply, result.data.accessToken, result.data.refreshToken, body.client_id);
      return { user: toPublicUser(result.data.user) };
    }
  );

  app.post(
    "/login",
    {
      preHandler: [
        rateLimit({
          keyPrefix: "login",
          maxAttempts: 5,
          windowSeconds: 900,
        }),
      ],
    },
    async (request, reply) => {
      const body = LoginSchema.parse(request.body);

      const ipCheck = await checkIpAllowed(body.client_id, request.ip);
      if (!ipCheck.allowed) {
        return reply.status(403).send({ error: ipCheck.reason, code: "IP_NOT_ALLOWED" });
      }

      const result = await sdk.authentication.login({
        email: body.email,
        password: body.password,
        clientId: body.client_id,
      });

      if (!result.success) return sendResultError(reply, result);

      if (body.totp_code) {
        const { verifyTOTP } = await import("../services/totp.js");
        const validTotp = await verifyTOTP(result.data.user.id, body.totp_code);
        if (!validTotp) {
          return reply.status(401).send({ error: "Invalid two-factor code." });
        }
      }

      detectImpossibleTravel(result.data.user, request.ip, request.headers["user-agent"]);
      setSessionCookies(reply, result.data.accessToken, result.data.refreshToken, body.client_id);
      return { user: toPublicUser(result.data.user) };
    }
  );

  app.post(
    "/token-login",
    {
      preHandler: [
        rateLimit({
          keyPrefix: "login",
          maxAttempts: 5,
          windowSeconds: 900,
        }),
      ],
    },
    async (request, reply) => {
      const body = LoginSchema.parse(request.body);

      const ipCheck = await checkIpAllowed(body.client_id, request.ip);
      if (!ipCheck.allowed) {
        return reply.status(403).send({ error: ipCheck.reason, code: "IP_NOT_ALLOWED" });
      }

      const result = await sdk.authentication.login({
        email: body.email,
        password: body.password,
        clientId: body.client_id,
      });

      if (!result.success) return sendResultError(reply, result);

      if (body.totp_code) {
        const { verifyTOTP } = await import("../services/totp.js");
        const validTotp = await verifyTOTP(result.data.user.id, body.totp_code);
        if (!validTotp) {
          return reply.status(401).send({ error: "Invalid two-factor code." });
        }
      }

      detectImpossibleTravel(result.data.user, request.ip, request.headers["user-agent"]);
      return {
        accessToken: result.data.accessToken,
        user: toPublicUser(result.data.user),
      };
    }
  );

  app.get("/me", { preHandler: [app.authenticate] }, async (request) => {
    return { user: request.user ? toPublicUser(request.user) : null };
  });

  app.post("/refresh", async (request, reply) => {
    const body = RefreshSchema.parse(request.body ?? {});
    const clientId = body.client_id;

    const refreshToken = getRefreshToken(request, clientId) || getRefreshToken(request);
    if (!refreshToken) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const result = await sdk.authentication.refresh(refreshToken, clientId);
    if (!result.success) return sendResultError(reply, result);

    setSessionCookies(reply, result.data.accessToken, result.data.refreshToken, clientId);
    return { success: true };
  });

  app.post("/logout", async (request, reply) => {
    const appClientId = request.state?.app?.clientId;
    const refreshToken =
      getRefreshToken(request, appClientId) || getRefreshToken(request);
    const result = await sdk.authentication.logout(refreshToken);
    if (!result.success) return sendResultError(reply, result);

    clearSessionCookies(reply, appClientId);
    clearSessionCookies(reply);
    return { success: true };
  });
}
