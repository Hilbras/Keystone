import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireOwner } from "./helpers.js";

const CreatePermissionSchema = z.object({
  resource: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, "lowercase snake_case only"),
  action: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, "lowercase snake_case only"),
  description: z.string().max(255).optional(),
});

const RolePermissionSchema = z.object({
  permissionId: z.string().uuid(),
});

export default async function permissionsRoutes(app: FastifyInstance) {
  app.get("/permissions", { preHandler: [requireOwner()] }, async () => {
    return { permissions: await app.container.permissionRepository.list() };
  });

  app.post("/permissions", { preHandler: [requireOwner()] }, async (request, reply) => {
    const body = CreatePermissionSchema.parse(request.body);
    const created = await app.container.permissionRepository.create(body);
    if (!created) {
      return reply.status(409).send({ error: `Permission ${body.resource}:${body.action} already exists` });
    }
    await request.audit("permission_created", {
      permissionId: created.id,
      resource: created.resource,
      action: created.action,
    });
    return reply.status(201).send(created);
  });

  app.delete("/permissions/:id", { preHandler: [requireOwner()] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = await app.container.permissionRepository.remove(id);
    if (!removed) {
      return reply.status(404).send({ error: "Permission not found" });
    }
    await request.audit("permission_deleted", {
      permissionId: removed.id,
      resource: removed.resource,
      action: removed.action,
    });
    return { success: true };
  });

  app.get("/roles", { preHandler: [requireOwner()] }, async () => {
    const roles = await app.container.permissionRepository.listDistinctRoles();
    return { roles };
  });

  app.get("/roles/:role/permissions", { preHandler: [requireOwner()] }, async (request) => {
    const { role } = request.params as { role: string };
    return { role, permissions: await app.container.permissionRepository.listForRole(role) };
  });

  app.post(
    "/roles/:role/permissions",
    { preHandler: [requireOwner()] },
    async (request, reply) => {
      const { role } = request.params as { role: string };
      const body = RolePermissionSchema.parse(request.body);
      await app.container.permissionRepository.assignToRole(role, body.permissionId);
      await request.audit("organization_member_role_updated", { role, permissionId: body.permissionId });
      return reply.status(201).send({ success: true });
    }
  );

  app.delete(
    "/roles/:role/permissions/:permissionId",
    { preHandler: [requireOwner()] },
    async (request) => {
      const { role, permissionId } = request.params as { role: string; permissionId: string };
      await app.container.permissionRepository.removeFromRole(role, permissionId);
      await request.audit("organization_member_role_updated", { role, permissionId });
      return { success: true };
    }
  );
}
