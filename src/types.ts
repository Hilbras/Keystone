import type { User, Application, Organization, OrgMembership } from "./db/schema.js";
import type { KeystonePlugin } from "./services/plugins/types.js";
import type { Container } from "./container.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    state: {
      app?: Application;
      org?: Organization;
      membership?: OrgMembership;
    };
  }

  interface FastifyInstance {
    registerPlugin(plugin: KeystonePlugin): void;
    container: Container;
  }
}

export interface AuthCookiePayload {
  accessToken: string;
  refreshToken: string;
}

export interface TokenClaims {
  sub: string;
  email?: string;
  username?: string;
  name?: string;
  plan?: string;
  role?: string;
  provider?: string;
  org_id?: string;
  app_id?: string;
  client_id?: string;
  device_fingerprint?: string;
}

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  plan: string;
  role: string;
  provider: string;
  metadata: Record<string, unknown>;
}

const SENSITIVE_METADATA_KEY = /(password|secret|token|hash|private.?key|credential|otp|totp)/i;

export function redactPublicMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactPublicMetadata(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_METADATA_KEY.test(key))
      .map(([key, nested]) => [key, redactPublicMetadata(nested, depth + 1)])
  );
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
    emailVerified: user.emailVerified,
    phoneNumber: user.phoneNumber,
    phoneVerified: user.phoneVerified,
    plan: user.plan,
    role: user.role,
    provider: user.provider,
    metadata: redactPublicMetadata(user.metadata ?? {}) as Record<string, unknown>,
  };
}
