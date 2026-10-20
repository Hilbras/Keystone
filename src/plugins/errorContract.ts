import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { defaultErrorCodeForStatus } from "../lib/errorCodes.js";

/**
 * The Keystone JSON error contract: `{ error, code, requestId }`.
 *
 * ## Why a hook and not fifty handlers
 *
 * The contract was already `{ error, code }`, but only the paths that went through
 * `sendResultError` honoured it. The remaining handlers sent `{ error: "Forbidden" }`,
 * `{ error: "Invalid input", details }`, or nothing but a message, so a client that
 * wanted to branch on `code` had to branch on prose that changes freely. Rewriting
 * every send site would also have been a change to fifty places that the next route
 * would not inherit.
 *
 * `onSend` is the one point every JSON error passes through. It fills what is
 * missing and leaves what is present alone, which makes the contract additive: a
 * handler that says something more specific keeps saying it, and a new handler gets
 * the fallback without knowing this file exists.
 *
 * ## What it deliberately does not touch
 *
 * **Protocol envelopes.** OAuth 2.0 (`{ error: "invalid_grant" }`), SCIM 2.0
 * (`{ schemas, status, detail }`) and SAML responses are defined by RFCs and consumed
 * by clients that will not read a Keystone `code`. OAuth errors keep their shape and
 * gain only `requestId`, which is an ignorable addition under RFC 6749 §5.2; SCIM and
 * SAML bodies are left entirely alone because they do not carry `error` or `code`.
 *
 * **Authorization decisions.** `{ allowed, reason }` is a decision, not an error.
 * Adding an HTTP error code to a successful 200 that says "no" would be wrong.
 *
 * **Non-JSON bodies.** Metrics, PEM, XML metadata and streams are returned untouched;
 * the hook is on the error path only, so a healthy request never pays for the parse.
 */
const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "mfa_required",
  "server_error",
  "temporarily_unavailable",
  "identity_broker_failure",
]);

export default fp(async function errorContract(app: FastifyInstance) {
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode < 400 || typeof payload !== "string" || payload.length === 0) {
      return payload;
    }

    const contentType = String(reply.getHeader("content-type") ?? "");
    if (contentType && !contentType.includes("json")) return payload;

    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return payload;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return payload;

    const record = body as Record<string, unknown>;
    if (!("error" in record) && !("code" in record)) return payload;

    if (typeof record.requestId !== "string") {
      record.requestId = request.id;
    }

    const isOAuthError =
      typeof record.error === "string" &&
      (OAUTH_ERROR_CODES.has(record.error) || "error_description" in record);

    if (!isOAuthError && typeof record.code !== "string") {
      record.code = defaultErrorCodeForStatus(reply.statusCode, "details" in record);
    }

    return JSON.stringify(record);
  });
});
