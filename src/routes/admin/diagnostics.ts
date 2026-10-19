import type { FastifyInstance } from "fastify";
import { requirePlatformRole } from "./helpers.js";
import { buildDiagnosticsReport } from "../../services/diagnostics.js";

/**
 * §5.5: one page that answers "what is this instance doing right now".
 *
 * Owner-only, like every other `/platform/*` route, and that is a real boundary
 * rather than a formality: the report names the instance, its worker id, its
 * signing key ids and its configuration warnings. None of it is a secret, and all
 * of it is useful to someone mapping a deployment — which is exactly the kind of
 * information that should require a credential rather than be inferred from a
 * public endpoint.
 *
 * The pieces it reports were already reachable — `/ready` for dependencies,
 * `/platform/queue` and `/platform/keys` for two of the six — but each was a
 * separate request, and readings taken seconds apart are not readings of the same
 * system. Redis going down between two calls produces a queue that looks healthy
 * and a dependency that does not.
 *
 * Every field is composed in `services/diagnostics.ts`; this file maps it to HTTP.
 */
export default async function diagnosticsRoutes(app: FastifyInstance) {
  app.get("/platform/diagnostics", { preHandler: [requirePlatformRole("owner")] }, async () =>
    buildDiagnosticsReport(app.container.queue, app.container.secretsProvider)
  );
}
