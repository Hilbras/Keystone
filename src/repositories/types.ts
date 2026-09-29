import type {
  User,
  Organization,
  OrgMembership,
  Application,
  auditLog,
  MfaChallenge,
  Permission,
  Workflow,
  ScimConnection,
  ScimGroup,
  organizations,
  applications,
} from "../db/schema.js";

export class LastOwnerInvariantError extends Error {
  readonly code = "LAST_OWNER" as const;

  constructor(message = "The last owner cannot be removed or demoted") {
    super(message);
    this.name = "LastOwnerInvariantError";
  }
}

export interface CreateUserInput {
  email: string;
  username: string;
  name: string;
  passwordHash?: string | null;
  provider?: string;
  emailVerified?: boolean;
  avatarUrl?: string | null;
  zitadelUserId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  username?: string;
  emailVerified?: boolean;
  avatarUrl?: string | null;
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  isActive?: boolean;
  accountReviewRequired?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UserRepository {
  findById(id: string): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  create(input: CreateUserInput): Promise<User>;
  update(id: string, input: UpdateUserInput): Promise<User | undefined>;
  updateRole(id: string, role: "owner" | "user"): Promise<User | undefined>;
  deactivate(id: string): Promise<void>;
  listByOrg(orgId: string): Promise<User[]>;
  listAll(): Promise<User[]>;
  countByRole(role: string): Promise<number>;
  updateLastSeen(id: string): Promise<void>;
  ensureUniqueUsername(base: string, excludeId?: string): Promise<string>;
  recordFailedLogin(id: string): Promise<User | undefined>;
  resetFailedLogins(id: string): Promise<void>;
  lockAccount(id: string, until: Date): Promise<void>;
  /** Resolve a user only through a membership in `orgId`. */
  findByIdInOrg(orgId: string, userId: string): Promise<User | undefined>;
  /**
   * Update a user only when they are a member of `orgId`. Returns undefined
   * when the user is outside the organization, so callers cannot accidentally
   * fall back to a global update.
   */
  updateInOrg(orgId: string, userId: string, input: UpdateUserInput): Promise<User | undefined>;
  /** Organizations the user belongs to. */
  listOrgIdsForUser(userId: string): Promise<string[]>;
  /**
   * Remove a user from an organization as seen by SCIM.
   *
   * `outcome` distinguishes the two cases that matter for tenant safety:
   *  - `membership_removed` — the user belongs to other organizations, so only
   *    this membership is removed and the shared account is left untouched.
   *  - `deactivated` — the organization was the user's only membership, so the
   *    account itself is deactivated and its sessions are revoked.
   */
  removeFromOrg(
    orgId: string,
    userId: string
  ): Promise<
    | { outcome: "membership_removed" | "deactivated" | "not_found" | "last_owner"; user?: User }
    | undefined
  >;
  setTotpSecret(userId: string, totpSecret: string): Promise<void>;
  enableTotp(userId: string): Promise<void>;
  disableTotp(userId: string): Promise<void>;
  deleteById(userId: string): Promise<void>;
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  plan?: string;
}

export interface OrganizationRepository {
  createWithOwner(input: CreateOrganizationInput, userId: string): Promise<Organization>;
  findById(id: string): Promise<Organization | undefined>;
  findBySlug(slug: string): Promise<Organization | undefined>;
  listByUserId(userId: string): Promise<Organization[]>;
  listAll(): Promise<Organization[]>;
  update(id: string, input: { name?: string; branding?: Record<string, unknown> }): Promise<Organization | undefined>;
  countMembers(orgId: string): Promise<number>;
  addMembership(input: { orgId: string; userId: string; role: "owner" | "admin" | "member" }): Promise<OrgMembership>;
  findMembership(orgId: string, userId: string): Promise<OrgMembership | undefined>;
  updateMembershipRole(orgId: string, userId: string, role: "owner" | "admin" | "member"): Promise<OrgMembership | undefined>;
  removeMembership(orgId: string, userId: string): Promise<boolean>;
  countOwners(orgId: string): Promise<number>;
  listMembers(orgId: string): Promise<{ membership: OrgMembership; user: { id: string; email: string; username: string; name: string | null; avatarUrl: string | null; platformRole: string } }[]>;
}

export interface IdentityLinkInput {
  userId: string;
  providerId: string;
  providerType: string;
  externalSub: string;
  email?: string;
  profile?: Record<string, unknown>;
}

export interface IdentityRepository {
  link(input: IdentityLinkInput): Promise<void>;
  findLinkedByExternalSub(providerId: string, externalSub: string): Promise<User | undefined>;
  listByUserId(userId: string): Promise<{ identity: any; provider: { id: string; name: string; providerType: string } }[]>;
}

export type MfaFlow = "login" | "token_login";
export type MfaChallengeStatus = "requires_mfa" | "consumed" | "failed" | "expired";

export interface CreateMfaChallengeInput {
  challengeHash: string;
  userId: string;
  flow: MfaFlow;
  clientId?: string;
  ipAddress?: string;
  userAgent?: string;
  expiresAt: Date;
  maxAttempts: number;
}

export interface MfaChallengeRepository {
  create(input: CreateMfaChallengeInput): Promise<MfaChallenge>;
  findByHash(challengeHash: string): Promise<MfaChallenge | undefined>;
  /** Atomically record a failed attempt; returns the updated challenge or undefined when already locked. */
  recordFailedAttempt(id: string, now: Date): Promise<MfaChallenge | undefined>;
  /** Atomically consume an active challenge; returns undefined when missing, expired, or already consumed. */
  consume(id: string, now: Date): Promise<MfaChallenge | undefined>;
  /** Mark every outstanding challenge for a user as failed (used when a factor is enrolled/reset). */
  invalidateUserChallenges(userId: string, now: Date): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
}

export interface CreateScimConnectionInput {
  orgId: string;
  name: string;
  tokenHash: string;
  tokenHint: string;
  previousTokenHash?: string | null;
  previousTokenValidUntil?: Date | null;
  createdByUserId?: string | null;
  expiresAt?: Date | null;
}

export interface ScimConnectionRepository {
  create(input: CreateScimConnectionInput): Promise<ScimConnection>;
  findById(id: string): Promise<ScimConnection | undefined>;
  findActiveByOrg(orgId: string): Promise<ScimConnection | undefined>;
  listByOrg(orgId: string): Promise<ScimConnection[]>;
  listAll(): Promise<ScimConnection[]>;
  /** Resolve a presented token; accepts the grace-period token until its deadline. */
  findByTokenHash(tokenHash: string, now?: Date): Promise<ScimConnection | undefined>;
  rotate(
    id: string,
    input: { tokenHash: string; tokenHint: string; graceSeconds: number; now?: Date }
  ): Promise<ScimConnection | undefined>;
  revoke(id: string, now?: Date): Promise<ScimConnection | undefined>;
  touch(id: string, now?: Date): Promise<void>;
  deleteRevokedBefore(cutoff: Date): Promise<number>;
}

export interface CreateScimGroupInput {
  orgId: string;
  displayName: string;
  description?: string | null;
  externalId?: string | null;
}

export interface ScimGroupRepository {
  create(input: CreateScimGroupInput): Promise<ScimGroup>;
  /** Groups are always looked up through their organization, never by id alone. */
  findByIdInOrg(orgId: string, groupId: string): Promise<ScimGroup | undefined>;
  listByOrg(orgId: string): Promise<ScimGroup[]>;
  updateInOrg(
    orgId: string,
    groupId: string,
    input: { displayName?: string; description?: string | null; externalId?: string | null }
  ): Promise<ScimGroup | undefined>;
  deleteInOrg(orgId: string, groupId: string): Promise<boolean>;
  listMembers(orgId: string, groupId: string): Promise<{ userId: string; email: string; name: string | null }[]>;
  listMembersForGroups(orgId: string, groupIds: string[]): Promise<Map<string, { userId: string; email: string; name: string | null }[]>>;
  addMember(orgId: string, groupId: string, userId: string): Promise<boolean>;
  removeMember(orgId: string, groupId: string, userId: string): Promise<boolean>;
  /**
   * Make the group's membership exactly `submittedUserIds`, atomically.
   *
   * `rejected` lists submitted users that are not members of `orgId`; when it is
   * non-empty nothing was written. The caller decides what a rejection means.
   */
  reconcileMembers(
    orgId: string,
    groupId: string,
    submittedUserIds: string[]
  ): Promise<{ added: number; removed: number; rejected: string[] }>;
}

export interface WorkflowRepository {
  listByOrg(orgId: string): Promise<Workflow[]>;
  /** No `orgId` filter: the route guard has already established the tenancy. */
  findById(id: string): Promise<Workflow | undefined>;
  delete(id: string): Promise<Workflow | undefined>;
}


/**
 * The columns `GET /platform/users` returns.
 *
 * Declared here rather than derived from the table so the projection is a
 * deliberate list. `passwordHash` is absent, and it stays absent unless somebody
 * adds it here on purpose.
 */
export interface PlatformUser {
  id: string;
  email: string;
  username: string;
  name: string | null;
  role: string;
  isActive: boolean;
  accountReviewRequired: boolean | null;
  emailVerified: boolean;
  createdAt: Date;
}

export type PlatformOrganization = typeof organizations.$inferSelect;
export type PlatformApplication = Pick<
  typeof applications.$inferSelect,
  | "id"
  | "orgId"
  | "clientId"
  | "name"
  | "redirectUris"
  | "allowedOrigins"
  | "allowedIps"
  | "blockedIps"
  | "branding"
  | "isActive"
  | "createdAt"
  | "updatedAt"
>;

export interface PlatformDailySeries {
  date: string;
  logins: number;
  failedLogins: number;
  signups: number;
  dau: number;
}

export interface PlatformRecentAuthEvent {
  id: string;
  event: string;
  userId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface PlatformSecuritySummary {
  logins: number;
  failedLogins: number;
  activeSessions: number;
  mfaUsers: number;
  totalUsers: number;
  newDeviceEvents: number;
  recentLogins: PlatformRecentAuthEvent[];
  recentFailedLogins: PlatformRecentAuthEvent[];
}

/**
 * Platform-owner reads, deliberately unscoped by organization.
 *
 * Every other repository query in this codebase is filtered by an organization,
 * and that filter is the tenancy guarantee. These are not, because a platform
 * owner is asking about the whole installation. They are grouped under one
 * interface so that the queries which are exempt from tenancy, and why, are
 * visible in one place.
 */
export interface PlatformRepository {
  listUsers(): Promise<PlatformUser[]>;
  listOrganizations(): Promise<PlatformOrganization[]>;
  listApplications(): Promise<PlatformApplication[]>;
  dailySeries(since: Date): Promise<PlatformDailySeries[]>;
  securitySummary(now: Date): Promise<PlatformSecuritySummary>;
}

export interface AuditRepository {
  list(opts: {
    orgId?: string;
    appId?: string;
    userId?: string;
    event?: string;
    limit?: number;
    offset?: number;
  }): Promise<typeof auditLog.$inferSelect[]>;
}

export interface CreateApplicationInput {
  orgId: string;
  name: string;
  redirectUris?: string[];
  allowedOrigins?: string[];
  clientId?: string;
  clientSecret?: string;
  /** `public` clients are issued no secret and must authenticate with PKCE. */
  clientType?: "confidential" | "public";
  /** Scopes the client is registered to request. Empty means unrestricted. */
  allowedScopes?: string[];
}

export interface UpdateApplicationInput {
  name?: string;
  redirectUris?: string[];
  allowedOrigins?: string[];
  allowedIps?: string[];
  blockedIps?: string[];
  isActive?: boolean;
  branding?: Record<string, unknown>;
}

export interface ApplicationRepository {
  create(input: CreateApplicationInput): Promise<Application & { clientSecret: string | null }>;
  findByClientId(clientId: string): Promise<Application | undefined>;
  listByOrgId(orgId: string): Promise<Application[]>;
  update(appId: string, orgId: string, input: UpdateApplicationInput): Promise<Application | undefined>;
  verifyClientSecret(clientId: string, secret: string): Promise<Application | undefined>;
}

export interface PermissionRepository {
  ensureSeeded(): Promise<void>;
  ensureRolePermissionsSeeded(): Promise<void>;
  list(): Promise<Permission[]>;
  listForRole(role: string): Promise<Permission[]>;
  listKeysForRole(role: string): Promise<Set<string>>;
  listDistinctRoles(): Promise<string[]>;
  create(input: { resource: string; action: string; description?: string }): Promise<Permission>;
  remove(id: string): Promise<Permission | undefined>;
  assignToRole(role: string, permissionId: string): Promise<void>;
  removeFromRole(role: string, permissionId: string): Promise<void>;
  hasPermission(role: string, resource: string, action: string): Promise<boolean>;
  hasAnyPermission(role: string, required: { resource: string; action: string }[]): Promise<boolean>;
}
