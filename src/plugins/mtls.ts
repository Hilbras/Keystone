import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { serviceAccounts } from "../db/schema.js";

/**
 * mTLS authentication plugin.
 *
 * In production, terminate TLS at a reverse proxy (nginx, envoy, AWS ALB, etc.)
 * that validates the client certificate and forwards the certificate fingerprint
 * or subject in a trusted header. This plugin reads that header and maps
 * certificates to service accounts.
 *
 * Headers read:
 *   - x-client-cert-fingerprint: SHA-256 fingerprint of the client certificate
 *   - x-forwarded-client-cert: PEM-encoded client certificate or DN subject
 *   - x-service-account-id: Optional explicit service account ID (for non-mTLS fallback)
 */

const MTLS_HEADER = "x-forwarded-client-cert";
const MTLS_FINGERPRINT_HEADER = "x-client-cert-fingerprint";
const SERVICE_ACCOUNT_ID_HEADER = "x-service-account-id";

declare module "fastify" {
  interface FastifyInstance {
    requireMTLS: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function extractClientCert(request: FastifyRequest): { fingerprint?: string; subject?: string } {
  const fingerprint = request.headers[MTLS_FINGERPRINT_HEADER];
  const cert = request.headers[MTLS_HEADER];
  return {
    fingerprint: typeof fingerprint === "string" ? fingerprint : undefined,
    subject: typeof cert === "string" ? cert : undefined,
  };
}

async function resolveServiceAccount(request: FastifyRequest): Promise<typeof serviceAccounts.$inferSelect | undefined> {
  const explicitId = request.headers[SERVICE_ACCOUNT_ID_HEADER];
  if (typeof explicitId === "string" && explicitId) {
    const [sa] = await db
      .select()
      .from(serviceAccounts)
      .where(eq(serviceAccounts.id, explicitId))
      .limit(1);
    if (sa?.isActive) {
      return sa;
    }
  }

  const { fingerprint, subject } = extractClientCert(request);
  if (!fingerprint && !subject) return undefined;

  // Look up service accounts by name matching the fingerprint or subject.
  // In a production system, you would store the certificate fingerprint in
  // the service_accounts table and query by it directly.
  const [sa] = await db
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.name, fingerprint || subject || ""))
    .limit(1);

  if (sa?.isActive) {
    return sa;
  }

  return undefined;
}

export function requireMTLS() {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const { fingerprint, subject } = extractClientCert(request);
    const explicitId = request.headers[SERVICE_ACCOUNT_ID_HEADER];

    if (!fingerprint && !subject && !explicitId) {
      return reply.status(401).send({ error: "Client certificate required" });
    }

    const serviceAccount = await resolveServiceAccount(request);
    if (!serviceAccount) {
      request.log.warn({ fingerprint, subject }, "mTLS: no matching service account found");
      return reply.status(403).send({ error: "Client certificate not mapped to a service account" });
    }

    request.serviceAccount = serviceAccount;
    request.log.debug({ serviceAccountId: serviceAccount.id }, "mTLS: service account authenticated");
  };
}

export default fp(async function mtlsPlugin(app: FastifyInstance) {
  app.decorate("requireMTLS", requireMTLS());
});
