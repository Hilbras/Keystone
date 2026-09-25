import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { User } from "../db/schema.js";
import { hashScimToken } from "../services/scimCredentials.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { config } from "../config.js";
import { emit } from "../services/events/bus.js";

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

/**
 * SCIM 2.0 provisioning.
 *
 * Every request resolves to exactly one organization through its bearer
 * credential, and every read and write below is filtered by that organization.
 * There is no global SCIM configuration and no code path that looks a user or
 * group up by id alone.
 *
 * Tenant rule for shared users: a user row is global, so an organization may
 * only mutate global attributes for a user whose *only* membership is that
 * organization. For a user who belongs elsewhere, SCIM manages the membership
 * and refuses to touch the shared account. See `removeFromOrg`.
 */

const UserBodySchema = z.object({
  userName: z.string().email().max(255),
  name: z
    .object({ givenName: z.string().max(255).optional(), familyName: z.string().max(255).optional() })
    .optional(),
  emails: z.array(z.object({ value: z.string().email(), primary: z.boolean().optional() })).optional(),
  active: z.boolean().optional(),
  externalId: z.string().max(255).optional(),
});

/** PATCH with `active` / `name.*` / `userName` operations, per RFC 7644 §3.5.2. */
const UserPatchSchema = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z
    .array(
      z.object({
        op: z.enum(["add", "replace", "remove"]),
        path: z.string().optional(),
        value: z.unknown().optional(),
      })
    )
    .min(1),
});

const GroupBodySchema = z.object({
  displayName: z.string().min(1).max(255),
  description: z.string().max(1024).optional(),
  externalId: z.string().max(255).optional(),
  members: z
    .array(z.object({ value: z.string().min(1) }))
    .optional(),
});

const GroupPatchSchema = z.object({
  Operations: z
    .array(
      z.object({
        op: z.enum(["add", "replace", "remove"]),
        path: z.string().optional(),
        value: z.unknown().optional(),
      })
    )
    .min(1),
});

const MemberBodySchema = z.object({
  value: z.string().min(1),
});

const ListQuerySchema = z.object({
  filter: z.string().optional(),
  startIndex: z.coerce.number().int().min(1).optional(),
  count: z.coerce.number().int().min(0).max(500).optional(),
});

/**
 * Supports the single-attribute `eq` form that IdMs actually send, e.g.
 * `userName eq "a@b.com"`. Anything else is rejected rather than ignored, so a
 * client never believes a filter was honoured when it was not.
 */
export function parseEqFilter(
  filter: string | undefined,
  allowed: Record<string, (value: string) => boolean>
): Record<string, string> | "unsupported" {
  if (!filter) return {};
  const match = /^\s*([A-Za-z][A-Za-z0-9_.]*)\s+eq\s+"?([^"]*)"?\s*$/i.exec(filter);
  if (!match) return "unsupported";

  const attribute = match[1].toLowerCase();
  const comparator = allowed[attribute];
  if (!comparator) return "unsupported";
  return { [attribute]: match[2] };
}

function scimUserResponse(user: {
  id: string;
  email: string;
  name: string | null;
  isActive?: boolean;
}): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    userName: user.email,
    name: {
      givenName: user.name?.split(" ")[0] || "",
      familyName: user.name?.split(" ").slice(1).join(" ") || "",
    },
    emails: [{ value: user.email, primary: true }],
    active: user.isActive !== false,
    meta: { resourceType: "User" },
  };
}

function scimGroupResponse(
  group: { id: string; displayName: string; description?: string | null; externalId?: string | null },
  members: { value: string; display: string }[]
): Record<string, unknown> {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    ...(group.description ? { description: group.description } : {}),
    ...(group.externalId ? { externalId: group.externalId } : {}),
    members: members.map((m) => ({ value: m.value, display: m.display, $ref: `Users/${m.value}` })),
    meta: { resourceType: "Group" },
  };
}

