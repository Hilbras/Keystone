import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requirePermission, hasPermission, type PermissionInput } from "../services/permissions.js";

declare module "fastify" {
  interface FastifyInstance {
    requirePermission: (resource: string, action: string) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async function permissionsPlugin(app: FastifyInstance) {
  app.decorate(
    "requirePermission",
    function (resource: string, action: string) {
      return async function (request: FastifyRequest, reply: FastifyReply) {
        const membership = request.state?.membership;
        if (!membership) {
          return reply.status(403).send({ error: "Organization membership required" });
        }
        try {
          await requirePermission(membership.role, resource, action);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Forbidden";
          return reply.status(403).send({ error: message });
        }
      };
    }
  );
});
