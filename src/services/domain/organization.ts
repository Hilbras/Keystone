import type { Organization, Application, OrgMembership } from "../../db/schema.js";
import { LastOwnerInvariantError, type OrganizationRepository, type ApplicationRepository } from "../../repositories/types.js";
import { emit } from "../events/bus.js";
import { ok, err, type Result } from "../../lib/result.js";
import { isOrganizationRole, type OrgRole } from "./authorization.js";

export type { OrgRole } from "./authorization.js";

export class OrganizationDomainService {
  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly applications: ApplicationRepository
  ) {}

  async createOrganization(
    input: { name: string; slug?: string; plan?: string },
    userId: string
  ): Promise<Result<Organization>> {
    const org = await this.organizations.createWithOwner(input, userId);
    const membership = await this.organizations.findMembership(org.id, userId);
    if (!membership) {
      return err({ code: "OWNER_MEMBERSHIP_FAILED", message: "Organization owner membership could not be created", statusCode: 500 });
    }
    await emit({
      type: "organization_member_invited",
      payload: {
        userId,
        orgId: org.id,
        metadata: {
          targetUserId: userId,
          previousRole: null,
          newRole: membership.role,
          action: "organization_created",
        },
      },
    });
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
    if (!isOrganizationRole(input.role)) {
      return err({ code: "INVALID_ORGANIZATION_ROLE", message: "Invalid organization role", statusCode: 400 });
    }
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
    if (!isOrganizationRole(role)) {
      return err({ code: "INVALID_ORGANIZATION_ROLE", message: "Invalid organization role", statusCode: 400 });
    }

    try {
      const updated = await this.organizations.updateMembershipRole(orgId, userId, role);
      if (!updated) return err({ code: "MEMBERSHIP_NOT_FOUND", message: "Membership not found", statusCode: 404 });
      return ok(updated);
    } catch (error) {
      if (error instanceof LastOwnerInvariantError) {
        return err({ code: "LAST_OWNER", message: error.message, statusCode: 400 });
      }
      throw error;
    }
  }

  async removeOrgMember(orgId: string, userId: string): Promise<Result<{ success: boolean }>> {
    try {
      const removed = await this.organizations.removeMembership(orgId, userId);
      if (!removed) return err({ code: "MEMBERSHIP_NOT_FOUND", message: "Membership not found", statusCode: 404 });
      return ok({ success: true });
    } catch (error) {
      if (error instanceof LastOwnerInvariantError) {
        return err({ code: "LAST_OWNER", message: error.message, statusCode: 400 });
      }
      throw error;
    }
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
