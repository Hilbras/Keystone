import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { audit, type AuditEvent } from "../services/audit.js";
import { emit } from "../services/events/bus.js";
import type { EventPayload } from "../services/events/types.js";

declare module "fastify" {
  interface FastifyRequest {
    audit: (event: AuditEvent, metadata?: Record<string, unknown>) => Promise<void>;
    emitEvent: (event: string, metadata?: Record<string, unknown>) => Promise<void>;
  }
}

async function buildPayload(request: FastifyRequest, metadata?: Record<string, unknown>): Promise<EventPayload> {
  const metadataOrgId = typeof metadata?.orgId === "string" ? metadata.orgId : undefined;
  const metadataAppId = typeof metadata?.appId === "string" ? metadata.appId : undefined;
  let orgId = request.state?.org?.id;
  let appId: string | undefined;

  if (
    request.user &&
    request.state?.membership &&
    request.state.app?.orgId === request.state.membership.orgId
  ) {
    appId = request.state.app.id;
  }

  if (!orgId && metadataOrgId && request.state?.membership?.orgId === metadataOrgId) {
    orgId = metadataOrgId;
  }

  if (!orgId && request.user && metadataOrgId && request.state?.app?.orgId === metadataOrgId) {
    const membership = await request.server.container.organizationRepository.findMembership(
      metadataOrgId,
      request.user.id
    );
    if (membership) orgId = metadataOrgId;
  }

  if (!appId && metadataAppId && request.state?.app?.id === metadataAppId && orgId === request.state.app?.orgId) {
    appId = metadataAppId;
  }

  return {
    userId: request.user?.id ?? request.state?.auditUserId,
    orgId,
    appId,
    requestId: request.id,
    ip: request.ip,
    userAgent: request.headers["user-agent"],
    metadata,
  };
}

export default fp(async function auditPlugin(app: FastifyInstance) {
  app.decorateRequest("audit", async function (
    this: FastifyRequest,
    event: AuditEvent,
    metadata?: Record<string, unknown>
  ) {
    await audit({ ...(await buildPayload(this, metadata)), event });
  });

  app.decorateRequest("emitEvent", async function (
    this: FastifyRequest,
    event: string,
    metadata?: Record<string, unknown>
  ) {
    await emit({ type: event, payload: await buildPayload(this, metadata) });
  });
});
