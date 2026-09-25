import type { Organization, OrgMembership } from "../db/schema.js";
import type { PublicApplication, PublicUser, SelfUser } from "../types.js";
import type { Result } from "../lib/result.js";
import type { EventContext } from "../services/events/types.js";
import type { FederationApplicationContext } from "../services/federation.js";

export interface AuthResponse {
  user: SelfUser;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * The password step succeeded but MFA is enabled. No tokens are present; call
 * `completeMfa` with `challenge` to obtain them.
 */
export interface MfaRequiredResponse {
  status: "requires_mfa";
  user: SelfUser;
  challenge: string;
  expiresAt: Date;
  flow: "login" | "token_login";
  clientId?: string;
}

export type LoginResponse =
  | { status: "authenticated"; data: AuthResponse }
  | { status: "requires_mfa"; data: MfaRequiredResponse };

export interface MfaCompleteResponse extends AuthResponse {
  flow: "login" | "token_login";
  factor: "totp" | "backup_code";
  clientId?: string;
}

export interface AuthenticationSdk {
  register(input: { username: string; email: string; password: string; name?: string; clientId?: string; metadata?: Record<string, unknown> }): Promise<Result<AuthResponse>>;
  login(input: { email: string; password: string; clientId?: string; flow?: "login" | "token_login" }): Promise<Result<LoginResponse>>;
  completeMfa(input: { challenge: string; code: string; factor?: "totp" | "backup_code"; ipAddress?: string; userAgent?: string }): Promise<Result<MfaCompleteResponse>>;
  refresh(refreshToken: string, clientId?: string): Promise<Result<{ accessToken: string; refreshToken: string; expiresAt: Date; userId?: string }>>;
  logout(refreshToken?: string): Promise<Result<void>>;
  createPasswordResetToken(email: string): Promise<Result<{ token: string; user: SelfUser } | null>>;
  resetPasswordWithToken(token: string, newPassword: string): Promise<Result<SelfUser>>;
}

export interface IdentitySdk {
  updateUserProfile(actorId: string, userId: string, updates: Partial<{ name: string; username: string; emailVerified: boolean }>, context?: EventContext): Promise<Result<PublicUser>>;
  updatePlatformRole(actorId: string, targetUserId: string, role: "owner" | "user", context?: EventContext): Promise<Result<PublicUser>>;
  deactivate(actorId: string, targetUserId: string, context?: EventContext): Promise<Result<void>>;
  reviewAccount(actorId: string, targetUserId: string, active: boolean, context?: EventContext): Promise<Result<PublicUser>>;
  linkUserIdentity(actorId: string, userId: string, providerId: string, providerType: string, externalSub: string, email?: string): Promise<Result<void>>;
  getFederationAuthorizeUrl(provider: string, state: string, redirectUri: string): Promise<Result<{ url: string }>>;
  completeFederationLogin(provider: string, code: string, redirectUri: string, application?: FederationApplicationContext): Promise<Result<{ user: SelfUser; tokens: { accessToken: string; refreshToken: string } }>>;
}

export interface OrganizationSdk {
  createOrganization(userId: string, input: { name: string; slug?: string; plan?: string }): Promise<Result<Organization>>;
  getOrganization(userId: string, orgId: string): Promise<Result<Organization>>;
  listUserOrganizations(userId: string): Promise<Organization[]>;
  inviteMember(actorId: string, orgId: string, input: { email: string; role: "owner" | "admin" | "member" }, context?: EventContext): Promise<Result<{ user: PublicUser; membership: OrgMembership }>>;
  updateMemberRole(actorId: string, orgId: string, targetUserId: string, role: "owner" | "admin" | "member", context?: EventContext): Promise<Result<OrgMembership>>;
  removeMember(actorId: string, orgId: string, targetUserId: string, context?: EventContext): Promise<Result<{ success: boolean }>>;
  createApplication(actorId: string, orgId: string, input: { name: string; redirectUris?: string[]; allowedOrigins?: string[] }): Promise<Result<PublicApplication & { clientSecret: string }>>;
  listOrganizationApplications(actorId: string, orgId: string): Promise<Result<PublicApplication[]>>;
  updateApplication(actorId: string, orgId: string, appId: string, updates: Partial<{ name: string; redirectUris: string[]; allowedOrigins: string[]; allowedIps: string[]; blockedIps: string[]; isActive: boolean; branding: Record<string, unknown> }>): Promise<Result<PublicApplication>>;
}

export interface AuthorizationSdk {
  hasPermission(userId: string, orgId: string, resource: string, action: string): Promise<boolean>;
  requirePermission(userId: string, orgId: string, resource: string, action: string): Promise<Result<void>>;
  requireOrgRole(userId: string, orgId: string, allowedRoles: Array<"owner" | "admin" | "member">): Promise<Result<OrgMembership>>;
  isOrgMember(userId: string, orgId: string): Promise<OrgMembership | undefined>;
}

export interface KeystoneSdk {
  authentication: AuthenticationSdk;
  identity: IdentitySdk;
  organization: OrganizationSdk;
  authorization: AuthorizationSdk;
}
