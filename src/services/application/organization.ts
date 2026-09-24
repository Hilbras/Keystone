import type { OrganizationDomainService } from "../domain/organization.js";
import { canManageOrganizationRole, isOrganizationRole, type AuthorizationDomainService, type OrgRole } from "../domain/authorization.js";
import type { IdentityDomainService } from "../domain/identity.js";
import type { Organization, Application, OrgMembership, User } from "../../db/schema.js";
import { err, type Result } from "../../lib/result.js";
import { emit } from "../events/bus.js";
import type { EventContext } from "../events/types.js";

function eventContext(context?: EventContext) {
  return {
    requestId: context?.requestId,
    ip: context?.ip,
    userAgent: context?.userAgent,
  };
}

export class OrganizationApplicationService {
  constructor(
    private readonly domain: OrganizationDomainService,
    private readonly authorization: AuthorizationDomainService,
    private readonly identity: IdentityDomainService
  ) {}

  private async auditDenied(
    actorId: string,
    orgId: string | undefined,
    action: string,
    targetUserId?: string,
    context?: EventContext
  ): Promise<void> {
    await emit({
      type: "unauthorized_access",
      payload: {
        userId: actorId,
        orgId,
        requestId: context?.requestId,
        ip: context?.ip,
        userAgent: context?.userAgent,
        metadata: { action, targetUserId },
      },
    });
  }

  async createOrganization(
    userId: string,
    input: { name: string; slug?: string; plan?: string }
  ): Promise<Result<Organization>> {
    const actor = await this.identity.findUser(userId);
    if (!actor.success) return actor;
    if (actor.data.role !== "owner" || !actor.data.isActive) {
      await this.auditDenied(userId, undefined, "organization_create");
      return err({ code: "FORBIDDEN", message: "Only platform owners can create organizations", statusCode: 403 });
    }
    return this.domain.createOrganization(input, userId);
  }

  async getOrganization(userId: string, orgId: string): Promise<Result<Organization>> {
    const permission = await this.authorization.requireOrganizationPermission(
      userId,
      orgId,
      ["owner", "admin", "member"],
      "organization",
      "read"
    );
    if (!permission.success) {
      await this.auditDenied(userId, orgId, "organization_read");
      return permission;
    }
    return this.domain.getOrganization(orgId);
  }

  async listUserOrganizations(userId: string): Promise<Organization[]> {
    return this.domain.listUserOrganizations(userId);
  }

  async inviteMember(
    actorId: string,
    orgId: string,
    input: { email: string; role: OrgRole },
    context?: EventContext
  ): Promise<Result<{ user: User; membership: OrgMembership }>> {
    const roleCheck = await this.authorization.requireOrganizationPermission(
      actorId,
      orgId,
      ["owner", "admin"],
      "organization",
      "invite"
    );
    if (!roleCheck.success) {
      await this.auditDenied(actorId, orgId, "organization_invite", undefined, context);
      return roleCheck;
    }
    if (
      !isOrganizationRole(input.role) ||
      !isOrganizationRole(roleCheck.data.role) ||
      !canManageOrganizationRole(roleCheck.data.role, roleCheck.data.role, input.role)
    ) {
      await this.auditDenied(actorId, orgId, "organization_owner_grant", undefined, context);
      return { success: false, error: { code: "INSUFFICIENT_ROLE", message: "Only organization owners can grant the owner role", statusCode: 403 } };
    }

    const userResult = await this.identity.upsertInvitedUser({ email: input.email });
    if (!userResult.success) return userResult;

    const previousMembership = await this.domain.getMembership(orgId, userResult.data.id);
    if (previousMembership.success) {
      return err({ code: "MEMBERSHIP_EXISTS", message: "User is already a member of this organization", statusCode: 409 });
    }
    const membershipResult = await this.domain.addOrgMembership({ orgId, userId: userResult.data.id, role: input.role });
    if (!membershipResult.success) return membershipResult;

    await emit({
      type: "organization_member_invited",
      payload: {
        userId: actorId,
        orgId,
        ...eventContext(context),
        metadata: {
          targetUserId: userResult.data.id,
          previousRole: null,
          newRole: membershipResult.data.role,
          action: "organization_member_invited",
        },
      },
    });

    return { success: true, data: { user: userResult.data, membership: membershipResult.data } };
  }

