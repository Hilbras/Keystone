import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { getSdk } from "../../sdk/index.js";
import { requireAuthAndRole, sendResultError, ipEntry, BrandingSchema } from "./helpers.js";
import { updateMembershipRole, removeMembership, findMembership, countOwners } from "../../services/organizations.js";
import { rateLimit } from "../../plugins/rateLimit.js";

const CreateOrgSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().max(64).optional(),
  plan: z.string().max(32).optional(),
});

const UpdateOrgSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  branding: BrandingSchema.optional(),
});

const CreateAppSchema = z.object({
  name: z.string().min(1).max(255),
  redirectUris: z.array(z.string().url()).optional(),
  allowedOrigins: z.array(z.string()).optional(),
  allowedIps: z.array(ipEntry).optional(),
  blockedIps: z.array(ipEntry).optional(),
});

const UpdateAppSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  redirectUris: z.array(z.string().url()).optional(),
  allowedOrigins: z.array(z.string()).optional(),
  allowedIps: z.array(ipEntry).optional(),
  blockedIps: z.array(ipEntry).optional(),
  isActive: z.boolean().optional(),
  branding: BrandingSchema.optional(),
});

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});

const UpdateMemberSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
});

const UpdateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  username: z.string().min(3).max(32).optional(),
  role: z.string().optional(),
  emailVerified: z.boolean().optional(),
});

