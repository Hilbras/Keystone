import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isOrganizationRole } from "../services/domain/authorization.js";

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
        await request.server.authenticate(request, reply);
        if (reply.sent) return;

        const { id: orgId } = request.params as { id?: string };
        if (!orgId) {
          return reply.status(403).send({ error: "Organization context required" });
        }

        const membership = await request.server.container.organizationRepository.findMembership(orgId, request.user!.id);
        if (!membership || !isOrganizationRole(membership.role)) {
          await request.audit("unauthorized_access", {
            action: "organization_permission_required",
            orgId,
            resource,
            requiredAction: action,
          });
          return reply.status(403).send({ error: "Organization membership required" });
        }

        const allowed = await request.server.container.permissionRepository.hasPermission(membership.role, resource, action);
        if (!allowed) {
          await request.audit("unauthorized_access", {
            action: "organization_permission_required",
            orgId,
            resource,
            requiredAction: action,
          });
          return reply.status(403).send({ error: `Missing permission ${resource}:${action}` });
        }

        request.state.membership = membership;
        const organization = await request.server.container.organizationRepository.findById(orgId);
        if (organization) request.state.org = organization;
      };
    }
  );
});
