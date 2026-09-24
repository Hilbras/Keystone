import type { User, Application, Organization, OrgMembership, ApiKey, OidcConnection, SamlConnection } from "./db/schema.js";
import type { KeystonePlugin } from "./services/plugins/types.js";
import type { Container } from "./container.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    state: {
      app?: Application;
      org?: Organization;
      membership?: OrgMembership;
      auditUserId?: string;
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
  role?: "owner" | "user";
  provider?: string;
  org_id?: string;
  app_id?: string;
  client_id?: string;
  device_fingerprint?: string;
}

export type PublicApplication = Omit<Application, "clientSecretHash">;
export type PublicApiKey = Omit<ApiKey, "keyHash">;
export type PublicOidcConnection = Omit<OidcConnection, "clientSecret">;
export type PublicSamlConnection = Omit<SamlConnection, "idpCertificate">;

export function toPublicSamlConnection(connection: SamlConnection): PublicSamlConnection {
  const { idpCertificate: _idpCertificate, ...safeConnection } = connection;
  return safeConnection;
}

export function toPublicOidcConnection(connection: OidcConnection): PublicOidcConnection {
  const { clientSecret: _clientSecret, ...safeConnection } = connection;
  return safeConnection;
}

export function toPublicApiKey(apiKey: ApiKey): PublicApiKey {
  const { keyHash: _keyHash, ...safeApiKey } = apiKey;
  return safeApiKey;
}

export function toPublicApplication(
  application: Application | (PublicApplication & { clientSecret?: string })
): PublicApplication & { clientSecret?: string } {
  const { clientSecretHash: _clientSecretHash, ...safeApplication } = application as Application & {
    clientSecret?: string;
  };
  return safeApplication;
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
  role: "owner" | "user";
  isActive: boolean;
  accountReviewRequired?: boolean;
  provider: string;
}

export interface SelfUser extends PublicUser {
  metadata: Record<string, unknown>;
}

export function toPublicUser(user: User | PublicUser): PublicUser {
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
    role: user.role === "owner" ? "owner" : "user",
    isActive: user.isActive,
    accountReviewRequired: user.accountReviewRequired,
    provider: user.provider,
  };
}

export function toSelfUser(user: User | SelfUser): SelfUser {
  const metadata = "metadata" in user ? user.metadata : undefined;
  return {
    ...toPublicUser(user),
    metadata: metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {},
  };
}