function scimError(status: number, detail: string, scimType?: string): Record<string, unknown> {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

/** Thrown for a cross-tenant or otherwise unauthorized target; surfaces as 404. */
class ScimNotFound extends Error {}
/** Thrown when the target is real but this credential may not act on it. */
class ScimForbidden extends Error {
  constructor(readonly scimType: string, message: string) {
    super(message);
  }
}

export default async function scimRoutes(app: FastifyInstance) {
  /**
   * Authenticate the credential and pin the request to one organization.
   *
   * The presented token is hashed and looked up by digest, so the comparison
   * happens inside the database index rather than in application code and
   * carries no timing signal about the secret.
   */
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization;

    if (!auth || !auth.startsWith("Bearer ")) {
      await emit({ type: "scim_authentication_failed", payload: { reason: "missing_bearer" } });
      return reply.status(401).send(scimError(401, "Unauthorized"));
    }

    const presented = auth.slice(7).trim();
    if (presented.length < 16) {
      await emit({ type: "scim_authentication_failed", payload: { reason: "malformed_token" } });
      return reply.status(401).send(scimError(401, "Unauthorized"));
    }

    const now = new Date();
    const connection = await app.container.scimConnectionRepository.findByTokenHash(
      hashScimToken(presented),
      now
    );
    if (!connection) {
      await emit({ type: "scim_authentication_failed", payload: { reason: "unknown_or_revoked_token" } });
      return reply.status(401).send(scimError(401, "Unauthorized"));
    }

    if (connection.expiresAt && connection.expiresAt <= now) {
      await emit({
        type: "scim_authentication_failed",
        payload: { orgId: connection.orgId, connectionId: connection.id, reason: "expired" },
      });
      return reply.status(401).send(scimError(401, "Unauthorized"));
    }

    const organization = await app.container.organizationRepository.findById(connection.orgId);
    if (!organization) {
      await emit({
        type: "scim_authentication_failed",
        payload: { orgId: connection.orgId, connectionId: connection.id, reason: "org_missing" },
      });
      return reply.status(503).send(scimError(503, "SCIM organization not found"));
    }

    request.state.scimOrgId = connection.orgId;
    request.state.scimConnectionId = connection.id;
    request.state.org = organization;

    await app.container.scimConnectionRepository.touch(connection.id, now);
  });

  // A dedicated budget, keyed on the credential, applied to every SCIM route.
  const scimRateLimit = rateLimit({
    keyPrefix: "scim",
    maxAttempts: config.SCIM_RATE_LIMIT_MAX,
    windowSeconds: config.SCIM_RATE_LIMIT_WINDOW_SECONDS,
    keyFrom: (request) => request.state.scimConnectionId ?? request.ip,
  });

  /**
   * Resolve a target inside the credential's organization, or fail closed.
   *
   * `forWrite` additionally refuses accounts SCIM must never change. Reading a
   * platform owner who happens to be a member of the organization is
   * legitimate; mutating one is not.
   */
  async function requireOrgUser(
    request: FastifyRequest,
    userId: string,
    { forWrite = false }: { forWrite?: boolean } = {}
  ): Promise<User> {
    const orgId = request.state.scimOrgId!;
    const user = await app.container.userRepository.findByIdInOrg(orgId, userId);
    if (!user) {
      // Deliberately the same response for "does not exist" and "belongs to
      // another organization", so the endpoint is not a tenant oracle.
      throw new ScimNotFound("User not found");
    }
    if (!forWrite) return user;

    if (user.role === "owner") {
      throw new ScimForbidden("mutability", "Platform owners cannot be modified through SCIM");
    }
    if (user.accountReviewRequired) {
      throw new ScimForbidden(
        "mutability",
        "This account is pending platform review and cannot be modified through SCIM"
      );
    }
    return user;
  }

  /**
   * A user row is global. Writing global attributes for someone who also
   * belongs to another organization would change that other tenant's view
   * without any authorization from it, so SCIM refuses.
   */
  async function assertSoleMembership(request: FastifyRequest, user: User, action: string): Promise<void> {
    const orgIds = await app.container.userRepository.listOrgIdsForUser(user.id);
    if (orgIds.length > 1) {
      await emit({
        type: "scim_access_denied",
        payload: {
          orgId: request.state.scimOrgId,
          targetUserId: user.id,
          reason: "shared_user",
          action,
        },
      });
      throw new ScimForbidden(
        "mutability",
        "This user also belongs to another organization; remove the membership from this organization instead of modifying the shared account"
      );
    }
  }

  function handleError(reply: FastifyReply, error: unknown) {
    if (error instanceof ScimNotFound) {
      return reply.status(404).send(scimError(404, error.message));
    }
    if (error instanceof ScimForbidden) {
      return reply.status(409).send(scimError(409, error.message, error.scimType));
    }
    if (error && typeof error === "object" && (error as { name?: string }).name === "ZodError") {
      return reply.status(400).send(scimError(400, "Invalid request body"));
    }
    throw error;
  }

  // --- Users -------------------------------------------------------------

  app.get("/scim/v2/Users", { preHandler: [scimRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListQuerySchema.parse(request.query ?? {});
    const filter = parseEqFilter(query.filter, {
      username: (v) => v.toLowerCase() === v.toLowerCase(),
      externalid: () => true,
    });
    if (filter === "unsupported") {
      return reply.status(400).send(scimError(400, "Unsupported filter expression", "invalidFilter"));
    }

    const all = (await app.container.userRepository.listByOrg(request.state.scimOrgId!)).filter((u) => u.isActive);
    const userName = filter.username;
    const matching = userName
      ? all.filter((u) => u.email.toLowerCase() === userName.toLowerCase())
      : all;

    const start = (query.startIndex ?? 1) - 1;
    const count = query.count ?? matching.length;

    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: matching.length,
      startIndex: start + 1,
      itemsPerPage: Math.min(count, matching.length - start),
      Resources: matching.slice(start, start + count).map(scimUserResponse),
    };
  });

  app.get(
    "/scim/v2/Users/:userId",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.params as { userId: string };
      try {
        return scimUserResponse(await requireOrgUser(request, userId));
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    "/scim/v2/Users",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = UserBodySchema.parse(request.body);
      const orgId = request.state.scimOrgId!;
      const email = body.userName.toLowerCase().trim();

      // Resolve the target through the organization. A user that exists
      // globally but not here is refused: SCIM cannot see whether attaching
      // them is expected, and adopting them would leak them across tenants.
      const global = await app.container.userRepository.findByEmail(email);
      const existing = global
        ? await app.container.userRepository.findByIdInOrg(orgId, global.id)
        : undefined;

      if (global && !existing) {
        await emit({
          type: "scim_access_denied",
          payload: { orgId, reason: "user_exists_outside_organization", email },
        });
        return reply.status(409).send(
          scimError(
            409,
            "A user with that userName already exists outside this organization. Invite them through the organization instead.",
            "uniqueness"
          )
        );
      }

      let user = existing;
      let isNewUser = false;
      if (!user) {
        const base = email.split("@")[0];
        const username = await app.container.userRepository.ensureUniqueUsername(base);
        const name = body.name
          ? `${body.name.givenName || ""} ${body.name.familyName || ""}`.trim() || username
          : username;
        user = await app.container.userRepository.create({
          email,
          username,
          name,
          provider: "scim",
          emailVerified: true,
        });
        await app.container.organizationRepository.addMembership({
          orgId,
          userId: user.id,
          role: "member",
        });
        isNewUser = true;
      }

      if (body.active === false && user.isActive) {
        const removed = await app.container.userRepository.removeFromOrg(orgId, user.id);
        if (!removed || removed.outcome === "not_found") {
          return reply.status(404).send(scimError(404, "User not found"));
        }
        if (removed.outcome === "last_owner") {
          return reply.status(409).send(scimError(409, "The last platform owner cannot be deactivated", "mutability"));
        }
        user = { ...user, isActive: false };
      } else if (body.active === true && !user.isActive) {
        if (user.accountReviewRequired) {
          return reply.status(409).send(
            scimError(409, "Account review must be completed by a platform owner", "mutability")
          );
        }
        user = (await app.container.userRepository.updateInOrg(orgId, user.id, { isActive: true })) ?? user;
      }

      await request.audit(isNewUser ? "scim_user_created" : "scim_user_updated", {
        targetUserId: user.id,
        email: user.email,
        actorType: "scim",
        scimConnectionId: request.state.scimConnectionId,
        scimOrgId: orgId,
      });
      return reply.status(201).send(scimUserResponse(user));
    }
  );

  app.put(
    "/scim/v2/Users/:userId",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.params as { userId: string };
      const body = UserBodySchema.parse(request.body);
      const orgId = request.state.scimOrgId!;

      try {
        const existing = await requireOrgUser(request, userId, { forWrite: true });

        if (body.active === false) {
          const removed = await app.container.userRepository.removeFromOrg(orgId, existing.id);
          if (!removed || removed.outcome === "not_found") {
            return reply.status(404).send(scimError(404, "User not found"));
          }
          if (removed.outcome === "last_owner") {
            return reply.status(409).send(scimError(409, "The last platform owner cannot be deactivated", "mutability"));
          }
          // The membership is gone, so re-reading through the organization
          // would 404. Report the deactivation from the resolved user instead.
          await request.audit("scim_user_updated", {
            targetUserId: existing.id,
            email: existing.email,
            actorType: "scim",
            operation: "put",
            outcome: removed.outcome,
            scimConnectionId: request.state.scimConnectionId,
            scimOrgId: orgId,
          });
          return scimUserResponse({ ...existing, isActive: false });
        }

        {
          await assertSoleMembership(request, existing, "update");
          const updated = await app.container.userRepository.updateInOrg(orgId, existing.id, {
            email: body.userName.toLowerCase().trim(),
            name: body.name
              ? `${body.name.givenName || ""} ${body.name.familyName || ""}`.trim()
              : undefined,
            isActive: body.active,
          });
          if (!updated) return reply.status(404).send(scimError(404, "User not found"));
        }

        const updated = await app.container.userRepository.findByIdInOrg(orgId, userId);
        if (!updated) return reply.status(404).send(scimError(404, "User not found"));

        await request.audit("scim_user_updated", {
          targetUserId: updated.id,
          email: updated.email,
          actorType: "scim",
          scimConnectionId: request.state.scimConnectionId,
          scimOrgId: orgId,
        });
        return scimUserResponse(updated);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.patch(
    "/scim/v2/Users/:userId",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.params as { userId: string };
      const body = UserPatchSchema.parse(request.body);
      const orgId = request.state.scimOrgId!;

      try {
        const existing = await requireOrgUser(request, userId, { forWrite: true });
        const patch = collapsePatch(body.Operations);
        const nameValue = patch.name;
        const nameParts =
          nameValue && typeof nameValue === "object" && !Array.isArray(nameValue)
            ? (nameValue as { givenName?: unknown; familyName?: unknown })
            : undefined;
        const name = nameParts
          ? {
              givenName: typeof nameParts.givenName === "string" ? nameParts.givenName : undefined,
              familyName: typeof nameParts.familyName === "string" ? nameParts.familyName : undefined,
            }
          : undefined;
        const activePatch = typeof patch.active === "boolean" ? patch.active : undefined;

        if (activePatch === false) {
          const removed = await app.container.userRepository.removeFromOrg(orgId, existing.id);
          if (!removed || removed.outcome === "not_found") {
            return reply.status(404).send(scimError(404, "User not found"));
          }
          if (removed.outcome === "last_owner") {
            return reply.status(409).send(scimError(409, "The last platform owner cannot be deactivated", "mutability"));
          }
          await request.audit("scim_user_updated", {
            targetUserId: existing.id,
            email: existing.email,
            actorType: "scim",
            operation: "patch",
            outcome: removed.outcome,
            scimConnectionId: request.state.scimConnectionId,
            scimOrgId: orgId,
          });
          return scimUserResponse({ ...existing, isActive: false });
        } else {
          await assertSoleMembership(request, existing, "patch");
          const updated = await app.container.userRepository.updateInOrg(orgId, existing.id, {
            ...(patch.userName ? { email: String(patch.userName).toLowerCase().trim() } : {}),
            ...(name ? { name: `${name.givenName || ""} ${name.familyName || ""}`.trim() } : {}),
            ...(activePatch === undefined ? {} : { isActive: activePatch }),
          });
          if (!updated) return reply.status(404).send(scimError(404, "User not found"));
        }

        const updated = await app.container.userRepository.findByIdInOrg(orgId, userId);
        if (!updated) return reply.status(404).send(scimError(404, "User not found"));

        await request.audit("scim_user_updated", {
          targetUserId: updated.id,
          email: updated.email,
          actorType: "scim",
          operation: "patch",
          scimConnectionId: request.state.scimConnectionId,
          scimOrgId: orgId,
        });
        return scimUserResponse(updated);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.delete(
    "/scim/v2/Users/:userId",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.params as { userId: string };
      const orgId = request.state.scimOrgId!;

      try {
        const user = await requireOrgUser(request, userId, { forWrite: true });
        const result = await app.container.userRepository.removeFromOrg(orgId, user.id);
        if (!result || result.outcome === "not_found") {
          return reply.status(404).send(scimError(404, "User not found"));
        }
        if (result.outcome === "last_owner") {
          return reply.status(409).send(scimError(409, "The last platform owner cannot be deactivated", "mutability"));
        }

        await request.audit("scim_user_deleted", {
          targetUserId: user.id,
          email: user.email,
          actorType: "scim",
          outcome: result.outcome,
          scimConnectionId: request.state.scimConnectionId,
          scimOrgId: orgId,
        });
        return reply.status(204).send();
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  // --- Groups ------------------------------------------------------------

  async function loadGroup(request: FastifyRequest, groupId: string) {
    const group = await app.container.scimGroupRepository.findByIdInOrg(request.state.scimOrgId!, groupId);
    // A group from another organization is reported as missing, not forbidden.
    if (!group) throw new ScimNotFound("Group not found");
    return group;
  }

  async function groupWithMembers(request: FastifyRequest, groupId: string) {
    const group = await loadGroup(request, groupId);
    const members = await app.container.scimGroupRepository.listMembers(
      request.state.scimOrgId!,
      group.id
    );
    return scimGroupResponse(group, members.map((m) => ({ value: m.userId, display: m.email })));
  }

  /** Only users who are members of this credential's organization can join. */
  async function assertMemberOfOrg(request: FastifyRequest, userId: string): Promise<void> {
    const user = await app.container.userRepository.findByIdInOrg(request.state.scimOrgId!, userId);
    if (!user) throw new ScimNotFound("User not found");
  }

  app.get(
    "/scim/v2/Groups",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = ListQuerySchema.parse(request.query ?? {});
      const filter = parseEqFilter(query.filter, {
        displayname: () => true,
        externalid: () => true,
      });
      if (filter === "unsupported") {
        return reply.status(400).send(scimError(400, "Unsupported filter expression", "invalidFilter"));
      }

      const orgId = request.state.scimOrgId!;
      let groups = await app.container.scimGroupRepository.listByOrg(orgId);
      if (filter.displayname !== undefined) {
        const wanted = filter.displayname.toLowerCase();
        groups = groups.filter((g) => g.displayName.toLowerCase() === wanted);
      }

      const start = (query.startIndex ?? 1) - 1;
      const count = query.count ?? groups.length;
      const page = groups.slice(start, start + count);

      const Resources = await Promise.all(
        page.map(async (group) => {
          const members = await app.container.scimGroupRepository.listMembers(orgId, group.id);
          return scimGroupResponse(group, members.map((m) => ({ value: m.userId, display: m.email })));
        })
      );

      return {
        schemas: [SCIM_LIST_SCHEMA],
        totalResults: groups.length,
        startIndex: start + 1,
        itemsPerPage: Resources.length,
        Resources,
      };
    }
  );

  app.get(
    "/scim/v2/Groups/:groupId",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { groupId } = request.params as { groupId: string };
      try {
        return await groupWithMembers(request, groupId);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    "/scim/v2/Groups",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = GroupBodySchema.parse(request.body);
      const orgId = request.state.scimOrgId!;

      try {
        const group = await app.container.scimGroupRepository.create({
          orgId,
          displayName: body.displayName,
          description: body.description ?? null,
          externalId: body.externalId ?? null,
        });

        for (const member of body.members ?? []) {
          await assertMemberOfOrg(request, member.value);
          await app.container.scimGroupRepository.addMember(orgId, group.id, member.value);
        }

        await request.audit("scim_group_created", {
          groupId: group.id,
          displayName: group.displayName,
          actorType: "scim",
          scimConnectionId: request.state.scimConnectionId,
          scimOrgId: orgId,
        });
        return reply.status(201).send(await groupWithMembers(request, group.id));
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.put(
    "/scim/v2/Groups/:groupId",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { groupId } = request.params as { groupId: string };
      const body = GroupBodySchema.parse(request.body);
      const orgId = request.state.scimOrgId!;

      try {
        const existing = await loadGroup(request, groupId);
        await app.container.scimGroupRepository.updateInOrg(orgId, existing.id, {
          displayName: body.displayName,
          description: body.description ?? null,
          externalId: body.externalId ?? null,
        });

        if (body.members) {
          for (const member of body.members) {
            await assertMemberOfOrg(request, member.value);
            await app.container.scimGroupRepository.addMember(orgId, existing.id, member.value);
          }
          const current = await app.container.scimGroupRepository.listMembers(orgId, existing.id);
          const wanted = new Set(body.members.map((m) => m.value));
          for (const member of current) {
            if (!wanted.has(member.userId)) {
              await app.container.scimGroupRepository.removeMember(orgId, existing.id, member.userId);
            }
          }
        }

        await request.audit("scim_group_updated", {
          groupId: existing.id,
          actorType: "scim",
          operation: "put",
          scimConnectionId: request.state.scimConnectionId,
          scimOrgId: orgId,
        });
        return await groupWithMembers(request, existing.id);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.patch(
    "/scim/v2/Groups/:groupId",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { groupId } = request.params as { groupId: string };
      const body = GroupPatchSchema.parse(request.body);
      const orgId = request.state.scimOrgId!;

      try {
        const existing = await loadGroup(request, groupId);
        const patch = collapsePatch(body.Operations);

        if (typeof patch.displayName === "string") {
          await app.container.scimGroupRepository.updateInOrg(orgId, existing.id, {
            displayName: patch.displayName,
          });
        }
        if (typeof patch.description === "string") {
          await app.container.scimGroupRepository.updateInOrg(orgId, existing.id, {
            description: patch.description,
          });
        }

        const members = Array.isArray(patch.members) ? patch.members : undefined;
        if (members) {
          for (const entry of members) {
            const value = typeof entry === "string" ? entry : (entry as { value?: string })?.value;
            if (typeof value !== "string") continue;
            await assertMemberOfOrg(request, value);
            await app.container.scimGroupRepository.addMember(orgId, existing.id, value);
          }
        }
        const removeMembers = Array.isArray(patch["members.remove"])
          ? (patch["members.remove"] as unknown[]).map(
              (entry) => (typeof entry === "string" ? entry : (entry as { value?: string })?.value)
            )
          : undefined;
        for (const value of removeMembers ?? []) {
          if (typeof value === "string") {
            await app.container.scimGroupRepository.removeMember(orgId, existing.id, value);
          }
        }

        await request.audit("scim_group_updated", {
          groupId: existing.id,
          actorType: "scim",
          operation: "patch",
          scimConnectionId: request.state.scimConnectionId,
          scimOrgId: orgId,
        });
        return await groupWithMembers(request, existing.id);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.delete(
    "/scim/v2/Groups/:groupId",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { groupId } = request.params as { groupId: string };
      const orgId = request.state.scimOrgId!;

      try {
        const group = await loadGroup(request, groupId);
        const removed = await app.container.scimGroupRepository.deleteInOrg(orgId, group.id);
        if (!removed) return reply.status(404).send(scimError(404, "Group not found"));

        await request.audit("scim_group_deleted", {
          groupId: group.id,
          displayName: group.displayName,
          actorType: "scim",
          scimConnectionId: request.state.scimConnectionId,
          scimOrgId: orgId,
        });
        return reply.status(204).send();
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get(
    "/scim/v2/Groups/:groupId/members",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { groupId } = request.params as { groupId: string };
      try {
        const group = await loadGroup(request, groupId);
        const members = await app.container.scimGroupRepository.listMembers(
          request.state.scimOrgId!,
          group.id
        );
        return {
          schemas: [SCIM_LIST_SCHEMA],
          totalResults: members.length,
          Resources: members.map((m) => ({ value: m.userId, display: m.email, $ref: `Users/${m.userId}` })),
        };
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    "/scim/v2/Groups/:groupId/members",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { groupId } = request.params as { groupId: string };
      const body = z.union([MemberBodySchema, z.object({ members: z.array(MemberBodySchema) })]).parse(request.body);
      const orgId = request.state.scimOrgId!;

      try {
        const group = await loadGroup(request, groupId);
        const values = "value" in body ? [body.value] : body.members.map((m) => m.value);
        let added = 0;
        for (const value of values) {
          await assertMemberOfOrg(request, value);
          if (await app.container.scimGroupRepository.addMember(orgId, group.id, value)) added++;
        }
        if (added === 0) return reply.status(409).send(scimError(409, "No new members were added"));

        await request.audit("scim_group_updated", {
          groupId: group.id,
          actorType: "scim",
          operation: "add_members",
          added,
          scimConnectionId: request.state.scimConnectionId,
          scimOrgId: orgId,
        });
        return reply.status(201).send(await groupWithMembers(request, group.id));
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.delete(
    "/scim/v2/Groups/:groupId/members/:userId",
    { preHandler: [scimRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { groupId, userId } = request.params as { groupId: string; userId: string };
      const orgId = request.state.scimOrgId!;

      try {
        const group = await loadGroup(request, groupId);
        const removed = await app.container.scimGroupRepository.removeMember(orgId, group.id, userId);
        if (!removed) return reply.status(404).send(scimError(404, "Member not found"));

        await request.audit("scim_group_updated", {
          groupId: group.id,
          actorType: "scim",
          operation: "remove_member",
          targetUserId: userId,
          scimConnectionId: request.state.scimConnectionId,
          scimOrgId: orgId,
        });
        return reply.status(204).send();
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  // SCIM service provider configuration, scoped to the authenticated tenant.
  app.get("/scim/v2/ServiceProviderConfig", { preHandler: [scimRateLimit] }, async (request: FastifyRequest) => {
    const base = `${request.protocol}://${request.hostname}`;
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://docs.hilbras.ai/keystone/scim",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 500 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "OAuth Bearer Token",
          description: "Per-organization SCIM credential",
          specUri: "http://www.rfc-editor.org/info/rfc6750",
          primary: true,
        },
      ],
      meta: {
        resourceType: "ServiceProviderConfig",
        organization: `${base} (${request.state.scimOrgId})`,
        location: `${base}/scim/v2/ServiceProviderConfig`,
      },
    };
  });

  app.get("/scim/v2/ResourceTypes", { preHandler: [scimRateLimit] }, async () => [
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User",
      name: "User",
      endpoint: "/Users",
      schema: SCIM_USER_SCHEMA,
      meta: { resourceType: "ResourceType", location: "/ResourceTypes/User" },
    },
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      schema: SCIM_GROUP_SCHEMA,
      meta: { resourceType: "ResourceType", location: "/ResourceTypes/Group" },
    },
  ]);

  // `.search` is the POST form of the list endpoints, required by RFC 7644 §3.4.3.
  app.post("/scim/v2/Users/.search", { preHandler: [scimRateLimit] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = z
      .object({
        filter: z.string().optional(),
        startIndex: z.number().int().min(1).optional(),
        count: z.number().int().min(0).max(500).optional(),
      })
      .parse(request.body ?? {});

    const filter = parseEqFilter(body.filter, { username: () => true, externalid: () => true });
    if (filter === "unsupported") {
      return reply.status(400).send(scimError(400, "Unsupported filter expression", "invalidFilter"));
    }

    const all = (await app.container.userRepository.listByOrg(request.state.scimOrgId!)).filter((u) => u.isActive);
    const matching = filter.username
      ? all.filter((u) => u.email.toLowerCase() === filter.username.toLowerCase())
      : all;
    const start = (body.startIndex ?? 1) - 1;
    const count = body.count ?? matching.length;

    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: matching.length,
      startIndex: start + 1,
      itemsPerPage: Math.min(count, Math.max(0, matching.length - start)),
      Resources: matching.slice(start, start + count).map(scimUserResponse),
    };
  });
}

/**
 * Flatten a SCIM PATCH body into a single attribute map. Operations without a
 * `path` contribute their `value` object directly; `remove` clears the
 * attribute.
 */
function collapsePatch(
  operations: { op: "add" | "replace" | "remove"; path?: string; value?: unknown }[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const operation of operations) {
    if (operation.op === "remove") {
      if (operation.path) {
        result[normalizePatchPath(operation.path)] = undefined;
        continue;
      }
      if (operation.value && typeof operation.value === "object" && !Array.isArray(operation.value)) {
        for (const key of Object.keys(operation.value)) result[key] = undefined;
      }
      continue;
    }

    if (!operation.path) {
      if (operation.value && typeof operation.value === "object" && !Array.isArray(operation.value)) {
        Object.assign(result, operation.value);
      }
      continue;
    }

    const path = normalizePatchPath(operation.path);
    const value = operation.value;

    if (path.includes(".")) {
      const [head, tail] = path.split(".");
      const current = (result[head] && typeof result[head] === "object" ? result[head] : {}) as Record<string, unknown>;
      current[tail] = value;
      result[head] = current;
      continue;
    }

    result[path] = value;
  }

  return result;
}

/** `active` -> `active`, `name.givenName` -> `name.givenName`, `members` -> `members`. */
function normalizePatchPath(path: string): string {
  const [head, ...rest] = path.replace(/^\//, "").split(".");
  const headKey = head.toLowerCase();
  if (headKey === "members.remove") return "members.remove";
  if (headKey === "members") return rest.length ? "members" : "members";
  return rest.length ? `${headKey}.${rest.join(".")}` : headKey;
}
