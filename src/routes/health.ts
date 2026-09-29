import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildReadinessReport, type ReadinessReport } from "../services/health.js";

/**
 * Liveness and readiness, kept apart on purpose.
 *
 * They answer different questions, and conflating them is how a transient database
 * outage turns into a restart loop:
 *
 * - **`/health` is liveness.** "Is this process working at all?" It touches
 *   nothing external, so a database blip does not answer no and Kubernetes does
 *   not kill a pod that is fine.
 * - **`/ready` is readiness.** "Can this process serve a request right now?" A
 *   load balancer asks this before sending traffic, so a `200` here while
 *   PostgreSQL is unreachable moves the problem rather than solving it: the pod is
 *   in the rotation, and every authenticated request it receives fails.
 *
 * **The k8s manifest pointed its readiness probe at `/health`.** It did that
 * because `/ready` did not exist — `README.md` documents it as a probe endpoint
 * and the route was never written. So the deployed system advertised a readiness
 * probe and had none.
 *
 * The route holds no queries; `services/health.ts` does the checking, and the
 * mapping to an HTTP status lives here where it belongs.
 */

export type { ReadinessReport };

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", { schema: { tags: ["Discovery"] } }, async () => ({ status: "ok" }));

  app.get("/ready", { schema: { tags: ["Discovery"] } }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const report = await buildReadinessReport();
    // 503 for `unavailable`, 200 for both `ready` and `degraded`.
    //
    // `degraded` deliberately answers 200. Removing a pod from the rotation
    // because Redis is down would take authentication offline entirely, when the
    // pod can still serve every request that matters; the signal belongs in metrics
    // and alerting, and `checks.redis.ok === false` is right there in the body for
    // anything polling it.
    return reply.status(report.status === "unavailable" ? 503 : 200).send(report);
  });
}
