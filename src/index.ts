import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { initializeContainer } from "./di.js";
import { redis } from "./services/redis.js";
import { loadSigningKeys, getPublicJwks } from "./services/tokens.js";

import { loadWorkflows } from "./services/workflows/engine.js";
import { startTracing, stopTracing } from "./plugins/tracing.js";
import authPlugin from "./plugins/auth.js";
import auditPlugin from "./plugins/audit.js";
import requestLogger from "./plugins/requestLogger.js";
import { subscribe, subscribeAll } from "./services/events/bus.js";
import { auditLogSubscriber } from "./services/events/subscribers/auditLog.js";
import { webhookSubscriber } from "./services/events/subscribers/webhook.js";
import { webhookDispatchSubscriber } from "./services/events/subscribers/webhookDispatch.js";
import { startWebhookWorker } from "./services/webhooks.js";
import { anomalySubscriber } from "./services/events/subscribers/anomaly.js";
import { queue } from "./services/queue/index.js";
import { emailProvider } from "./services/email.js";
import { registerPlugin } from "./services/plugins/registry.js";
import type { KeystonePlugin } from "./services/plugins/types.js";
import appContextPlugin from "./plugins/appContext.js";
import permissionsPlugin from "./plugins/permissions.js";
import mtlsPlugin from "./plugins/mtls.js";
import metricsPlugin from "./plugins/metrics.js";
import { globalRateLimit } from "./plugins/rateLimit.js";
import authRoutes from "./routes/auth.js";
import oauthRoutes from "./routes/oauth.js";
import oauth2Routes from "./routes/oauth2.js";
import passwordRoutes from "./routes/password.js";
import apiKeyRoutes from "./routes/apiKeys.js";
import adminRoutes from "./routes/admin.js";
import serviceAccountRoutes from "./routes/serviceAccounts.js";
import magicLinkRoutes from "./routes/magicLinks.js";
import totpRoutes from "./routes/totp.js";
import webauthnRoutes from "./routes/webauthn.js";
import smsOtpRoutes from "./routes/smsOtp.js";
import authzRoutes from "./routes/authz.js";
import samlRoutes from "./routes/saml.js";
import oidcEnterpriseRoutes from "./routes/oidcEnterprise.js";
import scimRoutes from "./routes/scim.js";
import federationRoutes from "./routes/federation.js";
import workflowRoutes from "./routes/workflows.js";
import setupRoutes from "./routes/setup.js";
import sdkRoutes from "./routes/sdk.js";
import configRoutes from "./routes/config.js";
import sessionRoutes from "./routes/sessions.js";
import profileRoutes from "./routes/profile.js";
import emailVerificationRoutes from "./routes/emailVerification.js";
import { generateSetupToken, printSetupToken } from "./services/setup/token.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadPluginsFromEnv(app: FastifyInstance) {
  const pluginPaths = (config.KEYSTONE_PLUGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pluginPath of pluginPaths) {
    try {
      const module = await import(pluginPath);
      const plugin = module.default || module.plugin || module;
      if (plugin && typeof plugin === "object" && "metadata" in plugin) {
        registerPlugin(plugin as KeystonePlugin);
        app.log.info(`Loaded plugin from ${pluginPath}: ${plugin.metadata.name}`);
      } else {
        app.log.warn(`Plugin ${pluginPath} did not export a valid KeystonePlugin`);
      }
    } catch (err) {
      app.log.warn({ err }, `Failed to load plugin ${pluginPath}`);
    }
  }
}

