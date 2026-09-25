import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getSdk } from "../sdk/index.js";

const CheckSchema = z.object({
  resource: z.string().min(1),
  action: z.string().min(1),
  organizationId: z.string().uuid(),
});

export default async function authzRoutes(app: FastifyInstance) {
  const sdk = getSdk();

  app.post(
    "/authz/check",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CheckSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid input", details: parsed.error.issues });
      const body = parsed.data;
      const membership = await sdk.authorization.isOrgMember(request.user!.id, body.organizationId);

      if (!membership) {
        await request.audit("unauthorized_access", {
          action: "authz_check",
          orgId: body.organizationId,
          resource: body.resource,
          requiredAction: body.action,
        });
        return reply.status(403).send({
          allowed: false,
          reason: "Not a member of this organization",
        });
      }

      request.state.org = await request.server.container.organizationRepository.findById(body.organizationId);
      const allowed = await sdk.authorization.hasPermission(
        request.user!.id,
        body.organizationId,
        body.resource,
        body.action
      );
      await request.audit("authz_check", {
        orgId: body.organizationId,
        resource: body.resource,
        action: body.action,
        role: membership.role,
        allowed,
      });

      return { allowed };
    }
  );
}