  async updateMemberRole(
    actorId: string,
    orgId: string,
    targetUserId: string,
    role: OrgRole,
    context?: EventContext
  ): Promise<Result<OrgMembership>> {
    const actorResult = await this.authorization.requireOrganizationPermission(
      actorId,
      orgId,
      ["owner", "admin"],
      "organization",
      "manage_members"
    );
    if (!actorResult.success) {
      await this.auditDenied(actorId, orgId, "organization_member_update", targetUserId, context);
      return actorResult;
    }

    const targetResult = await this.domain.getMembership(orgId, targetUserId);
    if (!targetResult.success) {
      await this.auditDenied(actorId, orgId, "membership_target_not_found", targetUserId, context);
      return targetResult;
    }
    if (!isOrganizationRole(role) || !isOrganizationRole(actorResult.data.role) || !isOrganizationRole(targetResult.data.role)) {
      await this.auditDenied(actorId, orgId, "organization_role_invalid", targetUserId, context);
      return err({ code: "INVALID_ORGANIZATION_ROLE", message: "Invalid organization role", statusCode: 403 });
    }
    if (!canManageOrganizationRole(actorResult.data.role, targetResult.data.role, role)) {
      await this.auditDenied(actorId, orgId, "organization_member_rank", targetUserId, context);
      return err({ code: "INSUFFICIENT_ROLE", message: "Insufficient organization role", statusCode: 403 });
    }

    const result = await this.domain.updateMembershipRole(orgId, targetUserId, role);
    if (!result.success) {
      if (result.error.code === "LAST_OWNER") {
        await this.auditDenied(actorId, orgId, "last_owner_protection", targetUserId, context);
      }
      return result;
    }
    await emit({
      type: "organization_member_role_updated",
      payload: {
        userId: actorId,
        orgId,
        ...eventContext(context),
        metadata: {
          targetUserId,
          previousRole: targetResult.data.role,
          newRole: result.data.role,
          action: "organization_member_role_updated",
        },
      },
    });
    return result;
  }

  async removeMember(actorId: string, orgId: string, targetUserId: string, context?: EventContext): Promise<Result<{ success: boolean }>> {
    const actorResult = await this.authorization.requireOrganizationPermission(
      actorId,
      orgId,
      ["owner", "admin"],
      "organization",
      "manage_members"
    );
    if (!actorResult.success) {
      await this.auditDenied(actorId, orgId, "organization_member_remove", targetUserId, context);
      return actorResult;
    }

    const targetResult = await this.domain.getMembership(orgId, targetUserId);
    if (!targetResult.success) {
      await this.auditDenied(actorId, orgId, "membership_target_not_found", targetUserId, context);
      return targetResult;
    }
    if (!isOrganizationRole(actorResult.data.role) || !isOrganizationRole(targetResult.data.role)) {
      await this.auditDenied(actorId, orgId, "organization_role_invalid", targetUserId, context);
      return err({ code: "INVALID_ORGANIZATION_ROLE", message: "Invalid organization role", statusCode: 403 });
    }
    if (!canManageOrganizationRole(actorResult.data.role, targetResult.data.role, "member")) {
      await this.auditDenied(actorId, orgId, "organization_member_rank", targetUserId, context);
      return err({ code: "INSUFFICIENT_ROLE", message: "Insufficient organization role", statusCode: 403 });
    }

    const result = await this.domain.removeOrgMember(orgId, targetUserId);
    if (!result.success) {
      if (result.error.code === "LAST_OWNER") {
        await this.auditDenied(actorId, orgId, "last_owner_protection", targetUserId, context);
      }
      return result;
    }
    await emit({
      type: "organization_member_removed",
      payload: {
        userId: actorId,
        orgId,
        ...eventContext(context),
        metadata: {
          targetUserId,
          previousRole: targetResult.data.role,
          newRole: null,
          action: "organization_member_removed",
        },
      },
    });
    return result;
  }

  async createApplication(
    actorId: string,
    orgId: string,
    input: { name: string; redirectUris?: string[]; allowedOrigins?: string[] }
  ): Promise<Result<Application & { clientSecret: string }>> {
    const permCheck = await this.authorization.requireOrganizationPermission(
      actorId,
      orgId,
      ["owner", "admin"],
      "application",
      "create"
    );
    if (!permCheck.success) {
      await this.auditDenied(actorId, orgId, "application_create");
      return permCheck;
    }
    return this.domain.createApplication({ orgId, ...input });
  }

  async listOrganizationApplications(
    actorId: string,
    orgId: string
  ): Promise<Result<Application[]>> {
    const roleCheck = await this.authorization.requireOrganizationPermission(
      actorId,
      orgId,
      ["owner", "admin", "member"],
      "application",
      "read"
    );
    if (!roleCheck.success) {
      await this.auditDenied(actorId, orgId, "application_read");
      return roleCheck;
    }
    return { success: true, data: await this.domain.listOrganizationApplications(orgId) };
  }

  async updateApplication(
    actorId: string,
    orgId: string,
    appId: string,
    updates: Partial<{ name: string; redirectUris: string[]; allowedOrigins: string[]; allowedIps: string[]; blockedIps: string[]; isActive: boolean }>
  ): Promise<Result<Application>> {
    const permCheck = await this.authorization.requireOrganizationPermission(
      actorId,
      orgId,
      ["owner", "admin"],
      "application",
      "update"
    );
    if (!permCheck.success) {
      await this.auditDenied(actorId, orgId, "application_update");
      return permCheck;
    }
    return this.domain.updateApplication(appId, orgId, updates);
  }
}
