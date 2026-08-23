import type { KeystoneSdk, AuthenticationSdk, IdentitySdk, OrganizationSdk, AuthorizationSdk } from "./types.js";
import type {
  AuthenticationApplicationService,
  IdentityApplicationService,
  OrganizationApplicationService,
} from "../services/application/index.js";
import type { AuthorizationDomainService } from "../services/domain/authorization.js";
import { getContainer } from "../container.js";
import { buildApplicationServices } from "../di.js";

class SdkAuthenticationClient implements AuthenticationSdk {
  constructor(private readonly app: AuthenticationApplicationService) {}

  register(input: { username: string; email: string; password: string; name?: string; clientId?: string; metadata?: Record<string, unknown> }) {
    return this.app.register(input);
  }

  login(input: { email: string; password: string; clientId?: string }) {
    return this.app.login(input);
  }

  async refresh(refreshToken: string, clientId?: string) {
    const result = await this.app.refresh(refreshToken, clientId);
    if (!result.success) return result;
    return { success: true as const, data: { accessToken: result.data.accessToken, refreshToken: result.data.refreshToken, expiresAt: result.data.expiresAt } };
  }

  logout(refreshToken?: string) {
    return this.app.logout(refreshToken);
  }

  createPasswordResetToken(email: string) {
    return this.app.createPasswordResetToken(email);
  }

  resetPasswordWithToken(token: string, newPassword: string) {
    return this.app.resetPasswordWithToken(token, newPassword);
  }
}

class SdkIdentityClient implements IdentitySdk {
  constructor(private readonly app: IdentityApplicationService) {}

  findUser(id: string) {
    return this.app.findUser(id);
  }

  findUserByEmail(email: string) {
    return this.app.findUserByEmail(email);
  }

  upsertInvitedUser(input: { email: string; name?: string; username?: string }) {
    return this.app.upsertInvitedUser(input);
  }

  updateUserProfile(userId: string, updates: Partial<{ name: string; username: string; role: string; emailVerified: boolean }>) {
    return this.app.updateUserProfile(userId, updates);
  }

  deactivate(userId: string) {
    return this.app.deactivate(userId);
  }

  listOrganizationUsers(orgId: string) {
    return this.app.listOrganizationUsers(orgId);
  }

  linkUserIdentity(userId: string, providerId: string, providerType: string, externalSub: string, email?: string) {
    return this.app.linkUserIdentity(userId, providerId, providerType, externalSub, email);
  }

  getFederationAuthorizeUrl(provider: string, state: string, redirectUri: string) {
    return this.app.getFederationAuthorizeUrl(provider, state, redirectUri);
  }

  completeFederationLogin(provider: string, code: string, redirectUri: string) {
    return this.app.completeFederationLogin(provider, code, redirectUri);
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

  inviteMember(actorId: string, orgId: string, input: { email: string; role: "owner" | "admin" | "member" }) {
    return this.app.inviteMember(actorId, orgId, input);
  }

  createApplication(actorId: string, orgId: string, input: { name: string; redirectUris?: string[]; allowedOrigins?: string[] }) {
    return this.app.createApplication(actorId, orgId, input);
  }

  listOrganizationApplications(actorId: string, orgId: string) {
    return this.app.listOrganizationApplications(actorId, orgId);
  }

  updateApplication(actorId: string, orgId: string, appId: string, updates: Partial<{ name: string; redirectUris: string[]; allowedOrigins: string[]; allowedIps: string[]; blockedIps: string[]; isActive: boolean; branding: Record<string, unknown> }>) {
    return this.app.updateApplication(actorId, orgId, appId, updates);
  }
}

class SdkAuthorizationClient implements AuthorizationSdk {
  constructor(private readonly domain: AuthorizationDomainService) {}

  hasPermission(role: string, resource: string, action: string) {
    return this.domain.hasPermission(role, resource, action);
  }

  requirePermission(role: string, resource: string, action: string) {
    return this.domain.requirePermission(role, resource, action);
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
