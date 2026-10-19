import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { newTraceId, parseTraceparent, runWithTrace } from "../lib/traceContext.js";

/**
 * Give every request a trace id and make it ambient for the rest of the request.
 *
 * Registered as a plugin and not as a bare `addHook` in `buildApp`, so the id is
 * set once for the whole server rather than re-registered by anything that calls
 * `addHook` later.
 *
 * **The callback form of the hook is load-bearing.** `runWithTrace` installs the
 * id in an `AsyncLocalStorage`, and an `async` hook would return a promise that
 * resolves *inside* the store while the work that continues the request runs
 * afterwards, outside it — so the id would be visible to this hook and to nothing
 * else, and the code below it would silently see `undefined`. Calling `done()`
 * from within `runWithTrace` continues the request handling in the same
 * synchronous chain, which is the one place `AsyncLocalStorage` reliably covers.
 * This is the same mechanism `@fastify/request-context` exists to wrap; it is
 * written out here because one hook is not worth a dependency.
 *
 * The id is echoed on the response as `trace-id`, which is what turns a user's
 * report of a failed request into a log query. The header is only set when it is
 * absent, so a route that wants to emit its own is not overwritten.
 */
export default fp(async function requestTrace(app: FastifyInstance) {
  app.addHook(
    "onRequest",
    (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
      const context = parseTraceparent(request.headers.traceparent) ?? { traceId: newTraceId() };
      request.traceId = context.traceId;
      if (!reply.hasHeader("trace-id")) reply.header("trace-id", context.traceId);
      runWithTrace(context, () => done());
    }
  );
});
