import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getSdk } from "../sdk/index.js";

const CheckSchema = z.object({
  resource: z.string().min(1),
  action: z.string().min(1),
});

export default async function authzRoutes(app: FastifyInstance) {
  const sdk = getSdk();

  app.post(
    "/authz/check",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CheckSchema.parse(request.body);
      const membership = request.state?.membership;

      if (!membership) {
        return reply.status(403).send({
          allowed: false,
          reason: "No organization context",
        });
      }

      const allowed = await sdk.authorization.hasPermission(membership.role, body.resource, body.action);
      await request.audit("authz_check", {
        resource: body.resource,
        action: body.action,
        role: membership.role,
        allowed,
      });

      return { allowed };
    }
  );
}
