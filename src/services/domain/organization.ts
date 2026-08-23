import type { Organization, Application, OrgMembership } from "../../db/schema.js";
import type { OrganizationRepository, ApplicationRepository } from "../../repositories/types.js";
import { emit } from "../events/bus.js";
import { ok, err, type Result } from "../../lib/result.js";

export type OrgRole = "owner" | "admin" | "member";

export class OrganizationDomainService {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly applications: ApplicationRepository
  ) {}

  async createOrganization(
    input: { name: string; slug?: string; plan?: string },
    userId?: string
  ): Promise<Result<Organization>> {
    const org = await this.organizations.create(input);
    if (userId) {
      await this.organizations.addMembership({ orgId: org.id, userId, role: "owner" });
    }
    return ok(org);
  }

  async getOrganization(id: string): Promise<Result<Organization>> {
    const org = await this.organizations.findById(id);
    if (!org) return err({ code: "ORG_NOT_FOUND", message: "Organization not found", statusCode: 404 });
    return ok(org);
  }

  async listUserOrganizations(userId: string): Promise<Organization[]> {
    return this.organizations.listByUserId(userId);
  }

  async addOrgMembership(input: { orgId: string; userId: string; role: OrgRole }): Promise<Result<OrgMembership>> {
    const membership = await this.organizations.addMembership(input);
    return ok(membership);
  }

  async getMembership(orgId: string, userId: string): Promise<Result<OrgMembership>> {
    const membership = await this.organizations.findMembership(orgId, userId);
    if (!membership) return err({ code: "MEMBERSHIP_NOT_FOUND", message: "Membership not found", statusCode: 404 });
    return ok(membership);
  }

  async updateMembershipRole(
    orgId: string,
    userId: string,
    role: OrgRole
  ): Promise<Result<OrgMembership>> {
    const updated = await this.organizations.updateMembershipRole(orgId, userId, role);
    if (!updated) return err({ code: "MEMBERSHIP_NOT_FOUND", message: "Membership not found", statusCode: 404 });
    return ok(updated);
  }

  async removeMembership(orgId: string, userId: string): Promise<Result<boolean>> {
    return ok(await this.organizations.removeMembership(orgId, userId));
  }

  async removeOrgMember(orgId: string, userId: string): Promise<Result<{ success: boolean }>> {
    const membership = await this.organizations.findMembership(orgId, userId);
    if (!membership) return err({ code: "MEMBERSHIP_NOT_FOUND", message: "Membership not found", statusCode: 404 });

    if (membership.role === "owner" && (await this.organizations.countOwners(orgId)) <= 1) {
      return err({ code: "LAST_OWNER", message: "Cannot remove the last owner", statusCode: 400 });
    }

    await this.organizations.removeMembership(orgId, userId);
    return ok({ success: true });
  }

  async deactivateOrgUser(orgId: string, userId: string): Promise<Result<{ success: boolean }>> {
    const membership = await this.organizations.findMembership(orgId, userId);
    if (!membership) {
      return err({ code: "MEMBERSHIP_NOT_FOUND", message: "User is not a member of this organization", statusCode: 404 });
    }
    const { deactivateUser } = await import("../users.js");
    await deactivateUser(userId);
    await this.organizations.removeMembership(orgId, userId);
    return ok({ success: true });
  }

  async listOrgMembers(orgId: string) {
    return this.organizations.listMembers(orgId);
  }

  async createApplication(input: {
    orgId: string;
    name: string;
    redirectUris?: string[];
    allowedOrigins?: string[];
  }): Promise<Result<Application & { clientSecret: string }>> {
    const app = await this.applications.create(input);
    await emit({ type: "application_created", payload: { orgId: input.orgId, appId: app.id } });
    return ok(app);
  }

  async listOrganizationApplications(orgId: string): Promise<Application[]> {
    return this.applications.listByOrgId(orgId);
  }

  async updateApplication(
    appId: string,
    orgId: string,
    updates: Partial<{ name: string; redirectUris: string[]; allowedOrigins: string[]; allowedIps: string[]; blockedIps: string[]; isActive: boolean; branding: Record<string, unknown> }>
  ): Promise<Result<Application>> {
    const updated = await this.applications.update(appId, orgId, updates);
    if (!updated) return err({ code: "APP_NOT_FOUND", message: "Application not found", statusCode: 404 });
    await emit({ type: "application_updated", payload: { orgId, appId: updated.id } });
    return ok(updated);
  }
}
