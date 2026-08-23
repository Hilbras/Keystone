import type { OrganizationDomainService } from "../domain/organization.js";
import type { AuthorizationDomainService, OrgRole } from "../domain/authorization.js";
import type { IdentityDomainService } from "../domain/identity.js";
import type { Organization, Application, OrgMembership } from "../../db/schema.js";
import type { Result } from "../../lib/result.js";

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
    input: { email: string; role: OrgRole }
  ): Promise<Result<{ user: { id: string }; membership: OrgMembership }>> {
    const roleCheck = await this.authorization.requireOrgRole(actorId, orgId, ["owner", "admin"]);
    if (!roleCheck.success) return roleCheck;

    const userResult = await this.identity.upsertInvitedUser({ email: input.email });
    if (!userResult.success) return userResult;

    const membershipResult = await this.domain.addOrgMembership({ orgId, userId: userResult.data.id, role: input.role });
    if (!membershipResult.success) return membershipResult;

    return { success: true, data: { user: userResult.data, membership: membershipResult.data } };
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
