import type { FastifyInstance } from "fastify";
import platformRoutes from "./platform.js";
import webhooksRoutes from "./webhooks.js";
import organizationsRoutes from "./organizations.js";
import permissionsRoutes from "./permissions.js";
import ssoRoutes from "./sso.js";
import billingRoutes from "./billing.js";

export default async function adminRoutes(app: FastifyInstance) {
  await app.register(platformRoutes);
  await app.register(webhooksRoutes);
  await app.register(organizationsRoutes);
  await app.register(permissionsRoutes);
  await app.register(ssoRoutes);
  await app.register(billingRoutes);
}