export async function buildApp() {
  const container = initializeContainer();

  const app = fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  app.decorate("container", container);

  await app.register(requestLogger);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Hilbras Keystone API",
        description: "Identity platform API for Hilbras products and third-party apps.",
        version: "1.0.0",
      },
      servers: [{ url: config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}` }],
      tags: [
        { name: "Auth", description: "Authentication and session management" },
        { name: "Admin", description: "Organization and application management" },
        { name: "Discovery", description: "JWKS and health endpoints" },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/documentation",
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (config.ALLOWED_ORIGINS.length === 0) return cb(null, true);
      if (config.ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      // In development, allow any localhost origin so external test projects
      // can connect without pre-registering them in ALLOWED_ORIGINS.
      if (config.NODE_ENV !== "production" && origin?.startsWith("http://localhost:")) {
        return cb(null, true);
      }
      cb(new Error("Origin not allowed"), false);
    },
    credentials: true,
  });

  await app.register(cookie, {
    secret: config.INTERNAL_API_KEY || undefined,
    parseOptions: {},
  });

  await app.register(auditPlugin);

  // Wire up event-bus subscribers.
  subscribeAll(auditLogSubscriber);
  subscribeAll(webhookSubscriber);
  subscribeAll(webhookDispatchSubscriber);
  subscribe("user_login_failed", anomalySubscriber);
  subscribe("new_device_detected", anomalySubscriber);

  // Register background job processors.
  queue.process("email", async (job) => {
    const { message } = job.payload as { message: import("./services/email.js").EmailMessage };
    await emailProvider.send(message);
  });
  startWebhookWorker();
  queue.process("webhook", async (job) => {
    const { url, method, body, headers } = job.payload as {
      url: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    };
    await fetch(url, {
      method: method || "POST",
      headers: { "Content-Type": "application/json", ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  });
  queue.process("workflow_run", async (job) => {
    const { runId, workflowId } = job.payload as { runId: string; workflowId: string };
    const { executeRunById } = await import("./services/workflows/engine.js");
    await executeRunById(runId, workflowId);
  });

  // Expose plugin registration on the Fastify instance.
  app.decorate("registerPlugin", (plugin: KeystonePlugin) => {
    registerPlugin(plugin);
    app.log.info(`Registered plugin: ${plugin.metadata.name}`);
  });

  // Load plugins configured via env (comma-separated list of module paths).
  await loadPluginsFromEnv(app);

  app.addHook("onClose", async () => {
    await queue.close?.();
  });

  // Global API rate limiting to protect the platform from abuse.
  app.addHook("onRequest", globalRateLimit({
    maxRequests: Number(config.GLOBAL_RATE_LIMIT_MAX) || 100,
    windowSeconds: Number(config.GLOBAL_RATE_LIMIT_WINDOW) || 60,
  }));

  await app.register(appContextPlugin);
  await app.register(authPlugin);
  await app.register(permissionsPlugin);
  await app.register(mtlsPlugin);
  await app.register(metricsPlugin);

  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(sessionRoutes, { prefix: "/auth" });
  await app.register(profileRoutes, { prefix: "/auth" });
  await app.register(emailVerificationRoutes, { prefix: "/auth" });
  await app.register(oauthRoutes, { prefix: "/auth" });
  await app.register(oauth2Routes, { prefix: "/oauth2" });
  await app.register(passwordRoutes, { prefix: "/auth" });
  await app.register(apiKeyRoutes, { prefix: "/auth" });
  await app.register(adminRoutes, { prefix: "/v1/admin" });
  await app.register(serviceAccountRoutes, { prefix: "/v1/admin" });
  await app.register(magicLinkRoutes, { prefix: "/auth" });
  await app.register(totpRoutes, { prefix: "/auth" });
  await app.register(webauthnRoutes, { prefix: "/auth" });
  await app.register(smsOtpRoutes, { prefix: "/auth" });
  await app.register(authzRoutes, { prefix: "/v1" });
  await app.register(samlRoutes, { prefix: "/sso" });
  await app.register(oidcEnterpriseRoutes, { prefix: "/sso" });
  await app.register(scimRoutes, { prefix: "/" });
  await app.register(federationRoutes, { prefix: "/federation" });
  await app.register(workflowRoutes, { prefix: "/v1/admin" });
  await app.register(sdkRoutes, { prefix: "/sdk" });
  await app.register(configRoutes, { prefix: "/v1/admin/config" });

  const issuer = config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
  app.get("/.well-known/openid-configuration", { schema: { tags: ["Discovery"] } }, async () => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    userinfo_endpoint: `${issuer}/oauth2/userinfo`,
    revocation_endpoint: `${issuer}/oauth2/revoke`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
  }));

  app.get("/.well-known/jwks.json", { schema: { tags: ["Discovery"] } }, async () => {
    return getPublicJwks();
  });

  app.get("/health", { schema: { tags: ["Discovery"] } }, async () => ({ status: "ok" }));

  await app.register(setupRoutes, { prefix: "/setup" });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error && typeof error === "object" && "validation" in error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: "Invalid input", details: message });
    }

    if (error instanceof Error && "statusCode" in error) {
      const statusCode = (error as Error & { statusCode: number }).statusCode;
      const code = (error as Error & { code?: string }).code;
      if (statusCode >= 400 && statusCode < 600) {
        return reply.status(statusCode).send({ error: error.message, code });
      }
    }

    request.log.error({ err: error }, "Unhandled error");
    const message = config.NODE_ENV === "production" ? "Internal server error" : String(error);
    return reply.status(500).send({ error: message });
  });

  return app;
}

async function start() {
  startTracing();
  await redis.connect().catch((err: unknown) => {
    console.warn("Redis not available; rate limiting will fail open", err);
  });

  const app = await buildApp();

  try {
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "./db/migrations") });
    app.log.info("Database migrations applied");
  } catch (err) {
    app.log.warn({ err }, "Database migration skipped or failed");
  }

  try {
    await loadSigningKeys();
    app.log.info("JWT signing keys loaded");
  } catch (err) {
    app.log.warn({ err }, "JWT signing key loading failed");
  }

  try {
    generateSetupToken();
    printSetupToken();
  } catch (err) {
    app.log.warn({ err }, "Could not generate setup token");
  }

  try {
    await app.container.permissionRepository.ensureRolePermissionsSeeded();
    app.log.info("Role permissions seeded");
  } catch (err) {
    app.log.warn({ err }, "Role permission seeding failed");
  }

  try {
    await loadWorkflows();
    app.log.info("Workflows loaded");
  } catch (err) {
    app.log.warn({ err }, "Workflow loading failed");
  }

  app.addHook("onClose", async () => {
    await stopTracing();
  });

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`Hilbras Keystone running on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  start();
}
