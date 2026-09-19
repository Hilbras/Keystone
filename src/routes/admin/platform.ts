import type { FastifyInstance } from "fastify";
import { eq, and, sql, desc, gte, count, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users, organizations, applications, auditLog, refreshTokens } from "../../db/schema.js";
import { requireOwner, sendResultError } from "./helpers.js";
import { getSdk } from "../../sdk/index.js";
import { listRegisteredPlugins, listExtensionPoints, unregisterPlugin } from "../../services/plugins/registry.js";
import { isFeatureEnabled, listFeatureFlags, setFeatureFlag, deleteFeatureFlag } from "../../services/featureFlags.js";
import { listConfigurationProfiles, getConfigurationProfile } from "../../services/configuration/profiles.js";
import { z } from "zod";

const UpdateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  username: z.string().min(3).max(32).optional(),
  role: z.string().optional(),
  emailVerified: z.boolean().optional(),
});

const FeatureFlagSchema = z.object({
  enabled: z.boolean(),
  description: z.string().max(500).optional(),
});

export default async function platformRoutes(app: FastifyInstance) {
  const sdk = getSdk();

  // Platform-level owner-only endpoints.
  app.get("/platform/users", { preHandler: [requireOwner()] }, async () => {
    const allUsers = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        name: users.name,
        role: users.role,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(users.createdAt);
    return { users: allUsers };
  });

  app.get("/platform/organizations", { preHandler: [requireOwner()] }, async () => {
    const allOrganizations = await db.select().from(organizations).orderBy(organizations.createdAt);
    return { organizations: allOrganizations };
  });

  app.get("/platform/applications", { preHandler: [requireOwner()] }, async () => {
    const allApplications = await db
      .select({
        id: applications.id,
        orgId: applications.orgId,
        clientId: applications.clientId,
        name: applications.name,
        redirectUris: applications.redirectUris,
        allowedOrigins: applications.allowedOrigins,
        allowedIps: applications.allowedIps,
        blockedIps: applications.blockedIps,
        branding: applications.branding,
        isActive: applications.isActive,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
      })
      .from(applications)
      .orderBy(applications.createdAt);
    return { applications: allApplications };
  });

  app.get("/platform/audit-logs", { preHandler: [requireOwner()] }, async (request) => {
    const query = request.query as { limit?: string; offset?: string; event?: string };
    const logs = await app.container.auditRepository.list({
      event: query.event,
      limit: query.limit ? Number(query.limit) : 100,
      offset: query.offset ? Number(query.offset) : 0,
    });
    return { logs };
  });

  app.get("/platform/audit-logs/export", { preHandler: [requireOwner()] }, async (request, reply) => {
    const query = request.query as { event?: string; format?: string; limit?: string; orgId?: string; userId?: string };
    const logs = await app.container.auditRepository.list({
      event: query.event,
      orgId: query.orgId,
      userId: query.userId,
      limit: Math.min(Number(query.limit) || 1000, 10000),
      offset: 0,
    });

    if (query.format === "json") {
      reply.header("content-disposition", `attachment; filename="keystone-audit-${Date.now()}.json"`);
      return { logs };
    }

    const escapeCsv = (value: unknown): string => {
      const s = value == null ? "" : String(value);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = "id,event,user_id,org_id,app_id,request_id,ip_address,user_agent,created_at,metadata";
    const rows = logs.map((l) =>
      [
        l.id,
        l.event,
        l.userId,
        l.orgId,
        l.appId,
        l.requestId,
        l.ipAddress,
        l.userAgent,
        l.createdAt instanceof Date ? l.createdAt.toISOString() : l.createdAt,
        JSON.stringify(l.metadata ?? {}),
      ]
        .map(escapeCsv)
        .join(",")
    );
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="keystone-audit-${Date.now()}.csv"`);
    return reply.send([header, ...rows].join("\n"));
  });

  app.get("/platform/metrics/usage", { preHandler: [requireOwner()] }, async (request) => {
    const query = request.query as { days?: string };
    const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const dateSql = sql<string>`date(${auditLog.createdAt})`;
    const rows = await db
      .select({
        date: dateSql,
        logins: sql<number>`count(*) filter (where ${auditLog.event} = 'user_login')`.mapWith(Number),
        failedLogins: sql<number>`count(*) filter (where ${auditLog.event} = 'user_login_failed')`.mapWith(Number),
        signups: sql<number>`count(*) filter (where ${auditLog.event} = 'user_registered')`.mapWith(Number),
        dau: sql<number>`count(distinct ${auditLog.userId}) filter (where ${auditLog.event} = 'user_login')`.mapWith(Number),
      })
      .from(auditLog)
      .where(gte(auditLog.createdAt, since))
      .groupBy(dateSql)
      .orderBy(dateSql);

    return { days, series: rows };
  });

  app.get("/platform/security-summary", { preHandler: [requireOwner()] }, async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [loginEvents] = await db
      .select({ total: count() })
      .from(auditLog)
      .where(and(eq(auditLog.event, "user_login"), gte(auditLog.createdAt, since)));
    const [failedLoginEvents] = await db
      .select({ total: count() })
      .from(auditLog)
      .where(and(eq(auditLog.event, "user_login_failed"), gte(auditLog.createdAt, since)));
    const [activeSessions] = await db
      .select({ total: count() })
      .from(refreshTokens)
      .where(and(isNull(refreshTokens.revokedAt), gte(refreshTokens.expiresAt, new Date())));
    const [mfaUsers, totalUsers] = await Promise.all([
      db.select({ total: count() }).from(users).where(eq(users.totpEnabled, true)),
      db.select({ total: count() }).from(users),
    ]);
    const recentLogins = await db
      .select({
        id: auditLog.id,
        event: auditLog.event,
        userId: auditLog.userId,
        ipAddress: auditLog.ipAddress,
        userAgent: auditLog.userAgent,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(eq(auditLog.event, "user_login"))
      .orderBy(desc(auditLog.createdAt))
      .limit(10);

    const [newDeviceEvents] = await db
      .select({ total: count() })
      .from(auditLog)
      .where(and(eq(auditLog.event, "new_device_detected"), gte(auditLog.createdAt, since)));
    const recentFailedLogins = await db
      .select({
        id: auditLog.id,
        event: auditLog.event,
        userId: auditLog.userId,
        ipAddress: auditLog.ipAddress,
        userAgent: auditLog.userAgent,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(and(eq(auditLog.event, "user_login_failed"), gte(auditLog.createdAt, since)))
      .orderBy(desc(auditLog.createdAt))
      .limit(10);

    return {
      last24h: {
        logins: loginEvents.total,
        failedLogins: failedLoginEvents.total,
      },
      activeSessions: activeSessions.total,
      mfa: {
        enabled: mfaUsers[0].total,
        total: totalUsers[0].total,
      },
      anomalies: {
        newDevices24h: newDeviceEvents.total,
        recentFailedLogins,
      },
      recentLogins,
    };
  });

  app.get("/platform/queue", { preHandler: [requireOwner()] }, async () => {
    const stats = app.container.queue.getStats ? await app.container.queue.getStats() : [];
    return { stats };
  });

  app.get("/platform/queue/failed", { preHandler: [requireOwner()] }, async (request) => {
    const query = request.query as { limit?: string };
    const queue = app.container.queue;
    const failed = queue.getFailed ? await queue.getFailed(Number(query.limit) || 50) : [];
    return { failed };
  });

  app.post("/platform/queue/failed/:id/retry", { preHandler: [requireOwner()] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const queue = app.container.queue;
    if (!queue.retry) {
      return reply.status(501).send({ error: "Retry is not supported by the current queue provider" });
    }
    await queue.retry(id);
    return { success: true };
  });

  app.post("/platform/queue/retry-all", { preHandler: [requireOwner()] }, async () => {
    const queue = app.container.queue;
    if (queue.retryAll) await queue.retryAll();
    return { success: true };
  });

  app.get("/platform/keys", { preHandler: [requireOwner()] }, async () => {
    const keys = await app.container.secretsProvider.listActiveSigningKeys();
    return { keys, provider: app.container.secretsProvider.name };
  });

  app.post("/platform/keys/rotate", { preHandler: [requireOwner()] }, async (request, reply) => {
    const active = await app.container.secretsProvider.rotateSigningKeys();
    await request.audit("platform_signing_key_rotated", { keyId: active.keyId });
    return reply.status(201).send({ keyId: active.keyId, provider: app.container.secretsProvider.name });
  });

  app.get("/platform/plugins", { preHandler: [requireOwner()] }, async () => {
    return { plugins: listRegisteredPlugins() };
  });

  app.get("/platform/plugins/extensions", { preHandler: [requireOwner()] }, async () => {
    return { extensionPoints: listExtensionPoints() };
  });

  app.delete("/platform/plugins/:name", { preHandler: [requireOwner()] }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const removed = unregisterPlugin(name);
    if (!removed) return reply.status(404).send({ error: "Plugin not found" });
    await request.audit("platform_plugin_unregistered", { pluginName: name });
    return { success: true };
  });

  app.get("/platform/feature-flags", { preHandler: [requireOwner()] }, async () => {
    return { flags: await listFeatureFlags() };
  });

  app.get("/platform/feature-flags/:key", { preHandler: [requireOwner()] }, async (request) => {
    const { key } = request.params as { key: string };
    const enabled = await isFeatureEnabled(key);
    return { key, enabled };
  });

  app.put(
    "/platform/feature-flags/:key",
    { preHandler: [requireOwner()] },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      const body = FeatureFlagSchema.parse(request.body);
      const result = await setFeatureFlag(key, body.enabled, body.description);
      await request.audit("platform_feature_flag_updated", { key, enabled: result.enabled });
      return reply.status(result.enabled === body.enabled ? 200 : 201).send(result);
    }
  );

  app.delete("/platform/feature-flags/:key", { preHandler: [requireOwner()] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const removed = await deleteFeatureFlag(key);
    if (!removed) return reply.status(404).send({ error: "Feature flag not found" });
    await request.audit("platform_feature_flag_deleted", { key });
    return { success: true };
  });

  app.get("/platform/configuration-profiles", { preHandler: [requireOwner()] }, async () => {
    return { profiles: listConfigurationProfiles() };
  });

  app.get("/platform/configuration-profiles/:id", { preHandler: [requireOwner()] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = getConfigurationProfile(id);
    if (!profile) return reply.status(404).send({ error: "Profile not found" });
    return { profile };
  });

  app.patch(
    "/platform/users/:id",
    { preHandler: [requireOwner()] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = UpdateUserSchema.parse(request.body);
      const result = await sdk.identity.updateUserProfile(id, body);
      if (!result.success) return sendResultError(reply, result);
      await request.audit("platform_user_updated", { userId: id, updates: body });
      return result.data;
    }
  );

  app.delete(
    "/platform/users/:id",
    { preHandler: [requireOwner()] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (request.user!.id === id) {
        return reply.status(400).send({ error: "Cannot deactivate yourself" });
      }
      const result = await sdk.identity.deactivate(id);
      if (!result.success) return sendResultError(reply, result);
      await request.audit("platform_user_deactivated", { userId: id });
      return { success: true };
    }
  );
}
