import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getSdk } from "../../sdk/index.js";
import type { OrgRole } from "../../services/domain/authorization.js";
import { sendResultError } from "../helpers.js";

export { sendResultError } from "../helpers.js";

export function requireOwner() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await request.server.authenticate(request, reply);
    if (reply.sent) return;

    if (request.user!.role !== "owner") {
      return reply.status(403).send({ error: "Forbidden" });
    }
  };
}

export function requireAuthAndRole(allowedRoles: OrgRole[], permission?: { resource: string; action: string }) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await request.server.authenticate(request, reply);
    if (reply.sent) return;

    const { id } = request.params as { id: string };
    const sdk = getSdk();
    const membershipResult = await sdk.authorization.requireOrgRole(request.user!.id, id, allowedRoles);
    if (!membershipResult.success) return sendResultError(reply, membershipResult);
    request.state.membership = membershipResult.data;

    if (permission) {
      const permResult = await sdk.authorization.requirePermission(membershipResult.data.role, permission.resource, permission.action);
      if (!permResult.success) return sendResultError(reply, permResult);
    }
  };
}

export const ipEntry = z.string().max(64).regex(/^[0-9a-fA-F:.\/]+$/, "Invalid IP or CIDR entry");

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