export default async function organizationsRoutes(app: FastifyInstance) {
  const sdk = getSdk();

  app.post(
    "/organizations",
    {
      preHandler: [
        app.authenticate,
        rateLimit({
          keyPrefix: "create-org",
          maxAttempts: 5,
          windowSeconds: 3600,
        }),
      ],
    },
    async (request, reply) => {
      const body = CreateOrgSchema.parse(request.body);
      const result = await sdk.organization.createOrganization(request.user!.id, body);
      if (!result.success) return sendResultError(reply, result);
      await request.audit("organization_created", { orgId: result.data.id });
      return reply.status(201).send(result.data);
    }
  );

  app.get("/organizations", { preHandler: [app.authenticate] }, async (request) => {
    const orgs = await sdk.organization.listUserOrganizations(request.user!.id);
    return { organizations: orgs };
  });

  app.get("/organizations/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await sdk.organization.getOrganization(request.user!.id, id);
    if (!result.success) return sendResultError(reply, result);

    const membership = await sdk.authorization.isOrgMember(request.user!.id, id);
    request.state.membership = membership;

    const memberCount = await app.container.organizationRepository.countMembers(id);

    return { ...result.data, memberCount, membership };
  });

  app.post(
    "/organizations/:id/applications",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "application", action: "create" })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = CreateAppSchema.parse(request.body);
      const result = await sdk.organization.createApplication(request.user!.id, id, body);
      if (!result.success) return sendResultError(reply, result);
      return reply.status(201).send({ ...result.data, clientSecret: result.data.clientSecret });
    }
  );

  app.get(
    "/organizations/:id/applications",
    { preHandler: [requireAuthAndRole(["owner", "admin", "member"], { resource: "application", action: "read" })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await sdk.organization.listOrganizationApplications(request.user!.id, id);
      if (!result.success) return sendResultError(reply, result);
      return { applications: result.data };
    }
  );

  app.patch(
    "/organizations/:id",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "organization", action: "update" })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = UpdateOrgSchema.parse(request.body);
      if (body.name === undefined && body.branding === undefined) {
        return reply.status(400).send({ error: "Nothing to update" });
      }
      const updated = await app.container.organizationRepository.update(id, {
        name: body.name,
        branding: body.branding,
      });
      if (!updated) return reply.status(404).send({ error: "Organization not found" });
      await request.audit("organization_updated", { orgId: id, updates: Object.keys(body) });
      return updated;
    }
  );

  app.patch(
    "/organizations/:id/applications/:appId",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "application", action: "update" })] },
    async (request, reply) => {
      const { id, appId } = request.params as { id: string; appId: string };
      const body = UpdateAppSchema.parse(request.body);
      const result = await sdk.organization.updateApplication(request.user!.id, id, appId, body);
      if (!result.success) return sendResultError(reply, result);
      await request.audit("application_updated", { orgId: id, appId, updates: Object.keys(body) });
      return result.data;
    }
  );

  app.post(
    "/organizations/:id/invites",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "organization", action: "invite" })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = InviteSchema.parse(request.body);
      const result = await sdk.organization.inviteMember(request.user!.id, id, body);
      if (!result.success) return sendResultError(reply, result);
      await request.audit("organization_member_invited", {
        orgId: id,
        invitedUserId: result.data.user.id,
        role: body.role,
      });
      return reply.status(201).send(result.data);
    }
  );

  app.get(
    "/organizations/:id/members",
    { preHandler: [requireAuthAndRole(["owner", "admin", "member"], { resource: "organization", action: "read" })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const members = await getSdk().identity.listOrganizationUsers(id);
      return { members };
    }
  );

  app.patch(
    "/organizations/:id/members/:userId",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "organization", action: "manage_members" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const body = UpdateMemberSchema.parse(request.body);
      const updated = await updateMembershipRole(id, userId, body.role);
      if (!updated) return reply.status(404).send({ error: "Membership not found" });
      await request.audit("organization_member_role_updated", { orgId: id, userId, role: body.role });
      return updated;
    }
  );

  app.delete(
    "/organizations/:id/members/:userId",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "organization", action: "manage_members" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const membership = await findMembership(id, userId);
      if (!membership) return reply.status(404).send({ error: "Membership not found" });
      if (membership.role === "owner" && (await countOwners(id)) <= 1) {
        return reply.status(400).send({ error: "Cannot remove the last owner" });
      }
      await removeMembership(id, userId);
      await request.audit("organization_member_removed", { orgId: id, userId });
      return { success: true };
    }
  );

  app.get(
    "/organizations/:id/users",
    { preHandler: [requireAuthAndRole(["owner", "admin", "member"], { resource: "organization", action: "read" })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const users = await sdk.identity.listOrganizationUsers(id);
      return { users };
    }
  );

  app.get(
    "/organizations/:id/users/:userId",
    { preHandler: [requireAuthAndRole(["owner", "admin", "member"], { resource: "organization", action: "read" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const membership = await sdk.authorization.isOrgMember(userId, id);
      if (!membership) return reply.status(404).send({ error: "User is not a member of this organization" });
      const users = await sdk.identity.listOrganizationUsers(id);
      const user = users.find((u) => u.id === userId);
      if (!user) return reply.status(404).send({ error: "User not found" });
      return { user, membership };
    }
  );

  app.patch(
    "/organizations/:id/users/:userId",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "organization", action: "manage_members" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const body = UpdateUserSchema.parse(request.body);
      const membership = await sdk.authorization.isOrgMember(userId, id);
      if (!membership) return reply.status(404).send({ error: "User is not a member of this organization" });
      const result = await sdk.identity.updateUserProfile(userId, body);
      if (!result.success) return sendResultError(reply, result);
      await request.audit("organization_member_role_updated", { orgId: id, userId, updates: body });
      return result.data;
    }
  );

  app.delete(
    "/organizations/:id/users/:userId",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "organization", action: "manage_members" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const membership = await sdk.authorization.isOrgMember(userId, id);
      if (!membership) return reply.status(404).send({ error: "User is not a member of this organization" });
      const result = await sdk.identity.deactivate(userId);
      if (!result.success) return sendResultError(reply, result);
      await removeMembership(id, userId);
      await request.audit("organization_member_removed", { orgId: id, userId });
      return { success: true };
    }
  );

  // Organization API keys.
  app.get(
    "/organizations/:id/api-keys",
    { preHandler: [requireAuthAndRole(["owner", "admin", "member"], { resource: "api_key", action: "read" })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const keys = await app.container.apiKeyRepository.listByOrgId(id);
      return { keys };
    }
  );

  app.delete(
    "/organizations/:id/api-keys/:keyId",
    { preHandler: [requireAuthAndRole(["owner", "admin"], { resource: "api_key", action: "revoke" })] },
    async (request, reply) => {
      const { id, keyId } = request.params as { id: string; keyId: string };
      const record = await app.container.apiKeyRepository.revokeByKeyIdAndOrgId(keyId, id);
      if (!record) return reply.status(404).send({ error: "API key not found" });
      await request.audit("api_key_revoked", { keyId: record.id, name: record.name, orgId: id });
      return { success: true };
    }
  );

  // Organization audit logs.
  app.get(
    "/organizations/:id/audit-logs",
    { preHandler: [requireAuthAndRole(["owner", "admin", "member"], { resource: "audit_log", action: "read" })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { limit?: string; offset?: string; event?: string };
      const logs = await app.container.auditRepository.list({
        orgId: id,
        event: query.event,
        limit: query.limit ? Number(query.limit) : 50,
        offset: query.offset ? Number(query.offset) : 0,
      });
      return { logs };
    }
  );
}
