import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { serviceAccounts } from "../db/schema.js";
import {
  canonicalFingerprint,
  isFromTrustedProxy,
  isValidFingerprint,
  peerAddress,
} from "../services/trustedProxies.js";

/**
 * mTLS service-account authentication.
 *
 * TLS is terminated at a reverse proxy that validates the client certificate.
 * Keystone learns the result from headers the proxy sets — but only when the
 * request actually came from that proxy.
 *
 * Rules this plugin enforces:
 *
 *  1. **A header never establishes identity by itself.** Identity comes from a
 *     client certificate fingerprint that a trusted proxy forwarded, and that
 *     fingerprint is cryptographically bound to the service account in the
 *     database. The previous `x-service-account-id` shortcut is gone: it let any
 *     client name a service account and become it, with no certificate at all.
 *  2. **A request that did not come from a trusted proxy has no certificate
 *     identity.** `x-service-account-id` is accepted only as a *hint*, and only
 *     when the request also presents a valid fingerprint; the hint is then
 *     cross-checked against that fingerprint's binding.
 *  3. **A fingerprint must be a well-formed SHA-256 digest**, so a garbage or
 *     oversized header cannot be used as a lookup key.
 *
 * Service accounts without a bound fingerprint cannot authenticate by
 * certificate at all.
 */

const MTLS_HEADER = "x-forwarded-client-cert";
const MTLS_FINGERPRINT_HEADER = "x-client-cert-fingerprint";
const SERVICE_ACCOUNT_ID_HEADER = "x-service-account-id";

/** Cap on header length before parsing, so a hostile proxy cannot inflate work. */
const MAX_CERT_HEADER_LENGTH = 8192;

declare module "fastify" {
  interface FastifyInstance {
    requireMTLS: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface ClientCertEvidence {
  fingerprint?: string;
  subject?: string;
  /** Whether the evidence came from a configured trusted proxy. */
  trusted: boolean;
}

/**
 * Read certificate evidence. Returns nothing when the peer is not a trusted
 * proxy, even if the headers are present.
 */
export function extractClientCert(request: FastifyRequest): ClientCertEvidence {
  if (!isFromTrustedProxy(request)) return { trusted: false };

  const rawFingerprint = request.headers[MTLS_FINGERPRINT_HEADER];
  const rawCert = request.headers[MTLS_HEADER];

  const fingerprint =
    typeof rawFingerprint === "string" && isValidFingerprint(rawFingerprint.trim())
      ? canonicalFingerprint(rawFingerprint)
      : undefined;

  const subject =
    typeof rawCert === "string" && rawCert.length > 0 && rawCert.length <= MAX_CERT_HEADER_LENGTH
      ? rawCert
      : undefined;

  return { fingerprint, subject, trusted: true };
}

type ServiceAccount = typeof serviceAccounts.$inferSelect;

/**
 * Resolve a service account from a validated certificate fingerprint.
 *
 * The lookup is by `certFingerprint`, not by `name`: a name is operator-chosen
 * and guessable, whereas the fingerprint is pinned to a certificate.
 */
async function resolveByFingerprint(fingerprint: string): Promise<ServiceAccount | undefined> {
  const [record] = await db
    .select()
    .from(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.certFingerprint, fingerprint),
        eq(serviceAccounts.isActive, true),
        isNull(serviceAccounts.revokedAt)
      )
    )
    .limit(1);
  return record;
}

/**
 * Optional narrowing: when the proxy also named the service account, the named
 * account must be the one bound to the presented certificate. A mismatch is a
 * spoofing signal, not a fallback.
 */
async function crossCheckHint(hintId: string, fingerprint: string): Promise<ServiceAccount | undefined> {
  const [hinted] = await db
    .select()
    .from(serviceAccounts)
    .where(and(eq(serviceAccounts.id, hintId), isNull(serviceAccounts.revokedAt)))
    .limit(1);
  if (!hinted) return undefined;
  if (hinted.certFingerprint && hinted.certFingerprint !== fingerprint) return undefined;
  return resolveByFingerprint(fingerprint);
}

export function requireMTLS() {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const evidence = extractClientCert(request);

    if (!evidence.trusted) {
      // Distinguish "not behind a proxy we trust" from "no certificate" so an
      // operator can tell a misconfiguration from an attack.
      return reply.status(401).send({
        error: "Client certificate required",
        code: isFromTrustedProxy(request) ? "MTLS_CERTIFICATE_MISSING" : "MTLS_UNTRUSTED_PEER",
      });
    }

    if (!evidence.fingerprint) {
      return reply.status(401).send({
        error: "A valid client certificate fingerprint is required",
        code: "MTLS_FINGERPRINT_MISSING",
      });
    }

    const hint = request.headers[SERVICE_ACCOUNT_ID_HEADER];
    const serviceAccount =
      typeof hint === "string" && hint
        ? await crossCheckHint(hint, evidence.fingerprint)
        : await resolveByFingerprint(evidence.fingerprint);

    if (!serviceAccount) {
      request.log.warn(
        { fingerprint: evidence.fingerprint, peer: peerAddress(request) },
        "mTLS: no active service account is bound to the presented certificate"
      );
      return reply.status(403).send({
        error: "Client certificate not mapped to a service account",
        code: "MTLS_CERTIFICATE_UNMAPPED",
      });
    }

    request.serviceAccount = serviceAccount;
    request.log.debug({ serviceAccountId: serviceAccount.id }, "mTLS: service account authenticated");
  };
}

export default fp(async function mtlsPlugin(app: FastifyInstance) {
  app.decorate("requireMTLS", requireMTLS());
});

/** Exported for tests: find any service account bound to a fingerprint. */
export async function findServiceAccountByFingerprint(fingerprint: string) {
  return resolveByFingerprint(canonicalFingerprint(fingerprint));
}

void or;
