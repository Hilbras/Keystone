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
    appId: context?.appId,
  };
}

export class OrganizationApplicationService {
  constructor(
    private readonly domain: OrganizationDomainService,
    private readonly authorization: AuthorizationDomainService,
    private readonly identity: IdentityDomainService
  ) {}

  async createOrganization(
    userId: string,
    input: { name: string; slug?: string; plan?: string }
  ): Promise<Result<Organization>> {
    return this.domain.createOrganization(input, userId);
  }

  async getOrganization(userId: string, orgId: string): Promise<Result<Organization>> {
    const membership = await this.authorization.isOrgMember(userId, orgId);
    if (!membership) return { success: false, error: { code: "NOT_MEMBER", message: "Not a member", statusCode: 403 } };
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
    const roleCheck = await this.authorization.requireOrgRole(actorId, orgId, ["owner", "admin"]);
    if (!roleCheck.success) return roleCheck;
    if (!isOrganizationRole(roleCheck.data.role) || !canManageOrganizationRole(roleCheck.data.role, roleCheck.data.role, input.role)) {
      return { success: false, error: { code: "INSUFFICIENT_ROLE", message: "Only organization owners can grant the owner role", statusCode: 403 } };
    }

    const userResult = await this.identity.upsertInvitedUser({ email: input.email });
    if (!userResult.success) return userResult;

    const previousMembership = await this.domain.getMembership(orgId, userResult.data.id);
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
          previousRole: previousMembership.success ? previousMembership.data.role : null,
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
    const actorResult = await this.authorization.requireOrgRole(actorId, orgId, ["owner", "admin"]);
    if (!actorResult.success) return actorResult;

    const targetResult = await this.domain.getMembership(orgId, targetUserId);
    if (!targetResult.success) return targetResult;
    if (!isOrganizationRole(actorResult.data.role) || !isOrganizationRole(targetResult.data.role)) {
      return err({ code: "INVALID_ORGANIZATION_ROLE", message: "Invalid organization role", statusCode: 403 });
    }
    if (!canManageOrganizationRole(actorResult.data.role, targetResult.data.role, role)) {
      return err({ code: "INSUFFICIENT_ROLE", message: "Insufficient organization role", statusCode: 403 });
    }

    const result = await this.domain.updateMembershipRole(orgId, targetUserId, role);
    if (!result.success) return result;
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
    const actorResult = await this.authorization.requireOrgRole(actorId, orgId, ["owner", "admin"]);
    if (!actorResult.success) return actorResult;

    const targetResult = await this.domain.getMembership(orgId, targetUserId);
    if (!targetResult.success) return targetResult;
    if (!isOrganizationRole(actorResult.data.role) || !isOrganizationRole(targetResult.data.role)) {
      return err({ code: "INVALID_ORGANIZATION_ROLE", message: "Invalid organization role", statusCode: 403 });
    }
    if (!canManageOrganizationRole(actorResult.data.role, targetResult.data.role, "member")) {
      return err({ code: "INSUFFICIENT_ROLE", message: "Insufficient organization role", statusCode: 403 });
    }

    const result = await this.domain.removeOrgMember(orgId, targetUserId);
    if (!result.success) return result;
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
    const permCheck = await this.authorization.requireOrgRole(actorId, orgId, ["owner", "admin"]);
    if (!permCheck.success) return permCheck;
    return this.domain.createApplication({ orgId, ...input });
  }

  async listOrganizationApplications(
    actorId: string,
    orgId: string
  ): Promise<Result<Application[]>> {
    const roleCheck = await this.authorization.requireOrgRole(actorId, orgId, ["owner", "admin", "member"]);
    if (!roleCheck.success) return roleCheck;
    return { success: true, data: await this.domain.listOrganizationApplications(orgId) };
  }

  async updateApplication(
    actorId: string,
    orgId: string,
    appId: string,
    updates: Partial<{ name: string; redirectUris: string[]; allowedOrigins: string[]; allowedIps: string[]; blockedIps: string[]; isActive: boolean }>
  ): Promise<Result<Application>> {
    const permCheck = await this.authorization.requireOrgRole(actorId, orgId, ["owner", "admin"]);
    if (!permCheck.success) return permCheck;
    return this.domain.updateApplication(appId, orgId, updates);
  }
}
