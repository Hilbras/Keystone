import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requirePlatformRole } from "./helpers.js";
import { listEndpoints, createEndpoint, updateEndpoint, deleteEndpoint, rotateEndpointSecret, listDeliveries, retryDelivery } from "../../services/webhooks.js";
import { OutboundUrlRejected } from "../../services/outboundPolicy.js";

/**
 * Turn a policy rejection into a 400 rather than a 500.
 *
 * The URL is operator-supplied, so refusing it is a client error, and a 500
 * would tell the operator to retry a request that can never succeed. The
 * message is passed through because each one names the specific rule that was
 * broken, and an operator who aimed a webhook at `169.254.169.254` needs to be
 * told that is the reason.
 */
function urlRejection(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof OutboundUrlRejected)) return false;
  reply.status(400).send({ error: error.message });
  return true;
}

const CreateWebhookSchema = z.object({
  appId: z.string().uuid().nullable().optional(),
  url: z.string().url().max(2048),
  description: z.string().max(255).optional(),
  events: z.array(z.string().max(64)).optional(),
});

const UpdateWebhookSchema = z.object({
  url: z.string().url().max(2048).optional(),
  description: z.string().max(255).nullable().optional(),
  events: z.array(z.string().max(64)).optional(),
  isActive: z.boolean().optional(),
});

export default async function webhooksRoutes(app: FastifyInstance) {
  app.get("/platform/webhooks", { preHandler: [requirePlatformRole("owner")] }, async (request) => {
    const query = request.query as { appId?: string };
    const endpoints = await listEndpoints(query.appId);
    return { endpoints: endpoints.map(({ secret: _secret, ...rest }) => rest) };
  });

  app.post("/platform/webhooks", { preHandler: [requirePlatformRole("owner")] }, async (request, reply) => {
    const body = CreateWebhookSchema.parse(request.body);
    let endpoint;
    try {
      endpoint = await createEndpoint(body);
    } catch (err) {
      if (urlRejection(err, reply)) return reply;
      throw err;
    }
    await request.audit("platform_webhook_created", { endpointId: endpoint.id, url: endpoint.url });
    const { secret: _secret, ...rest } = endpoint;
    return reply.status(201).send({ endpoint: rest, signingSecret: endpoint.signingSecret });
  });

  app.patch("/platform/webhooks/:id", { preHandler: [requirePlatformRole("owner")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = UpdateWebhookSchema.parse(request.body);
    let updated;
    try {
      updated = await updateEndpoint(id, body);
    } catch (err) {
      if (urlRejection(err, reply)) return reply;
      throw err;
    }
    if (!updated) return reply.status(404).send({ error: "Webhook not found" });
    await request.audit("platform_webhook_updated", { endpointId: id, url: updated.url });
    const { secret: _secret, ...rest } = updated;
    return { endpoint: rest };
  });

  app.delete("/platform/webhooks/:id", { preHandler: [requirePlatformRole("owner")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteEndpoint(id);
    if (!deleted) return reply.status(404).send({ error: "Webhook not found" });
    await request.audit("platform_webhook_deleted", { endpointId: id });
    return { success: true };
  });

  app.post("/platform/webhooks/:id/rotate-secret", { preHandler: [requirePlatformRole("owner")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await rotateEndpointSecret(id);
    if (!result) return reply.status(404).send({ error: "Webhook not found" });
    await request.audit("platform_webhook_secret_rotated", { endpointId: id });
    return { signingSecret: result.signingSecret };
  });

  app.get("/platform/webhooks/:id/deliveries", { preHandler: [requirePlatformRole("owner")] }, async (request) => {
    const { id } = request.params as { id: string };
    const deliveries = await listDeliveries(id);
    return { deliveries };
  });

  app.post("/platform/webhook-deliveries/:id/retry", { preHandler: [requirePlatformRole("owner")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await retryDelivery(id);
    if (!ok) return reply.status(400).send({ error: "Delivery is not in a failed state" });
    return { success: true };
  });
}
