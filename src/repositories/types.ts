import type { User, Organization, OrgMembership, Application, auditLog, Permission } from "../db/schema.js";

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
  username?: string;
  role?: string;
  emailVerified?: boolean;
}

export interface UserRepository {
  findById(id: string): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  create(input: CreateUserInput): Promise<User>;
  update(id: string, input: UpdateUserInput): Promise<User | undefined>;
  deactivate(id: string): Promise<void>;
  listByOrg(orgId: string): Promise<User[]>;
  updateLastSeen(id: string): Promise<void>;
  ensureUniqueUsername(base: string, excludeId?: string): Promise<string>;
  recordFailedLogin(id: string): Promise<User | undefined>;
  resetFailedLogins(id: string): Promise<void>;
  lockAccount(id: string, until: Date): Promise<void>;
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  plan?: string;
}

export interface OrganizationRepository {
  create(input: CreateOrganizationInput): Promise<Organization>;
  findById(id: string): Promise<Organization | undefined>;
  findBySlug(slug: string): Promise<Organization | undefined>;
  listByUserId(userId: string): Promise<Organization[]>;
  addMembership(input: { orgId: string; userId: string; role: string }): Promise<OrgMembership>;
  findMembership(orgId: string, userId: string): Promise<OrgMembership | undefined>;
  updateMembershipRole(orgId: string, userId: string, role: string): Promise<OrgMembership | undefined>;
  removeMembership(orgId: string, userId: string): Promise<boolean>;
  countOwners(orgId: string): Promise<number>;
  listMembers(orgId: string): Promise<{ membership: OrgMembership; user: { id: string; email: string; username: string; name: string | null; avatarUrl: string | null } }[]>;
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
  create(input: CreateApplicationInput): Promise<Application & { clientSecret: string }>;
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
  assignToRole(role: string, permissionId: string): Promise<void>;
  removeFromRole(role: string, permissionId: string): Promise<void>;
  hasPermission(role: string, resource: string, action: string): Promise<boolean>;
  hasAnyPermission(role: string, required: { resource: string; action: string }[]): Promise<boolean>;
}
