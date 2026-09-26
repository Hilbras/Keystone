import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  describeUntrustedPeer,
  hasTrustedProxies,
  peerAddress,
  stripUntrustedHeaders,
} from "../services/trustedProxies.js";

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
  let warned = false;

  app.addHook("onRequest", async (request) => {
    const trusted = stripUntrustedHeaders(request);
    if (trusted) return;

    request.log.debug({ peer: peerAddress(request) }, "stripped untrusted client-identity headers");

    // The one stripping outcome that indicates a broken deployment rather than
    // a hostile client: an infrastructure address arriving while no trusted
    // proxy is configured. That state fails silently — every client shares one
    // rate-limit budget — so say so once instead of leaving it to be guessed.
    if (!warned) {
      const reason = describeUntrustedPeer(peerAddress(request));
      if (reason) {
        warned = true;
        request.log.warn(
          { peer: peerAddress(request) },
          `mTLS/proxy trust boundary not configured: ${reason}`
        );
      }
    }
  });

  // State the trust posture at boot. A deployment that expected a proxy to be
  // trusted should not have to discover the mistake from a support ticket.
  app.log.info(
    hasTrustedProxies()
      ? "client-identity headers will be honoured from configured trusted proxies"
      : "no trusted proxies configured: client-identity headers will be stripped from every request"
  );
});
