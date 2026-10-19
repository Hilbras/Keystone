import type { FastifyInstance, FastifyReply } from "fastify";
import { buildReadinessReport, type ReadinessReport } from "../services/health.js";
import { buildStartupReport } from "../services/startup.js";

/**
 * The three probes, kept apart on purpose.
 *
 * They answer different questions, and conflating them is how a transient database
 * outage turns into a restart loop:
 *
 * - **`/health` (and its alias `/health/live`) is liveness.** "Is this process
 *   working at all?" It touches nothing external, so a database blip does not
 *   answer no and Kubernetes does not kill a pod that is fine.
 * - **`/ready` (and its alias `/health/ready`) is readiness.** "Can this process
 *   serve a request right now?" A load balancer asks this before sending traffic,
 *   so a `200` here while PostgreSQL is unreachable moves the problem rather than
 *   solving it: the pod is in the rotation, and every authenticated request it
 *   receives fails.
 * - **`/health/startup` is the startup gate.** "Has boot finished?" While it
 *   answers 503 the kubelet does not run the other two, so a slow boot is not
 *   mistaken for a hung process. See `services/startup.ts` for why the flag flips
 *   on the bind and not on composition.
 *
 * **The k8s manifest pointed its readiness probe at `/health`.** It did that
 * because `/ready` did not exist — `README.md` documents it as a probe endpoint
 * and the route was never written. So the deployed system advertised a readiness
 * probe and had none.
 *
 * The `/health/*` spellings are the convention every Kubernetes example in the
 * wild uses, and a deployment that guessed them against this server got a 404 for
 * its startup probe — which the kubelet reads as "still starting" and never
 * recovers from, because it never runs the liveness probe that would have
 * restarted the pod. Both spellings therefore exist and both are tested: the
 * short ones are the ones already deployed against, and removing them would
 * silently un-probe every existing installation.
 *
 * The route holds no queries; `services/health.ts` does the checking, and the
 * mapping to an HTTP status lives here where it belongs.
 */

export type { ReadinessReport };

export default async function healthRoutes(app: FastifyInstance) {
  const liveness = async () => ({ status: "ok" });

  const readiness = async (_request: unknown, reply: FastifyReply) => {
    const report = await buildReadinessReport();
    // 503 for `unavailable`, 200 for both `ready` and `degraded`.
    //
    // `degraded` deliberately answers 200. Removing a pod from the rotation
    // because Redis is down would take authentication offline entirely, when the
    // pod can still serve every request that matters; the signal belongs in metrics
    // and alerting, and `checks.redis.ok === false` is right there in the body for
    // anything polling it.
    return reply.status(report.status === "unavailable" ? 503 : 200).send(report);
  };

  const startup = async (_request: unknown, reply: FastifyReply) => {
    const report = buildStartupReport();
    return reply.status(report.status === "started" ? 200 : 503).send(report);
  };

  app.get("/health", { schema: { tags: ["Discovery"] } }, liveness);
  app.get("/health/live", { schema: { tags: ["Discovery"] } }, liveness);
  app.get("/ready", { schema: { tags: ["Discovery"] } }, readiness);
  app.get("/health/ready", { schema: { tags: ["Discovery"] } }, readiness);
  app.get("/health/startup", { schema: { tags: ["Discovery"] } }, startup);
}
