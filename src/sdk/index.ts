import type { KeystoneSdk, AuthenticationSdk, IdentitySdk, OrganizationSdk, AuthorizationSdk } from "./types.js";
import type {
  AuthenticationApplicationService,
  IdentityApplicationService,
  OrganizationApplicationService,
} from "../services/application/index.js";
import type { AuthorizationDomainService } from "../services/domain/authorization.js";
import type { EventContext } from "../services/events/types.js";
import { getContainer } from "../container.js";
import { buildApplicationServices } from "../di.js";
import { toPublicApplication, toPublicUser, toSelfUser } from "../types.js";
import type { FederationApplicationContext } from "../services/federation.js";

class SdkAuthenticationClient implements AuthenticationSdk {
  constructor(private readonly app: AuthenticationApplicationService) {}

  async register(input: { username: string; email: string; password: string; name?: string; clientId?: string; metadata?: Record<string, unknown> }) {
    const result = await this.app.register(input);
    if (!result.success) return result;
    return {
      success: true as const,
      data: {
        accessToken: result.data.accessToken,
        refreshToken: result.data.refreshToken,
        expiresAt: result.data.expiresAt,
        user: toSelfUser(result.data.user),
      },
    };
  }

  async login(input: { email: string; password: string; clientId?: string; flow?: "login" | "token_login" }) {
    const result = await this.app.login(input);
    if (!result.success) return result;
    if (result.data.status === "requires_mfa") {
      return {
        success: true as const,
        data: {
          status: "requires_mfa" as const,
          data: {
            status: "requires_mfa" as const,
            user: toSelfUser(result.data.data.user),
            challenge: result.data.data.challenge,
            expiresAt: result.data.data.expiresAt,
            flow: result.data.data.flow,
            clientId: result.data.data.clientId,
          },
        },
      };
    }
    return {
      success: true as const,
      data: {
        status: "authenticated" as const,
        data: {
          accessToken: result.data.data.accessToken,
          refreshToken: result.data.data.refreshToken,
          expiresAt: result.data.data.expiresAt,
          user: toSelfUser(result.data.data.user),
        },
      },
    };
  }

  async completeMfa(input: { challenge: string; code: string; factor?: "totp" | "backup_code"; ipAddress?: string; userAgent?: string }) {
    const result = await this.app.completeMfa(input);
    if (!result.success) return result;
    return {
      success: true as const,
      data: {
        accessToken: result.data.accessToken,
        refreshToken: result.data.refreshToken,
        expiresAt: result.data.expiresAt,
        user: toSelfUser(result.data.user),
        flow: result.data.flow,
        factor: result.data.factor,
      },
    };
  }

  async refresh(refreshToken: string, clientId?: string) {
    const result = await this.app.refresh(refreshToken, clientId);
    if (!result.success) return result;
    return { success: true as const, data: { accessToken: result.data.accessToken, refreshToken: result.data.refreshToken, expiresAt: result.data.expiresAt, userId: result.data.userId } };
  }

  logout(refreshToken?: string) {
    return this.app.logout(refreshToken);
  }

  async createPasswordResetToken(email: string) {
    const result = await this.app.createPasswordResetToken(email);
    if (!result.success) return result;
    if (result.data === null) return { success: true as const, data: null };
    return { success: true as const, data: { token: result.data.token, user: toSelfUser(result.data.user) } };
  }

  async resetPasswordWithToken(token: string, newPassword: string) {
    const result = await this.app.resetPasswordWithToken(token, newPassword);
    if (!result.success) return result;
    return { success: true as const, data: toSelfUser(result.data) };
  }
}

class SdkIdentityClient implements IdentitySdk {
  constructor(private readonly app: IdentityApplicationService) {}

  async updateUserProfile(actorId: string, userId: string, updates: Partial<{ name: string; username: string; emailVerified: boolean }>, context?: EventContext) {
    const result = await this.app.updateUserProfile(actorId, userId, updates, context);
    if (!result.success) return result;
    return { success: true as const, data: toPublicUser(result.data) };
  }

  async updatePlatformRole(actorId: string, targetUserId: string, role: "owner" | "user", context?: EventContext) {
    const result = await this.app.updatePlatformRole(actorId, targetUserId, role, context);
    if (!result.success) return result;
    return { success: true as const, data: toPublicUser(result.data) };
  }

  async reviewAccount(actorId: string, targetUserId: string, active: boolean, context?: EventContext) {
    const result = await this.app.reviewAccount(actorId, targetUserId, active, context);
    if (!result.success) return result;
    return { success: true as const, data: toPublicUser(result.data) };
  }

  deactivate(actorId: string, targetUserId: string, context?: EventContext) {
    return this.app.deactivate(actorId, targetUserId, context);
  }

