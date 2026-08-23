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

function buildPayload(request: FastifyRequest, metadata?: Record<string, unknown>): EventPayload {
  return {
    userId: request.user?.id,
    orgId: request.state?.org?.id,
    appId: request.state?.app?.id,
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
    await audit({ ...buildPayload(this, metadata), event });
  });

  app.decorateRequest("emitEvent", async function (
    this: FastifyRequest,
    event: string,
    metadata?: Record<string, unknown>
  ) {
    await emit({ type: event, payload: buildPayload(this, metadata) });
  });
});
