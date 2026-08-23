import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export default fp(async function requestLogger(app: FastifyInstance) {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    (request as unknown as Record<string, unknown>)._startTime = Date.now();
    reply.header("request-id", request.id);
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const start = (request as unknown as Record<string, unknown>)._startTime as number | undefined;
    const durationMs = start ? Date.now() - start : undefined;
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode,
        durationMs,
        ip: request.ip,
      },
      "request"
    );
  });
});
