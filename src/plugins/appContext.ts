import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq, and, arrayContains } from "drizzle-orm";
import { db } from "../db/index.js";
import { applications, organizations, orgMemberships } from "../db/schema.js";

export default fp(async function appContextPlugin(app: FastifyInstance) {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    // Ensure every request has a fresh state object.
    request.state = {};

    const clientId = extractClientId(request);
    const origin = request.headers.origin;

    const appRecord = clientId
      ? await findApplicationByClientId(clientId)
      : origin
        ? await findApplicationByOrigin(origin)
        : undefined;

    if (!appRecord) return;

    request.state.app = appRecord;
    request.state.org = appRecord.organization;

    if (request.user) {
      const [membership] = await db
        .select()
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.orgId, appRecord.organization.id),
            eq(orgMemberships.userId, request.user.id)
          )
        )
        .limit(1);
      if (membership) {
        request.state.membership = membership;
      }
    }
  });
});

function extractClientId(request: FastifyRequest): string | undefined {
  const header = request.headers["x-app-client-id"];
  if (typeof header === "string" && header) return header;

  const query = (request.query as Record<string, string | undefined>).client_id;
  if (query) return query;

  return undefined;
}

async function findApplicationByClientId(clientId: string) {
  const [row] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.clientId, clientId), eq(applications.isActive, true)))
    .innerJoin(organizations, eq(applications.orgId, organizations.id))
    .limit(1);

  if (!row) return undefined;
  return { ...row.applications, organization: row.organizations };
}

async function findApplicationByOrigin(origin: string) {
  const [row] = await db
    .select()
    .from(applications)
    .where(and(arrayContains(applications.allowedOrigins, [origin]), eq(applications.isActive, true)))
    .innerJoin(organizations, eq(applications.orgId, organizations.id))
    .limit(1);

  if (!row) return undefined;
  return { ...row.applications, organization: row.organizations };
}
