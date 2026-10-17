import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getSdk } from "../../sdk/index.js";
import {
  isOrganizationRole,
  isPlatformRole,
  type OrgRole,
  type PlatformRole,
} from "../../services/domain/authorization.js";
import { sendResultError } from "../helpers.js";

export { sendResultError } from "../helpers.js";

/**
 * Authenticate the request and require a platform role. Platform roles are
 * intentionally evaluated independently from organization membership roles.
 */
export function requirePlatformRole(requiredRole: PlatformRole = "owner") {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await request.server.authenticate(request, reply);
    if (reply.sent) return;

    if (!isPlatformRole(request.user!.role) || request.user!.role !== requiredRole) {
      await request.audit("unauthorized_access", {
        action: "platform_role_required",
        requiredRole,
        targetUserId: (request.params as { id?: string }).id,
      });
      return reply.status(403).send({ error: "Forbidden" });
    }
  };
}

/**
 * Authenticate the request, resolve the route organization's membership, and
 * optionally require a permission for that membership role.
 */
export function requireOrganizationRole(
  allowedRoles: OrgRole[],
  permission?: { resource: string; action: string }
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await request.server.authenticate(request, reply);
    if (reply.sent) return;

    // A malformed uuid here would otherwise reach the Postgres uuid columns as
    // a cast error (500); a bad id is a client error, not a server failure.
    const params = OrganizationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid input", details: params.error.issues });
    }
    const orgId = params.data.id;
    const sdk = getSdk();
    const membershipResult = await sdk.authorization.requireOrgRole(request.user!.id, orgId, allowedRoles);
    if (!membershipResult.success) {
      await request.audit("unauthorized_access", {
        action: "organization_role_required",
        orgId,
        allowedRoles,
      });
      return sendResultError(reply, membershipResult);
    }

    const membership = membershipResult.data;
    if (!isOrganizationRole(membership.role)) {
      await request.audit("unauthorized_access", {
        action: "organization_role_invalid",
        orgId,
        userId: request.user!.id,
      });
      return reply.status(403).send({ error: "Forbidden" });
    }
    request.state.membership = membership;

    const organization = await request.server.container.organizationRepository.findById(orgId);
    if (organization) request.state.org = organization;

    if (permission) {
      const permResult = await sdk.authorization.requirePermission(
        request.user!.id,
        orgId,
        permission.resource,
        permission.action
      );
      if (!permResult.success) {
        await request.audit("unauthorized_access", {
          action: "organization_permission_required",
          orgId,
          resource: permission.resource,
          requiredAction: permission.action,
        });
        return sendResultError(reply, permResult);
      }
    }
  };
}

/** @deprecated Use requirePlatformRole("owner"). */
export const requireOwner = () => requirePlatformRole("owner");

/** @deprecated Use requireOrganizationRole. */
export const requireAuthAndRole = requireOrganizationRole;

export const ipEntry = z.string().max(64).regex(/^[0-9a-fA-F:./]+$/, "Invalid IP or CIDR entry");

export const BrandingSchema = z
  .object({
    logoUrl: z.string().url().max(2048).optional(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use #rrggbb format").optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use #rrggbb format").optional(),
    companyName: z.string().max(255).optional(),
    supportEmail: z.string().email().max(255).optional(),
    loginTitle: z.string().max(255).optional(),
    loginSubtitle: z.string().max(500).optional(),
  })
  .strict();

/**
 * Bounded pagination for list endpoints. The shared defaults cover the common
 * case; endpoints with a different historical fallback override `limit` at the
 * call site via `.extend` so the old default keeps applying.
 */
export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Path params for `/organizations/:id/...` routes. */
export const OrganizationParamsSchema = z.object({ id: z.string().uuid() });
