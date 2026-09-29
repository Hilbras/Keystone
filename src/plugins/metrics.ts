import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { register, Counter, Histogram } from "prom-client";

export const httpRequestsTotal = new Counter({
  name: "keystone_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "keystone_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const failedLoginsTotal = new Counter({
  name: "keystone_failed_logins_total",
  help: "Total failed login attempts",
  labelNames: ["reason"],
});

export default fp(async function metricsPlugin(app: FastifyInstance) {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    /**
     * The route *template*, never the concrete URL.
     *
     * For an unmatched request there is no template, and the obvious fallback is
     * `request.url` — which is a cardinality bomb. A scanner probing random paths,
     * or a client with a bug in a URL, makes one new time series per request, and
     * `keystone_http_requests_total` grows without bound until Prometheus falls
     * over. Measured before this line changed:
     *
     *   keystone_http_requests_total{...,route="/nope/aaaaaaaa-1111",status_code="404"} 1
     *   keystone_http_requests_total{...,route="/nope/bbbbbbbb-2222",status_code="404"} 1
     *
     * Two requests, two series, and no upper bound on how many follow.
     *
     * So an unmatched request gets a single constant label. 404 volume is still
     * visible and still alertable — that is what `status_code` is for — and the
     * series count is bounded by the number of routes.
     */
    const template = (request as unknown as { routeOptions?: { url?: string } }).routeOptions?.url;
    const route = template ?? "unmatched";
    const labels = {
      method: request.method,
      route,
      status_code: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    const elapsedMs = (reply as unknown as { elapsedTime?: number }).elapsedTime ?? 0;
    httpRequestDurationSeconds.observe(labels, elapsedMs / 1000);
  });

  app.get("/metrics", async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });
});
