import type { OrgMembership } from "../../db/schema.js";
import type { OrganizationRepository, PermissionRepository } from "../../repositories/types.js";
import { ok, err, type Result } from "../../lib/result.js";

export interface PermissionInput {
  resource: string;
  action: string;
}

export { type PermissionInput as PermissionRequirement };
export type OrgRole = "owner" | "admin" | "member";

export class AuthorizationDomainService {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly permissions: PermissionRepository
  ) {}

  async requirePermission(role: string, resource: string, action: string): Promise<Result<void>> {
    const allowed = await this.permissions.hasPermission(role, resource, action);
    if (!allowed) {
      return err({ code: "FORBIDDEN", message: `Missing permission ${resource}:${action}`, statusCode: 403 });
    }
    return ok(undefined);
  }

  async hasPermission(role: string, resource: string, action: string): Promise<boolean> {
    return this.permissions.hasPermission(role, resource, action);
  }

  async hasAnyPermission(role: string, required: PermissionInput[]): Promise<boolean> {
    return this.permissions.hasAnyPermission(role, required);
  }

  async requireOrgRole(userId: string, orgId: string, allowedRoles: OrgRole[]): Promise<Result<OrgMembership>> {
    const membership = await this.organizations.findMembership(orgId, userId);
    if (!membership) {
      return err({ code: "NOT_MEMBER", message: "Not a member of this organization", statusCode: 403 });
    }
    if (!allowedRoles.includes(membership.role as OrgRole)) {
      return err({ code: "INSUFFICIENT_ROLE", message: "Insufficient organization permissions", statusCode: 403 });
    }
    return ok(membership);
  }

  async isOrgMember(userId: string, orgId: string): Promise<OrgMembership | undefined> {
    return this.organizations.findMembership(orgId, userId);
  }
}
