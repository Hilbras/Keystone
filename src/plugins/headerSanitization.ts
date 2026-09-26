import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { stripUntrustedHeaders } from "../services/trustedProxies.js";

/**
 * Runs before routing, authentication, and every route handler.
 *
 * Identity-bearing headers are removed from any request that did not arrive
 * from a configured trusted proxy. Stripping — rather than merely ignoring the
 * headers where we happen to check them — means no route, plugin, or future
 * feature can read a spoofed identity by accident.
 *
 * With no trusted proxies configured, this strips unconditionally, which is
 * the safe default.
 */
export default fp(async function headerSanitizationPlugin(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    const trusted = stripUntrustedHeaders(request);
    if (!trusted) {
      request.log.debug(
        { peer: request.socket?.remoteAddress },
        "stripped untrusted client-identity headers"
      );
    }
  });
});
