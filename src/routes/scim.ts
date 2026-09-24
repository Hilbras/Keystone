import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgMemberships, users } from "../db/schema.js";

const ScimUserSchema = z.object({
  userName: z.string().email(),
  name: z.object({ givenName: z.string().optional(), familyName: z.string().optional() }).optional(),
  emails: z.array(z.object({ value: z.string().email(), primary: z.boolean().optional() })).optional(),
  active: z.boolean().optional(),
});

function scimUserResponse(user: { id: string; email: string; name: string | null; isActive?: boolean }): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: user.id,
    userName: user.email,
    name: {
      givenName: user.name?.split(" ")[0] || "",
      familyName: user.name?.split(" ").slice(1).join(" ") || "",
    },
    emails: [{ value: user.email, primary: true }],
    active: user.isActive !== false,
    meta: {
      resourceType: "User",
    },
  };
}

function scimGroupResponse(group: { id: string; displayName: string; members: { value: string; display: string }[] }): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    id: group.id,
    displayName: group.displayName,
    members: group.members.map((m) => ({
      value: m.value,
      display: m.display,
      $ref: `Users/${m.value}`,
    })),
    meta: {
      resourceType: "Group",
    },
  };
}

function scimError(status: number, detail: string): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  };
}

export default async function scimRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization;
    const expected = process.env.SCIM_BEARER_TOKEN;
    if (!expected) {
      return reply.status(501).send(scimError(501, "SCIM not configured"));
    }
    if (!auth || !auth.startsWith("Bearer ") || auth.slice(7) !== expected) {
      return reply.status(401).send(scimError(401, "Unauthorized"));
    }
  });

  app.get("/scim/v2/Users", async () => {
    const allUsers = (await app.container.userRepository.listAll()).filter((user) => user.isActive);
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: allUsers.length,
      Resources: allUsers.map(scimUserResponse),
    };
  });

  app.get("/scim/v2/Users/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };
    const user = await app.container.userRepository.findById(userId);
    if (!user) {
      return reply.status(404).send(scimError(404, "User not found"));
    }
    return scimUserResponse(user);
  });

  app.post("/scim/v2/Users", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = ScimUserSchema.parse(request.body);
    const email = body.userName.toLowerCase().trim();

    let user = await app.container.userRepository.findByEmail(email);
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
      isNewUser = true;
    }

    if (body.active === false && user.isActive) {
      await app.container.userRepository.deactivate(user.id);
      user = (await app.container.userRepository.findById(user.id)) ?? user;
    } else if (body.active === true && !user.isActive) {
      user = (await app.container.userRepository.update(user.id, { isActive: true })) ?? user;
    }

    await request.audit(isNewUser ? "scim_user_created" : "scim_user_updated", { userId: user.id, email: user.email });
    return reply.status(201).send(scimUserResponse(user));
  });

  app.put("/scim/v2/Users/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };
    const body = ScimUserSchema.parse(request.body);

    const existing = await app.container.userRepository.findById(userId);
    if (!existing) {
      return reply.status(404).send(scimError(404, "User not found"));
    }

    if (body.active === false && existing.isActive) {
      await app.container.userRepository.deactivate(userId);
    } else {
      await app.container.userRepository.update(userId, {
        email: body.userName.toLowerCase().trim(),
        name: body.name
          ? `${body.name.givenName || ""} ${body.name.familyName || ""}`.trim()
          : undefined,
        isActive: body.active,
      });
    }

    const updated = await app.container.userRepository.findById(userId);
    if (!updated) {
      return reply.status(404).send(scimError(404, "User not found"));
    }
    await request.audit("scim_user_updated", { userId: updated.id, email: updated.email });
    return scimUserResponse(updated);
  });

  app.delete("/scim/v2/Users/:userId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };
    const user = await app.container.userRepository.findById(userId);
    await app.container.userRepository.deleteById(userId);
    await request.audit("scim_user_deleted", { userId, email: user?.email });
    return reply.status(204).send();
  });

  app.get("/scim/v2/Groups", async () => {
    const memberships = await db
      .select({ orgId: orgMemberships.orgId, role: orgMemberships.role })
      .from(orgMemberships);

    const groupMap = new Map<string, { orgId: string; role: string; members: { value: string; display: string }[] }>();
    for (const m of memberships) {
      const key = `${m.orgId}:${m.role}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, { orgId: m.orgId, role: m.role, members: [] });
      }
    }

    const groups: { id: string; displayName: string; members: { value: string; display: string }[] }[] = [];
    for (const [key, group] of groupMap) {
      const org = await app.container.organizationRepository.findById(group.orgId);
      const orgName = org?.name || group.orgId;
      const members = await db
        .select({ userId: orgMemberships.userId, email: users.email })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, group.orgId), eq(orgMemberships.role, group.role)))
        .innerJoin(users, eq(orgMemberships.userId, users.id));

      groups.push({
        id: key,
        displayName: `${orgName}:${group.role}`,
        members: members.map((m) => ({ value: m.userId, display: m.email })),
      });
    }

    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: groups.length,
      Resources: groups.map(scimGroupResponse),
    };
  });

  app.get("/scim/v2/Groups/:groupId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { groupId } = request.params as { groupId: string };
    const [orgId, role] = groupId.split(":");

    if (!orgId || !role) {
      return reply.status(400).send(scimError(400, "Invalid group ID format. Expected orgId:role"));
    }

    const org = await app.container.organizationRepository.findById(orgId);
    if (!org) {
      return reply.status(404).send(scimError(404, "Organization not found"));
    }

    const members = await db
      .select({ userId: orgMemberships.userId, email: users.email })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, role)))
      .innerJoin(users, eq(orgMemberships.userId, users.id));

    return scimGroupResponse({
      id: groupId,
      displayName: `${org.name}:${role}`,
      members: members.map((m) => ({ value: m.userId, display: m.email })),
    });
  });
}
