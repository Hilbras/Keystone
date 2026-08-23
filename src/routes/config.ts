import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { createConfigWriter } from "../services/setup/configWriter.js";
import { queue } from "../services/queue/index.js";

const UpdateConfigSchema = z.object({
  values: z.record(z.string()),
});

export default async function configRoutes(app: FastifyInstance) {
  // Read current configuration values from the configured store (.env by default).
  app.get("/", { preHandler: [app.authenticate] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const writer = createConfigWriter();
      const values = await writer.read();
      return reply.send({ values });
    } catch (err) {
      app.log.error({ err }, "Failed to read configuration");
      return reply.status(500).send({ error: "Failed to read configuration" });
    }
  });

  // Update configuration values. A restart is required for most changes to take effect.
  app.put("/", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = UpdateConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.issues });
    }

    try {
      const writer = createConfigWriter();
      const backup = await writer.backup();
      if (!backup.success) {
        return reply.status(500).send({ error: backup.error.message, code: backup.error.code });
      }

      const writeResult = await writer.write(parsed.data.values);
      if (!writeResult.success) {
        return reply.status(500).send({ error: writeResult.error.message, code: writeResult.error.code });
      }

      return reply.send({ ok: true, backupPath: backup.data || undefined });
    } catch (err) {
      request.log.error({ err }, "Failed to update configuration");
      return reply.status(500).send({ error: "Failed to update configuration" });
    }
  });

  // Restart the server so new configuration is loaded.
  app.post("/restart", { preHandler: [app.authenticate] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.status(202).send({ ok: true, message: "Server is restarting" });
    try {
      await queue.close?.();
    } catch {
      // ignore
    }
    setTimeout(() => process.exit(0), 500);
  });
}
