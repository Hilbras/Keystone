import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { permissions, rolePermissions, type Permission } from "../db/schema.js";

export type PermissionInput = {
  resource: string;
  action: string;
};

export const DEFAULT_PERMISSIONS: PermissionInput[] = [
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
];

export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
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
  ],
  member: [
    "organization:read",
    "application:read",
    "service_account:read",
    "api_key:read",
  ],
  viewer: ["organization:read", "application:read", "audit_log:read"],
};

export function permissionKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

export async function ensurePermissionsSeeded(): Promise<void> {
  const existing = await db.select().from(permissions);
  const existingKeys = new Set(existing.map((p) => permissionKey(p.resource, p.action)));

  const toInsert = DEFAULT_PERMISSIONS.filter(
    (p) => !existingKeys.has(permissionKey(p.resource, p.action))
  );

  if (toInsert.length > 0) {
    await db.insert(permissions).values(toInsert);
  }
}

export async function ensureRolePermissionsSeeded(): Promise<void> {
  await ensurePermissionsSeeded();
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
  }
}

export async function listPermissions(): Promise<Permission[]> {
  return db.select().from(permissions).orderBy(permissions.resource, permissions.action);
}

export async function listPermissionsForRole(role: string): Promise<Permission[]> {
  const rows = await db
    .select({ permission: permissions })
    .from(rolePermissions)
    .where(eq(rolePermissions.role, role))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id));
  return rows.map((r) => r.permission);
}

export async function listPermissionKeysForRole(role: string): Promise<Set<string>> {
  const perms = await listPermissionsForRole(role);
  return new Set(perms.map((p) => permissionKey(p.resource, p.action)));
}

export async function assignPermissionToRole(role: string, permissionId: string): Promise<void> {
  await db
    .insert(rolePermissions)
    .values({ role, permissionId })
    .onConflictDoNothing({ target: [rolePermissions.role, rolePermissions.permissionId] });
}

export async function removePermissionFromRole(role: string, permissionId: string): Promise<void> {
  await db
    .delete(rolePermissions)
    .where(and(eq(rolePermissions.role, role), eq(rolePermissions.permissionId, permissionId)));
}

export async function hasPermission(role: string, resource: string, action: string): Promise<boolean> {
  const key = permissionKey(resource, action);
  const keys = await listPermissionKeysForRole(role);
  return keys.has(key);
}

export async function hasAnyPermission(role: string, required: PermissionInput[]): Promise<boolean> {
  const keys = await listPermissionKeysForRole(role);
  return required.some((p) => keys.has(permissionKey(p.resource, p.action)));
}

export async function requirePermission(
  role: string,
  resource: string,
  action: string
): Promise<void> {
  const allowed = await hasPermission(role, resource, action);
  if (!allowed) {
    const error = new Error(`Missing permission ${resource}:${action}`) as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}
