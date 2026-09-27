import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    requireHumanPrincipal: () => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Reject machine credentials on routes that only make sense for a person.
 *
 * A service account authenticates by presenting an API key, and the auth plugin
 * then synthesizes a `request.user` so existing routes keep working. The
 * synthesized principal has an id of `sa:<uuid>`, which matches no row in
 * `users` and no row in `org_memberships`.
 *
 * That makes most routes fail by accident rather than by decision: a write keyed
 * on `request.user.id` updates zero rows, and an org-permission check finds no
 * membership and returns 403. Correct, but incidental — and it relies on every
 * future route happening to key off the user id. A route that acted on
 * `request.state.org`, or on the service account's own `orgId`, would not be
 * stopped by any of that.
 *
 * So the boundary is stated rather than implied. On the routes this guard is
 * applied to, a machine credential is refused with a 403 that says why, instead
 * of being allowed through to fail somewhere less obvious.
 */
export default fp(async function machinePrincipalBoundary(app: FastifyInstance) {
  /**
   * Refuse the request if a service account authenticated it.
   *
   * Place after `authenticate`, since that is what populates
   * `request.serviceAccount`.
   */
  app.decorate("requireHumanPrincipal", function requireHumanPrincipal() {
    return async function humanPrincipalCheck(request: FastifyRequest, reply: FastifyReply) {
      if (!request.serviceAccount) return;
      await request.audit("unauthorized_access", {
        action: "machine_principal_on_interactive_route",
        serviceAccountId: request.serviceAccount.id,
        method: request.method,
        url: request.url,
      });
      return reply.status(403).send({
        error: "This endpoint is for user sessions only",
        code: "MACHINE_PRINCIPAL_REFUSED",
      });
    };
  });
});
