import { z } from "zod";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { getSdk } from "../sdk/index.js";
import {
  setSessionCookies,
  clearSessionCookies,
  getRefreshToken,
} from "../plugins/auth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { revokeAllUserCredentials } from "../services/sessionRevocation.js";
import { checkImpossibleTravel } from "../services/anomalyDetection.js";
import { sendSuspiciousLoginAlert } from "../services/email.js";
import { checkIpAllowed } from "../services/ipControls.js";
import { toSelfUser } from "../types.js";
import { sendResultError } from "./helpers.js";
import { findApplicationByClientId } from "../services/applications.js";

/**
 * Fire-and-forget impossible-travel check after a successful login.
 * Emits a suspicious-login email when the user's previous login came from a
 * different IP within the anomaly window.
 */
function detectImpossibleTravel(
  user: { id: string; email: string },
  log: FastifyBaseLogger,
  ip?: string,
  userAgent?: string
): void {
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
      log.error({ err }, "impossible-travel check failed");
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
});

const MfaVerifySchema = z.object({
  challenge: z.string().min(20).max(256),
  code: z.string().min(6).max(64),
  factor: z.enum(["totp", "backup_code"]).optional(),
});

const RefreshSchema = z.object({
  client_id: z.string().optional(),
});

/**
 * Whether a refresh token was already spent.
 *
 * Rotation consumes the token, so a live token presented twice means the first
 * use was someone else. A token that does not exist at all is a different
 * problem — a guess, or a stale client — and does not warrant revoking the
 * account's sessions.
 */
async function wasRefreshTokenAlreadyUsed(token: string): Promise<boolean> {
  const { findRefreshTokenState } = await import("../services/refreshTokenState.js");
  return findRefreshTokenState(token);
}

/** The user a spent refresh token belonged to, if it is still resolvable. */
async function refreshTokenUserId(token: string): Promise<string | null> {
  const { refreshTokenOwner } = await import("../services/refreshTokenState.js");
  return refreshTokenOwner(token);
}

