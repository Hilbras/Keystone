import { z } from "zod";
import type { FastifyInstance } from "fastify";
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
import { toSelfUser } from "../types.js";
import { verifyTOTP } from "../services/totp.js";
import { sendResultError } from "./helpers.js";
import { findApplicationByClientId } from "../services/applications.js";

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
  metadata: z.record(z.string(), z.unknown()).optional(),
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

      request.state.auditUserId = result.data.user.id;
      await request.audit("user_registered", { userId: result.data.user.id, email: result.data.user.email });
      setSessionCookies(reply, result.data.accessToken, result.data.refreshToken, body.client_id);
      return { user: toSelfUser(result.data.user) };
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
        const validTotp = await verifyTOTP(result.data.user.id, body.totp_code);
        if (!validTotp) {
          return reply.status(401).send({ error: "Invalid two-factor code." });
        }
      }

      request.state.auditUserId = result.data.user.id;
      await request.audit("user_login", { userId: result.data.user.id });
      detectImpossibleTravel(result.data.user, request.ip, request.headers["user-agent"]);
      setSessionCookies(reply, result.data.accessToken, result.data.refreshToken, body.client_id);
      return { user: toSelfUser(result.data.user) };
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
        const validTotp = await verifyTOTP(result.data.user.id, body.totp_code);
        if (!validTotp) {
          return reply.status(401).send({ error: "Invalid two-factor code." });
        }
      }

      request.state.auditUserId = result.data.user.id;
      await request.audit("user_token_login", { userId: result.data.user.id });
      detectImpossibleTravel(result.data.user, request.ip, request.headers["user-agent"]);
      return {
        accessToken: result.data.accessToken,
        user: toSelfUser(result.data.user),
      };
    }
  );

  app.get("/me", { preHandler: [app.authenticate] }, async (request) => {
    return { user: request.user ? toSelfUser(request.user) : null };
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

    if (result.data.userId) request.state.auditUserId = result.data.userId;
    if (clientId) {
      const application = await findApplicationByClientId(clientId);
      if (application && result.data.userId) {
        const membership = await request.server.container.organizationRepository.findMembership(application.orgId, result.data.userId);
        if (membership) {
          request.state.app = application;
          request.state.membership = membership;
          request.state.org = await request.server.container.organizationRepository.findById(application.orgId);
        }
      }
    }
    await request.audit("token_refresh", { userId: result.data.userId, clientId, appId: request.state.app?.id, orgId: request.state.org?.id });
    setSessionCookies(reply, result.data.accessToken, result.data.refreshToken, clientId);
    return { success: true };
  });

  app.post("/logout", async (request, reply) => {
    const appClientId = request.state?.app?.clientId;
    const refreshToken =
      getRefreshToken(request, appClientId) || getRefreshToken(request);
    const result = await sdk.authentication.logout(refreshToken);
    if (!result.success) return sendResultError(reply, result);

    await request.audit("user_logout", { userId: request.user?.id });
    clearSessionCookies(reply, appClientId);
    clearSessionCookies(reply);
    return { success: true };
  });
}
