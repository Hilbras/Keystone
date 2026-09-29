import { eq, and, notInArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { permissions, rolePermissions, orgMemberships, type Permission } from "../db/schema.js";
import type { PermissionRepository } from "./types.js";
import {
  getCachedRolePermissions,
  setCachedRolePermissions,
  invalidateRolePermissions,
  invalidateAllRolePermissions,
} from "../services/permissionCache.js";

const ORGANIZATION_ROLES = new Set(["owner", "admin", "member"]);

function assertOrganizationRole(role: string): void {
  if (!ORGANIZATION_ROLES.has(role)) throw new Error("Invalid organization role");
}

const DEFAULT_PERMISSIONS = [
  { resource: "organization", action: "read" },
  { resource: "organization", action: "update" },
  { resource: "organization", action: "delete" },
  { resource: "organization", action: "invite" },
  { resource: "organization", action: "manage_members" },
  { resource: "application", action: "read" },
  { resource: "application", action: "create" },
  { resource: "application", action: "update" },
  { resource: "application", action: "delete" },
  { resource: "service_account", action: "read" },
  { resource: "service_account", action: "create" },
  { resource: "service_account", action: "update" },
  { resource: "service_account", action: "delete" },
  { resource: "api_key", action: "read" },
  { resource: "api_key", action: "create" },
  { resource: "api_key", action: "revoke" },
  { resource: "audit_log", action: "read" },
  { resource: "sso_connection", action: "read" },
  { resource: "sso_connection", action: "manage" },
  { resource: "billing", action: "read" },
  { resource: "billing", action: "update" },
];

const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`),
  admin: [
    "organization:read",
    "organization:update",
    "organization:invite",
    "organization:manage_members",
    "application:read",
    "application:create",
    "application:update",
    "service_account:read",
    "service_account:create",
    "service_account:update",
    "api_key:read",
    "api_key:create",
    "api_key:revoke",
    "audit_log:read",
    "sso_connection:read",
    "sso_connection:manage",
    "billing:read",
    "billing:update",
  ],
  member: [
    "organization:read",
    "application:read",
    "service_account:read",
    "api_key:read",
    "sso_connection:read",
  ],
};

function permissionKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

export class DrizzlePermissionRepository implements PermissionRepository {
  async ensureSeeded(): Promise<void> {
    const existing = await db.select().from(permissions);
    const existingKeys = new Set(existing.map((p) => permissionKey(p.resource, p.action)));

    const toInsert = DEFAULT_PERMISSIONS.filter(
      (p) => !existingKeys.has(permissionKey(p.resource, p.action))
    );

    if (toInsert.length > 0) {
      await db.insert(permissions).values(toInsert);
      // A new permission changes the key set of any role it is granted to, and
      // the grant may already exist, so every cached set is potentially stale.
      await invalidateAllRolePermissions();
    }
  }

  async ensureRolePermissionsSeeded(): Promise<void> {
    await db.delete(rolePermissions).where(notInArray(rolePermissions.role, ["owner", "admin", "member"]));
    await this.ensureSeeded();
    const allPermissions = await db.select().from(permissions);
    const permissionByKey = new Map(allPermissions.map((p) => [permissionKey(p.resource, p.action), p.id]));

    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      const permissionIds = perms
        .map((key) => permissionByKey.get(key))
        .filter((id): id is string => Boolean(id));

      for (const permissionId of permissionIds) {
        await db
          .insert(rolePermissions)
          .values({ role, permissionId })
          .onConflictDoNothing({ target: [rolePermissions.role, rolePermissions.permissionId] });
      }
      // Once per role rather than once per row: `owner` has twenty-two, and
      // twenty-two round trips to publish one answer is twenty-one too many.
      await invalidateRolePermissions(role);
    }
  }

  async list(): Promise<Permission[]> {
    return db.select().from(permissions).orderBy(permissions.resource, permissions.action);
  }

  async listDistinctRoles(): Promise<string[]> {
    const rows = await db.selectDistinct({ role: rolePermissions.role }).from(rolePermissions);
    const roles = new Set<string>(["owner", "admin", "member"]);
    for (const row of rows) {
      if (ORGANIZATION_ROLES.has(row.role)) roles.add(row.role);
    }
    const memberships = await db.selectDistinct({ role: orgMemberships.role }).from(orgMemberships);
    for (const membership of memberships) {
      if (ORGANIZATION_ROLES.has(membership.role)) roles.add(membership.role);
    }
    return [...roles].sort();
  }

  async create(input: { resource: string; action: string; description?: string }): Promise<Permission> {
    const [created] = await db
      .insert(permissions)
      .values({ resource: input.resource, action: input.action, description: input.description ?? null })
      .onConflictDoNothing({ target: [permissions.resource, permissions.action] })
      .returning();
    // Even when the insert was a no-op: an idempotent create is still a caller
    // asking about permissions, and the admin UI refetches the role afterwards.
    await invalidateAllRolePermissions();
    return created;
  }

  async remove(id: string): Promise<Permission | undefined> {
    const [removed] = await db.delete(permissions).where(eq(permissions.id, id)).returning();
    // A deleted permission cascades to `role_permissions`, so every role's set
    // may have shrunk. Invalidating only the affected role is not knowable here
    // without reading the join first, and a miss would leave a permission alive.
    await invalidateAllRolePermissions();
    return removed;
  }

  async listForRole(role: string): Promise<Permission[]> {
    const rows = await db
      .select({ permission: permissions })
      .from(rolePermissions)
      .where(eq(rolePermissions.role, role))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id));
    return rows.map((r) => r.permission);
  }

  /**
   * The permission keys a role holds. The hottest read in the system.
   *
   * This runs on every organization-scoped request, and it is two queries — a
   * scan of `role_permissions` filtered by role, and a join to `permissions`.
   * At the catalogue's real size that is about 0.29ms and five buffers, so the
   * database was never slow; the cost was paying it again per request for an
   * answer that changes about once a deployment.
   *
   * Cached in Redis, and only in Redis. A miss or an error reads the database —
   * never an in-process copy, because a fallback copy has no invalidation path
   * and a revoked permission would keep being honoured by whichever instance
   * happened to hold it. See `../services/permissionCache.ts`.
   */
  async listKeysForRole(role: string): Promise<Set<string>> {
    const cached = await getCachedRolePermissions(role);
    if (cached) return new Set(cached);

    const perms = await this.listForRole(role);
    const keys = perms.map((p) => permissionKey(p.resource, p.action));
    // An empty set is not cached. It is far more likely to be a role that does
    // not exist than a role with no permissions, and caching "nothing" for it
    // means a role that is later granted permissions keeps nothing until the TTL
    // runs out — a grant that silently does not take effect.
    if (keys.length > 0) await setCachedRolePermissions(role, keys);
    return new Set(keys);
  }

  async assignToRole(role: string, permissionId: string): Promise<void> {
    assertOrganizationRole(role);
    await db
      .insert(rolePermissions)
      .values({ role, permissionId })
      .onConflictDoNothing({ target: [rolePermissions.role, rolePermissions.permissionId] });
    // After the write, not before: a read landing between the two would refill the
    // cache from a database that no longer matches the answer being published, and
    // nothing would invalidate it again.
    await invalidateRolePermissions(role);
  }

  async removeFromRole(role: string, permissionId: string): Promise<void> {
    assertOrganizationRole(role);
    await db
      .delete(rolePermissions)
      .where(and(eq(rolePermissions.role, role), eq(rolePermissions.permissionId, permissionId)));
    // Revocation takes effect on the next request. A revoked permission that
    // survives in a cache is a security defect, not a trade-off, so this one
    // write cannot rely on the TTL.
    await invalidateRolePermissions(role);
  }

  async hasPermission(role: string, resource: string, action: string): Promise<boolean> {
    const key = permissionKey(resource, action);
    const keys = await this.listKeysForRole(role);
    return keys.has(key);
  }

  async hasAnyPermission(role: string, required: { resource: string; action: string }[]): Promise<boolean> {
    const keys = await this.listKeysForRole(role);
    return required.some((p) => keys.has(permissionKey(p.resource, p.action)));
  }
}
