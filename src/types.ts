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
    metadata: (user.metadata ?? {}) as Record<string, unknown>,
  };
}
