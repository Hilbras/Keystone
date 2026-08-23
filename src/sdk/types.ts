import type { User, Organization, Application, OrgMembership } from "../db/schema.js";
import type { Result } from "../lib/result.js";

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface AuthenticationSdk {
  register(input: { username: string; email: string; password: string; name?: string; clientId?: string; metadata?: Record<string, unknown> }): Promise<Result<AuthResponse>>;
  login(input: { email: string; password: string; clientId?: string }): Promise<Result<AuthResponse>>;
  refresh(refreshToken: string, clientId?: string): Promise<Result<{ accessToken: string; refreshToken: string; expiresAt: Date }>>;
  logout(refreshToken?: string): Promise<Result<void>>;
  createPasswordResetToken(email: string): Promise<Result<{ token: string; user: User } | null>>;
  resetPasswordWithToken(token: string, newPassword: string): Promise<Result<User>>;
}

export interface IdentitySdk {
  findUser(id: string): Promise<Result<User>>;
  findUserByEmail(email: string): Promise<Result<User>>;
  upsertInvitedUser(input: { email: string; name?: string; username?: string }): Promise<Result<User>>;
  updateUserProfile(userId: string, updates: Partial<{ name: string; username: string; role: string; emailVerified: boolean }>): Promise<Result<User>>;
  deactivate(userId: string): Promise<Result<void>>;
  listOrganizationUsers(orgId: string): Promise<User[]>;
  linkUserIdentity(userId: string, providerId: string, providerType: string, externalSub: string, email?: string): Promise<Result<void>>;
  getFederationAuthorizeUrl(provider: string, state: string, redirectUri: string): Promise<Result<{ url: string }>>;
  completeFederationLogin(provider: string, code: string, redirectUri: string): Promise<Result<{ user: User; tokens: { accessToken: string; refreshToken: string } }>>;
}

export interface OrganizationSdk {
  createOrganization(userId: string, input: { name: string; slug?: string; plan?: string }): Promise<Result<Organization>>;
  getOrganization(userId: string, orgId: string): Promise<Result<Organization>>;
  listUserOrganizations(userId: string): Promise<Organization[]>;
  inviteMember(actorId: string, orgId: string, input: { email: string; role: "owner" | "admin" | "member" }): Promise<Result<{ user: { id: string }; membership: OrgMembership }>>;
  createApplication(actorId: string, orgId: string, input: { name: string; redirectUris?: string[]; allowedOrigins?: string[] }): Promise<Result<Application & { clientSecret: string }>>;
  listOrganizationApplications(actorId: string, orgId: string): Promise<Result<Application[]>>;
  updateApplication(actorId: string, orgId: string, appId: string, updates: Partial<{ name: string; redirectUris: string[]; allowedOrigins: string[]; allowedIps: string[]; blockedIps: string[]; isActive: boolean; branding: Record<string, unknown> }>): Promise<Result<Application>>;
}

export interface AuthorizationSdk {
  hasPermission(role: string, resource: string, action: string): Promise<boolean>;
  requirePermission(role: string, resource: string, action: string): Promise<Result<void>>;
  requireOrgRole(userId: string, orgId: string, allowedRoles: Array<"owner" | "admin" | "member">): Promise<Result<OrgMembership>>;
  isOrgMember(userId: string, orgId: string): Promise<OrgMembership | undefined>;
}

export interface KeystoneSdk {
  authentication: AuthenticationSdk;
  identity: IdentitySdk;
  organization: OrganizationSdk;
  authorization: AuthorizationSdk;
}
