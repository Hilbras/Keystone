import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * mTLS authentication skeleton.
 *
 * In production, terminate TLS at a reverse proxy (nginx, envoy, AWS ALB, etc.)
 * that validates the client certificate and forwards the certificate fingerprint
 * or subject in a trusted header. This plugin reads that header and can be
 * extended to map certificates to service accounts.
 */

const MTLS_HEADER = "x-forwarded-client-cert";
const MTLS_FINGERPRINT_HEADER = "x-client-cert-fingerprint";

export function extractClientCert(request: FastifyRequest): { fingerprint?: string; subject?: string } {
  const fingerprint = request.headers[MTLS_FINGERPRINT_HEADER];
  const cert = request.headers[MTLS_HEADER];
  return {
    fingerprint: typeof fingerprint === "string" ? fingerprint : undefined,
    subject: typeof cert === "string" ? cert : undefined,
  };
}

export function requireMTLS() {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const { fingerprint, subject } = extractClientCert(request);
    if (!fingerprint && !subject) {
      return reply.status(401).send({ error: "Client certificate required" });
    }
    // TODO: map fingerprint/subject to service account and set request.serviceAccount.
    request.log.debug({ fingerprint, subject }, "mTLS request received");
  };
}

export default fp(async function mtlsPlugin(app: FastifyInstance) {
  app.decorate("requireMTLS", requireMTLS());
});

declare module "fastify" {
  interface FastifyInstance {
    requireMTLS: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