export default async function authRoutes(app: FastifyInstance) {
  const sdk = getSdk();

  app.post(
    "/register",
    {
      preHandler: [
        rateLimit({
          keyPrefix: "register",
          maxAttempts: config.LOGIN_MAX_ATTEMPTS,
          windowSeconds: config.LOGIN_WINDOW_SECONDS,
          // A Redis outage must not remove the limit on an endpoint worth brute-forcing.
          emergencyLocalLimit: true,
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
          maxAttempts: config.LOGIN_MAX_ATTEMPTS,
          windowSeconds: config.LOGIN_WINDOW_SECONDS,
          // A Redis outage must not remove the limit on an endpoint worth
          // brute-forcing.
          emergencyLocalLimit: true,
        }),
        // The budget above is keyed on address *and* submitted address, so it
        // stops repeated guesses at one account. That is exactly the wrong shape
        // for spraying: an attacker who varies the address on every request gets a
        // fresh budget per attempt and can enumerate or guess across a thousand
        // accounts from one host. This second budget is keyed on the address
        // alone, so spraying is capped no matter how many addresses are tried.
        //
        // `includeSubmittedAddress: false` is what makes that true. The key used
        // to append the submitted address to *every* limiter's key, which left
        // this one keyed on address **and** account — the same shape as the budget
        // above it, and no control on spraying at all. SEC-048.
        rateLimit({
          keyPrefix: "login-per-address",
          maxAttempts: config.LOGIN_PER_ADDRESS_MAX,
          windowSeconds: config.LOGIN_WINDOW_SECONDS,
          emergencyLocalLimit: true,
          keyFrom: (request) => request.ip,
          includeSubmittedAddress: false,
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
        flow: "login",
      });

      if (!result.success) {
        // No `user_login_failed` audit here, and its absence is the fix rather
        // than an omission (SEC-053).
        //
        // `AuthenticationDomainService.login` already emits `user_login_failed`
        // for every refusal it can return — `unknown_user`, `invalid_password`,
        // `account_deactivated`, `account_review_required`, `account_locked` —
        // each carrying the reason, the user id where one exists, and the client
        // address. This call site used to emit the same event a second time,
        // because it was written when a wrong password produced a 401 and
        // nothing else.
        //
        // Two events for one failure doubled every subscriber's count: the failed
        // -login metric read twice the truth, and the anomaly detector reached its
        // threshold of 10 after 5 real attempts.
        //
        // The domain service is the right owner: it covers all five paths,
        // including the ones that return before this handler could audit, and it
        // fires for the CLI and any future transport too.
        return sendResultError(reply, result);
      }

      if (result.data.status === "requires_mfa") {
        const pending = result.data.data;
        request.state.auditUserId = pending.user.id;
        await request.audit("mfa_challenge_created", { userId: pending.user.id, flow: "login" });
        reply.header("Cache-Control", "no-store");
        return reply.status(401).send({
          error: "Multi-factor authentication required",
          code: "MFA_REQUIRED",
          mfaRequired: true,
          challenge: pending.challenge,
          expiresAt: pending.expiresAt,
          methods: ["totp", "backup_code"],
        });
      }

      const auth = result.data.data;
      request.state.auditUserId = auth.user.id;
      await request.audit("user_login", { userId: auth.user.id });
      detectImpossibleTravel(auth.user, request.log, request.ip, request.headers["user-agent"]);
      setSessionCookies(reply, auth.accessToken, auth.refreshToken, body.client_id);
      return { user: toSelfUser(auth.user) };
    }
  );

  app.post(
    "/token-login",
    {
      preHandler: [
        rateLimit({
          keyPrefix: "login",
          maxAttempts: config.LOGIN_MAX_ATTEMPTS,
          windowSeconds: config.LOGIN_WINDOW_SECONDS,
          // A Redis outage must not remove the limit on an endpoint worth
          // brute-forcing.
          emergencyLocalLimit: true,
        }),
        // The budget above is keyed on address *and* submitted address, so it
        // stops repeated guesses at one account. That is exactly the wrong shape
        // for spraying: an attacker who varies the address on every request gets a
        // fresh budget per attempt and can enumerate or guess across a thousand
        // accounts from one host. This second budget is keyed on the address
        // alone, so spraying is capped no matter how many addresses are tried.
        //
        // `includeSubmittedAddress: false` is what makes that true. The key used
        // to append the submitted address to *every* limiter's key, which left
        // this one keyed on address **and** account — the same shape as the budget
        // above it, and no control on spraying at all. SEC-048.
        rateLimit({
          keyPrefix: "login-per-address",
          maxAttempts: config.LOGIN_PER_ADDRESS_MAX,
          windowSeconds: config.LOGIN_WINDOW_SECONDS,
          emergencyLocalLimit: true,
          keyFrom: (request) => request.ip,
          includeSubmittedAddress: false,
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
        flow: "token_login",
      });

      if (!result.success) {
        // Same reasoning as /login, and for the same reason: the domain service
        // emitted `user_login_failed` for this refusal already (SEC-053).
        return sendResultError(reply, result);
      }

      if (result.data.status === "requires_mfa") {
        const pending = result.data.data;
        request.state.auditUserId = pending.user.id;
        await request.audit("mfa_challenge_created", { userId: pending.user.id, flow: "token_login" });
        reply.header("Cache-Control", "no-store");
        return reply.status(401).send({
          error: "Multi-factor authentication required",
          code: "MFA_REQUIRED",
          mfaRequired: true,
          challenge: pending.challenge,
          expiresAt: pending.expiresAt,
          methods: ["totp", "backup_code"],
        });
      }

      const auth = result.data.data;
      request.state.auditUserId = auth.user.id;
      await request.audit("user_token_login", { userId: auth.user.id });
      detectImpossibleTravel(auth.user, request.log, request.ip, request.headers["user-agent"]);
      return {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        expiresAt: auth.expiresAt,
        user: toSelfUser(auth.user),
      };
    }
  );

  /**
   * Completes the `requires_mfa` state started by /login or /token-login.
   * Authenticated by the opaque challenge alone: `app.authenticate` is not used
   * and no token exists yet at this point.
   */
  app.post(
    "/mfa/verify",
    {
      preHandler: [
        rateLimit({
          keyPrefix: "mfa-verify",
          maxAttempts: 20,
          windowSeconds: 300,
          // A Redis outage must not remove the limit on an endpoint worth
          // brute-forcing.
          emergencyLocalLimit: true,
          // Keyed on the challenge as well as the address. The default key
          // includes `body.email`, which this endpoint does not carry, so every
          // verification from one address shared a single budget: 20 attempts
          // across *all* users. An attacker got 20 guesses, but so did an office
          // behind one NAT — one busy office could lock out every legitimate
          // second-factor login. The challenge is a single opaque login attempt,
          // so this gives an attacker 20 guesses at the code they are actually
          // attacking, without spending anyone else's budget.
          keyFrom: (request) =>
            `${request.ip}:${(request.body as { challenge?: string } | undefined)?.challenge ?? "none"}`,
        }),
      ],
    },
    async (request, reply) => {
      const body = MfaVerifySchema.parse(request.body);

      const result = await sdk.authentication.completeMfa({
        challenge: body.challenge,
        code: body.code,
        factor: body.factor,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      if (!result.success) {
        if (result.error.code === "MFA_INVALID_CODE") {
          await request.audit("mfa_challenge_failed", { factor: body.factor ?? "auto" });
        }
        return sendResultError(reply, result);
      }

      request.state.auditUserId = result.data.user.id;
      await request.audit("mfa_verified", { userId: result.data.user.id, factor: result.data.factor });
      detectImpossibleTravel(result.data.user, request.log, request.ip, request.headers["user-agent"]);

      if (result.data.flow === "login") {
        await request.audit("user_login", { userId: result.data.user.id, mfa: result.data.factor });
        // Scope the session cookie to the client the challenge was created for,
        // exactly as the password step of /login does.
        setSessionCookies(reply, result.data.accessToken, result.data.refreshToken, result.data.clientId);
      } else {
        await request.audit("user_token_login", { userId: result.data.user.id, mfa: result.data.factor });
      }

      return {
        accessToken: result.data.accessToken,
        refreshToken: result.data.refreshToken,
        expiresAt: result.data.expiresAt,
        factor: result.data.factor,
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
    if (!result.success) {
      // Distinguish a replayed token from one that was never issued. Rotation
      // consumes a refresh token, so a second presentation of the same token is
      // either an attacker racing the legitimate client or a stolen token being
      // used twice — and it means the token has leaked.
      const replayed = await wasRefreshTokenAlreadyUsed(refreshToken);
      await request.audit("refresh_token_replayed", {
        replayed,
        ip: request.ip,
      });
      if (replayed) {
        // A replay means the token is known to someone else, so everything it
        // could mint should stop working rather than just this one request.
        const ownerId = await refreshTokenUserId(refreshToken);
        if (ownerId) {
          await revokeAllUserCredentials(ownerId);
        }
      }
      return sendResultError(reply, result);
    }

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
