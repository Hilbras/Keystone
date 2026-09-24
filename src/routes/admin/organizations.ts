import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getSdk } from "../../sdk/index.js";
import { toPublicUser } from "../../types.js";
import { requireOrganizationRole, sendResultError, ipEntry, BrandingSchema } from "./helpers.js";
import { rateLimit } from "../../plugins/rateLimit.js";
import type { EventContext } from "../../services/events/types.js";

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

function requestEventContext(request: FastifyRequest): EventContext {
  return {
    requestId: request.id,
    ip: request.ip,
    userAgent: request.headers["user-agent"],
    appId: request.state.app?.id,
  };
}

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
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "application", action: "create" })] },
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
    { preHandler: [requireOrganizationRole(["owner", "admin", "member"], { resource: "application", action: "read" })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await sdk.organization.listOrganizationApplications(request.user!.id, id);
      if (!result.success) return sendResultError(reply, result);
      return { applications: result.data };
    }
  );

  app.patch(
    "/organizations/:id",
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "organization", action: "update" })] },
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
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "application", action: "update" })] },
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
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "organization", action: "invite" })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = InviteSchema.parse(request.body);
      const result = await sdk.organization.inviteMember(request.user!.id, id, body, requestEventContext(request));
      if (!result.success) return sendResultError(reply, result);
      return reply.status(201).send({
        user: toPublicUser(result.data.user),
        membership: result.data.membership,
      });
    }
  );

  app.get(
    "/organizations/:id/members",
    { preHandler: [requireOrganizationRole(["owner", "admin", "member"], { resource: "organization", action: "read" })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const members = await sdk.identity.listOrganizationUsers(id);
      return { members: members.map(toPublicUser) };
    }
  );

  app.patch(
    "/organizations/:id/members/:userId",
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "organization", action: "manage_members" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const body = UpdateMemberSchema.parse(request.body);
      const previous = await sdk.authorization.isOrgMember(userId, id);
      if (!previous) return reply.status(404).send({ error: "Membership not found" });
      const result = await sdk.organization.updateMemberRole(request.user!.id, id, userId, body.role, requestEventContext(request));
      if (!result.success) return sendResultError(reply, result);
      return result.data;
    }
  );

  app.delete(
    "/organizations/:id/members/:userId",
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "organization", action: "manage_members" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const previous = await sdk.authorization.isOrgMember(userId, id);
      if (!previous) return reply.status(404).send({ error: "Membership not found" });
      const result = await sdk.organization.removeMember(request.user!.id, id, userId, requestEventContext(request));
      if (!result.success) return sendResultError(reply, result);
      return result.data;
    }
  );

  app.get(
    "/organizations/:id/users",
    { preHandler: [requireOrganizationRole(["owner", "admin", "member"], { resource: "organization", action: "read" })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const users = await sdk.identity.listOrganizationUsers(id);
      return { users: users.map(toPublicUser) };
    }
  );

  app.get(
    "/organizations/:id/users/:userId",
    { preHandler: [requireOrganizationRole(["owner", "admin", "member"], { resource: "organization", action: "read" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const membership = await sdk.authorization.isOrgMember(userId, id);
      if (!membership) return reply.status(404).send({ error: "User is not a member of this organization" });
      const users = await sdk.identity.listOrganizationUsers(id);
      const user = users.find((u) => u.id === userId);
      if (!user) return reply.status(404).send({ error: "User not found" });
      return { user: toPublicUser(user), membership };
    }
  );

  app.patch(
    "/organizations/:id/users/:userId",
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "organization", action: "manage_members" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const membership = await sdk.authorization.isOrgMember(userId, id);
      if (!membership) return reply.status(404).send({ error: "User is not a member of this organization" });
      return reply.status(410).send({
        error: "Global user management is not available through organization routes",
        code: "GLOBAL_USER_MUTATION_DISABLED",
        migration: "Use /v1/admin/platform/users/:userId for platform-owned user administration or /v1/admin/organizations/:id/members/:userId for membership roles",
      });
    }
  );

  app.delete(
    "/organizations/:id/users/:userId",
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "organization", action: "manage_members" })] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const membership = await sdk.authorization.isOrgMember(userId, id);
      if (!membership) return reply.status(404).send({ error: "User is not a member of this organization" });
      return reply.status(410).send({
        error: "Global user management is not available through organization routes",
        code: "GLOBAL_USER_MUTATION_DISABLED",
        migration: "Remove the organization membership with DELETE /v1/admin/organizations/:id/members/:userId",
      });
    }
  );

  // Organization API keys.
  app.get(
    "/organizations/:id/api-keys",
    { preHandler: [requireOrganizationRole(["owner", "admin", "member"], { resource: "api_key", action: "read" })] },
    async (request) => {
      const { id } = request.params as { id: string };
      const keys = await app.container.apiKeyRepository.listByOrgId(id);
      return { keys };
    }
  );

  app.delete(
    "/organizations/:id/api-keys/:keyId",
    { preHandler: [requireOrganizationRole(["owner", "admin"], { resource: "api_key", action: "revoke" })] },
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
    { preHandler: [requireOrganizationRole(["owner", "admin", "member"], { resource: "audit_log", action: "read" })] },
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
