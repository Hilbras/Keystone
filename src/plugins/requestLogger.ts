import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stripQuery } from "../lib/logSanitizer.js";

/**
 * The access log line, and the two things it must not contain.
 *
 * ## The query string
 *
 * §5.1 says never to log access tokens, refresh tokens or OAuth codes. The largest
 * source of those is not a field anybody chose to log — it is `request.url`, which
 * every access log records and which *is* a credential on four of this server's
 * routes: `GET /auth/magic-link/verify?token=…` and
 * `GET /auth/email-verification/verify?token=…` consume a token that by itself
 * authenticates the request, and the two OIDC callbacks receive an authorization
 * code. Logging the raw target wrote all four into the access log in clear text,
 * where they persist after being consumed and are indexed by whatever collects the
 * logs. The path is logged instead — see `stripQuery`.
 *
 * ## Everything else
 *
 * The remaining fields are §5.1's list, restricted to what an access log can
 * actually know: who acted, in which tenant, what operation, how long, how it
 * ended, and the error code if it failed. The values themselves — bodies, headers,
 * query — are not logged here at all, which is why this line is not a leak surface
 * and why the scrubbing in `loggerOptions` is the backstop for the call sites that
 * do log payloads.
 *
 * `operation` is the route *pattern* rather than the request target, so
 * `/v1/users/8f3c…` and `/v1/users/1a9d…` are one series instead of one per user
 * id — which is the difference between a metric that can be grouped and a metric
 * that cannot.
 */
export default fp(async function requestLogger(app: FastifyInstance) {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    request._startTime = Date.now();
    reply.header("request-id", request.id);
  });

  /**
   * Capture the error code while the body is still in hand.
   *
   * The error contract is `{ error, code }`, and `code` is the field worth having
   * in a log line — the message is prose and changes freely, the code is the
   * stable thing an operator greps for. It is not recoverable later: `onResponse`
   * runs after the body is written.
   *
   * Only failures, so the parse is off the path a healthy request takes.
   */
  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (reply.statusCode < 400 || typeof payload !== "string") return payload;
    try {
      const body = JSON.parse(payload) as { code?: unknown };
      if (typeof body?.code === "string") request._errorCode = body.code;
    } catch {
      // A non-JSON error body is not a reason to fail the request it is reporting
      // on. The line is still written, without an error code.
    }
    return payload;
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const durationMs = request._startTime ? Date.now() - request._startTime : undefined;
    const failed = reply.statusCode >= 400;
    request.log.info(
      {
        requestId: request.id,
        // §5.4. The id that outlives this request. `requestId` is minted here and
        // dies with the response, so a job that this request enqueued and a webhook
        // it caused carry the trace id and nothing else — which makes this line the
        // join between an access log and everything downstream of it.
        traceId: request.traceId,
        operation: `${request.method} ${request.routeOptions?.url ?? stripQuery(request.url)}`,
        method: request.method,
        // Not `request.url`: the query string is a credential on this server.
        path: stripQuery(request.url),
        statusCode: reply.statusCode,
        result: failed ? "error" : "success",
        errorCode: request._errorCode,
        // Both omitted rather than logged as null when the caller is anonymous, so
        // "no actor" and "actor unknown" do not look the same in an index.
        actorId: request.user?.id ?? request.state?.auditUserId,
        tenantId: request.authClaims?.org_id ?? request.state?.org?.id,
        durationMs,
        ip: request.ip,
      },
      "request"
    );
  });
});