  linkUserIdentity(actorId: string, userId: string, providerId: string, providerType: string, externalSub: string, email?: string) {
    return this.app.linkUserIdentity(actorId, userId, providerId, providerType, externalSub, email);
  }

  getFederationAuthorizeUrl(provider: string, state: string, redirectUri: string) {
    return this.app.getFederationAuthorizeUrl(provider, state, redirectUri);
  }

  async completeFederationLogin(provider: string, code: string, redirectUri: string, application?: FederationApplicationContext) {
    const result = await this.app.completeFederationLogin(provider, code, redirectUri, application);
    if (!result.success) return result;
    return {
      success: true as const,
      data: {
        user: toSelfUser(result.data.user),
        tokens: result.data.tokens,
      },
    };
  }
}

class SdkOrganizationClient implements OrganizationSdk {
  constructor(private readonly app: OrganizationApplicationService) {}

  createOrganization(userId: string, input: { name: string; slug?: string; plan?: string }) {
    return this.app.createOrganization(userId, input);
  }

  getOrganization(userId: string, orgId: string) {
    return this.app.getOrganization(userId, orgId);
  }

  listUserOrganizations(userId: string) {
    return this.app.listUserOrganizations(userId);
  }

  async inviteMember(actorId: string, orgId: string, input: { email: string; role: "owner" | "admin" | "member" }, context?: EventContext) {
    const result = await this.app.inviteMember(actorId, orgId, input, context);
    if (!result.success) return result;
    return { success: true as const, data: { ...result.data, user: toPublicUser(result.data.user) } };
  }

  updateMemberRole(actorId: string, orgId: string, targetUserId: string, role: "owner" | "admin" | "member", context?: EventContext) {
    return this.app.updateMemberRole(actorId, orgId, targetUserId, role, context);
  }

  removeMember(actorId: string, orgId: string, targetUserId: string, context?: EventContext) {
    return this.app.removeMember(actorId, orgId, targetUserId, context);
  }

  async createApplication(actorId: string, orgId: string, input: { name: string; redirectUris?: string[]; allowedOrigins?: string[] }) {
    const result = await this.app.createApplication(actorId, orgId, input);
    if (!result.success) return result;
    const safeApplication = toPublicApplication(result.data);
    return { success: true as const, data: { ...safeApplication, clientSecret: result.data.clientSecret } };
  }

  async listOrganizationApplications(actorId: string, orgId: string) {
    const result = await this.app.listOrganizationApplications(actorId, orgId);
    if (!result.success) return result;
    return { success: true as const, data: result.data.map(toPublicApplication) };
  }

  async updateApplication(actorId: string, orgId: string, appId: string, updates: Partial<{ name: string; redirectUris: string[]; allowedOrigins: string[]; allowedIps: string[]; blockedIps: string[]; isActive: boolean; branding: Record<string, unknown> }>) {
    const result = await this.app.updateApplication(actorId, orgId, appId, updates);
    if (!result.success) return result;
    return { success: true as const, data: toPublicApplication(result.data) };
  }
}

class SdkAuthorizationClient implements AuthorizationSdk {
  constructor(private readonly domain: AuthorizationDomainService) {}

  hasPermission(userId: string, orgId: string, resource: string, action: string) {
    return this.domain.hasOrganizationPermission(userId, orgId, resource, action);
  }

  async requirePermission(userId: string, orgId: string, resource: string, action: string) {
    const result = await this.domain.requireOrganizationPermission(userId, orgId, ["owner", "admin", "member"], resource, action);
    if (!result.success) return result;
    return { success: true as const, data: undefined };
  }

  requireOrgRole(userId: string, orgId: string, allowedRoles: Array<"owner" | "admin" | "member">) {
    return this.domain.requireOrgRole(userId, orgId, allowedRoles);
  }

  isOrgMember(userId: string, orgId: string) {
    return this.domain.isOrgMember(userId, orgId);
  }
}

let cachedSdk: KeystoneSdk | null = null;

export function getSdk(): KeystoneSdk {
  if (cachedSdk) return cachedSdk;
  const container = getContainer();
  const apps = buildApplicationServices(container);
  cachedSdk = {
    authentication: new SdkAuthenticationClient(apps.auth),
    identity: new SdkIdentityClient(apps.identity),
    organization: new SdkOrganizationClient(apps.organization),
    authorization: new SdkAuthorizationClient(apps.authorization),
  };
  return cachedSdk;
}

export function setSdk(sdk: KeystoneSdk): void {
  cachedSdk = sdk;
}

export type { KeystoneSdk, AuthenticationSdk, IdentitySdk, OrganizationSdk, AuthorizationSdk } from "./types.js";
