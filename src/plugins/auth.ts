import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, and, gt, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { apiKeys, users, serviceAccounts, type User } from "../db/schema.js";
import { verifyAccessToken, hashApiKey } from "../services/tokens.js";
import type { TokenClaims } from "../types.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateOrApiKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireScopes: (...scopes: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    serviceAccount?: typeof serviceAccounts.$inferSelect;
    apiKeyScopes?: string[];
  }
}

const DEFAULT_ACCESS_COOKIE = config.COOKIE_NAME;
const DEFAULT_REFRESH_COOKIE = `${config.COOKIE_NAME}-refresh`;

export function accessCookieName(clientId?: string): string {
  return clientId ? `app-${clientId}-session` : DEFAULT_ACCESS_COOKIE;
}

export function refreshCookieName(clientId?: string): string {
  return clientId ? `app-${clientId}-session-refresh` : DEFAULT_REFRESH_COOKIE;
}

function cookieOptions(): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict" | "lax" | "none";
  domain: string | undefined;
} {
  const sameSite = (config.COOKIE_SAME_SITE as "strict" | "lax" | "none") || (config.NODE_ENV === "production" ? "strict" : "lax");
  return {
    path: "/",
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite,
    domain: config.COOKIE_DOMAIN || undefined,
  };
}

export function setSessionCookies(
  reply: FastifyReply,
  accessToken: string,
  refreshToken: string,
  clientId?: string
): void {
  const opts = cookieOptions();

  reply.setCookie(accessCookieName(clientId), accessToken, {
    ...opts,
    maxAge: config.ACCESS_TOKEN_TTL_SECONDS,
  });
  reply.setCookie(refreshCookieName(clientId), refreshToken, {
    ...opts,
    maxAge: config.REFRESH_TOKEN_TTL_SECONDS,
  });
}

export function clearSessionCookies(reply: FastifyReply, clientId?: string): void {
  const opts = cookieOptions();
  reply.clearCookie(accessCookieName(clientId), opts);
  reply.clearCookie(refreshCookieName(clientId), opts);
}

export function getRefreshToken(request: FastifyRequest, clientId?: string): string | undefined {
  return request.cookies[refreshCookieName(clientId)];
}

async function resolveUserFromClaims(claims: TokenClaims) {
  const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  return user;
}

async function resolveApiKeyRecord(key: string) {
  const hash = hashApiKey(key);
  const [keyRecord] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);
  return keyRecord;
}

async function resolveUserFromApiKey(key: string): Promise<{ user: User; scopes: string[] } | undefined> {
  const keyRecord = await resolveApiKeyRecord(key);
  if (!keyRecord) return undefined;
  if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) return undefined;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyRecord.id));

  if (keyRecord.userId) {
    const [user] = await db.select().from(users).where(eq(users.id, keyRecord.userId)).limit(1);
    if (!user) return undefined;
    return { user, scopes: keyRecord.scopes ?? [] };
  }

  return undefined;
}

function extractAccessToken(request: FastifyRequest): string | undefined {
  // Prefer the app-specific cookie if an app context is present.
  const appClientId = request.state?.app?.clientId;
  const appCookie = appClientId ? request.cookies[accessCookieName(appClientId)] : undefined;
  if (appCookie) return appCookie;

  const defaultCookie = request.cookies[DEFAULT_ACCESS_COOKIE];
  if (defaultCookie) return defaultCookie;

  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return undefined;
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate("authenticate", async function authenticate(request, reply) {
    const token = extractAccessToken(request);
    if (!token) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    try {
      const claims = await verifyAccessToken(token);
      const user = await resolveUserFromClaims(claims);
      if (!user) {
        return reply.status(401).send({ error: "User not found" });
      }
      request.user = user;
    } catch {
      return reply.status(401).send({ error: "Invalid token" });
    }
  });

  app.decorate("authenticateOrApiKey", async function authenticateOrApiKey(request, reply) {
    const token = extractAccessToken(request);
    if (!token) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    try {
      const claims = await verifyAccessToken(token);
      const user = await resolveUserFromClaims(claims);
      if (!user) {
        return reply.status(401).send({ error: "User not found" });
      }
      request.user = user;
      return;
    } catch {
      // Not a valid access token — try API key.
    }

    const apiKeyUser = await resolveUserFromApiKey(token);
    if (apiKeyUser) {
      request.user = apiKeyUser.user;
      request.apiKeyScopes = apiKeyUser.scopes;
      return;
    }

    const serviceAccount = await resolveServiceAccountFromApiKey(token);
    if (serviceAccount) {
      request.serviceAccount = serviceAccount;
      request.apiKeyScopes = ["api:read", "api:write", "service_account"];
      // Synthesize a user so existing routes that expect request.user keep working.
      request.user = {
        id: `sa:${serviceAccount.id}`,
        email: `service-account@${serviceAccount.id}.internal`,
        username: `sa-${serviceAccount.id.slice(0, 8)}`,
        name: serviceAccount.name,
        avatarUrl: null,
        emailVerified: true,
        plan: "enterprise",
        role: "service_account",
        provider: "api_key",
        zitadelUserId: null,
        defaultOrgId: serviceAccount.orgId,
        phoneNumber: null,
        phoneVerified: false,
        totpSecret: null,
        totpEnabled: false,
        totpVerifiedAt: null,
        createdAt: serviceAccount.createdAt,
        updatedAt: serviceAccount.updatedAt,
      } as User;
      return;
    }

    return reply.status(401).send({ error: "Invalid token or API key" });
  });

  app.decorate("requireScopes", function requireScopes(...required: string[]) {
    return async function scopeCheck(request: FastifyRequest, reply: FastifyReply) {
      // Session-based authentication has full scope access.
      if (!request.apiKeyScopes) return;
      const scopes = request.apiKeyScopes;
      const hasAll = required.every((scope) => scopes.includes(scope) || scopes.includes("service_account"));
      if (!hasAll) {
        return reply.status(403).send({ error: "Insufficient API key scope", required });
      }
    };
  });
});

async function resolveServiceAccountFromApiKey(key: string) {
  const hash = hashApiKey(key);
  const [keyRecord] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!keyRecord) return undefined;
  if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) return undefined;
  if (!keyRecord.serviceAccountId) return undefined;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyRecord.id));
  const [account] = await db
    .select()
    .from(serviceAccounts)
    .where(and(eq(serviceAccounts.id, keyRecord.serviceAccountId), eq(serviceAccounts.isActive, true)))
    .limit(1);
  return account;
}
