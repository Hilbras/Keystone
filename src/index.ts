import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { config } from "./config.js";
import { resolveProfile, securityDefaults } from "./config/profiles.js";
import { loggerOptions } from "./lib/logger.js";
import {
  OPENAPI_SECURITY_SCHEMES,
  OPENAPI_TAGS,
  readPackageVersion,
  tagForRoute,
} from "./lib/openapi.js";
import { defaultErrorCodeForStatus } from "./lib/errorCodes.js";
import { closeDb, db } from "./db/index.js";
import { verifySchema } from "./db/verifySchema.js";
import {
  configValidationInput,
  logConfigurationReport,
  validateConfiguration,
} from "./services/config-validation.js";
import { installShutdownHandlers } from "./services/shutdown.js";
import { runStartupRecovery } from "./services/startup-recovery.js";
import { initializeContainer } from "./di.js";
import { getContainer } from "./container.js";
import { fastifyTrustProxySetting, isOriginAllowed } from "./services/trustedProxies.js";
import { closeRedis, redis } from "./services/redis.js";
import { loadSigningKeys, getPublicJwks } from "./services/tokens.js";

import { loadWorkflows } from "./services/workflows/engine.js";
import { startTracing, stopTracing } from "./plugins/tracing.js";
import authPlugin from "./plugins/auth.js";
import auditPlugin from "./plugins/audit.js";
import requestLogger from "./plugins/requestLogger.js";
import errorContract from "./plugins/errorContract.js";
import requestTrace from "./plugins/requestTrace.js";
import { subscribe, subscribeAll } from "./services/events/bus.js";
import { auditLogSubscriber } from "./services/events/subscribers/auditLog.js";
import { webhookSubscriber } from "./services/events/subscribers/webhook.js";
import { webhookDispatchSubscriber } from "./services/events/subscribers/webhookDispatch.js";
import { startWebhookWorker } from "./services/webhooks.js";
import { anomalySubscriber } from "./services/events/subscribers/anomaly.js";
import { metricsSubscriber } from "./services/events/subscribers/metrics.js";
import { queue } from "./services/queue/index.js";
import { cache } from "./services/cache.js";
import { emailProvider } from "./services/email.js";
import { registerPlugin } from "./services/plugins/registry.js";
import type { KeystonePlugin } from "./services/plugins/types.js";
import appContextPlugin from "./plugins/appContext.js";
import permissionsPlugin from "./plugins/permissions.js";
import mtlsPlugin from "./plugins/mtls.js";
import headerSanitization from "./plugins/headerSanitization.js";
import machinePrincipal from "./plugins/machinePrincipal.js";
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
import healthRoutes from "./routes/health.js";
import sdkRoutes from "./routes/sdk.js";
import configRoutes from "./routes/config.js";
import sessionRoutes from "./routes/sessions.js";
import profileRoutes from "./routes/profile.js";
import emailVerificationRoutes from "./routes/emailVerification.js";
import { generateSetupToken, printSetupToken } from "./services/setup/token.js";
import { markStartupComplete } from "./services/startup.js";

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
    // KEYSTONE_LOG_LEVEL exists for the benchmark, which injects tens of
    // thousands of requests and would spend more time serialising log lines than
    // serving them — a measurement that includes its own logging measures logging.
    // Unset in every other context, so nothing else changes.
    //
    // §5.1. Fastify builds its own pino instance, so the secret scrubbing and the
    // `service` field have to be installed on *this* instance as well as on the
    // service logger — see `loggerOptions`, which both of them are built from.
    logger: loggerOptions(
      config.LOG_LEVEL ?? (config.NODE_ENV === "production" ? "info" : "debug")
    ),
    // Derived from KEYSTONE_TRUSTED_PROXIES; `false` by default so a client
    // cannot spoof its address through x-forwarded-for.
    trustProxy: fastifyTrustProxySetting(),
    genReqId: () => crypto.randomUUID(),
  });

  app.decorate("container", container);

  // First, so every hook and handler registered afterwards runs inside the trace
  // the request was given — including `requestLogger` below, which is why the id
  // reaches the access log line.
  await app.register(requestTrace);
  // Before `requestLogger`, whose onSend hook records the error code in the access
  // line: the contract hook is what supplies a code to handlers that did not set
  // one, and the log line should name the code the client actually received.
  await app.register(errorContract);
  await app.register(requestLogger);
  // Must precede every plugin and route: strips client-identity headers from
  // requests that did not arrive from a configured trusted proxy.
  await app.register(headerSanitization);

  // Before swagger, so the document sees the tags on the routes it records. A
  // route that names its own tags keeps them; everything else is filed by mount
  // point, which makes an untagged operation a build failure rather than a gap.
  app.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.url) return;
    const schema = (routeOptions.schema ?? {}) as { tags?: string[] };
    if (!schema.tags || schema.tags.length === 0) {
      routeOptions.schema = { ...schema, tags: [tagForRoute(routeOptions.url)] };
    }
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Hilbras Keystone API",
        description: "Identity platform API for Hilbras products and third-party apps.",
        // §7.1. Read from package.json rather than typed here: the literal was
        // `3.0.1` while the package was at 3.11.0, and nothing compared them.
        version: readPackageVersion(),
      },
      servers: [{ url: config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}` }],
      tags: OPENAPI_TAGS.map((tag) => ({ ...tag })),
      components: {
        securitySchemes: {
          ...OPENAPI_SECURITY_SCHEMES,
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/documentation",
  });

  // §7.1. The UI's own `/documentation/json` was the only way to fetch the
  // document, which made the contract an artefact of the documentation bundle
  // rather than of the API. This is the path clients and generators expect.
  app.get("/openapi.json", { schema: { hide: true } }, async (_request, reply) => {
    return reply.type("application/json").send(app.swagger());
  });

  // §6.1. The empty-ALLOWED_ORIGINS warning used to live here. It now belongs to
  // the boot validator in `start()`, together with every other production
  // posture check, so there is one place to read rather than one per symptom.
  await app.register(cors, {
    origin: (origin, cb) => {
      // Previously an empty ALLOWED_ORIGINS returned true here, which made an
      // unset variable equivalent to "allow every origin" on a server that sends
      // credentialed cookies. Failing closed is the whole point: an unset variable
      // in production should refuse browsers, not hand them the session.
      if (isOriginAllowed(origin, { allowedOrigins: config.ALLOWED_ORIGINS, nodeEnv: config.NODE_ENV })) {
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
  // Registered unconditionally, like the other bus subscribers. It was the one
  // series that existed and never moved; a counter that is only wired up in some
  // deployments is worse than one that is absent, because it looks present.
  subscribeAll(metricsSubscriber);
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
    // The same outbound policy the admin-supplied webhook path uses (SEC-075).
    //
    // This is the `AUDIT_WEBHOOK_URL` audit export, so the URL comes from
    // operator environment configuration rather than an API caller — which makes
    // it a *much* lower-trust-boundary than `deliverNow`. It is checked anyway,
    // for two reasons: an audit export is a standing, automated, every-event
    // outbound request, so a misconfigured value sends audit records to
    // wherever it names without anyone noticing; and leaving one outbound path
    // unchecked is exactly how the SEC-075 gap survived in the first place.
    //
    // Throws rather than swallowing, so a refused destination is a visible failed
    // job in the queue rather than a silently dropped audit record.
    // `./services/...` — `index.ts` sits at `src/`, not `src/routes/`, so the
    // `../../` form does not resolve from here.
    const { assertSafeWebhookUrl } = await import("./services/outboundPolicy.js");
    await assertSafeWebhookUrl(url);
    await fetch(url, {
      method: method || "POST",
      headers: { "Content-Type": "application/json", ...headers },
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
    // The cache owns its own Redis connection (opened eagerly when REDIS_URL
    // is set); without this it keeps a socket open after shutdown.
    await cache.close().catch(() => {});
  });

  // The startup gate flips here and nowhere else.
  //
  // `onListen` is the one hook Fastify runs at the moment the socket is bound,
  // whatever called `listen()` — `start()` in production, a test fixture that binds
  // its own ephemeral port, a future second entry point. It is registered in
  // `buildApp` rather than in `start()` on purpose: a hook that only exists once
  // `start()` has run is a hook that a test, a worker entry point or a benchmark
  // never gets, and those would then answer 503 from `/health/startup` forever.
  // That is a startup probe that never passes, so Kubernetes restarts the pod on a
  // loop and the application never comes up — the failure mode this whole file
  // exists to remove.
  //
  // It cannot fire before a successful bind: Fastify runs `onListen` after the
  // listen callback reports success, so a refused or occupied port leaves the probe
  // answering 503, which is the correct answer and one an operator can act on. See
  // `services/startup.ts`.
  app.addHook("onListen", async () => {
    markStartupComplete();
  });

  // Global API rate limiting to protect the platform from abuse.
  //
  // The probe endpoints are exempt, and the reason is not that probes are cheap.
  // It is that **the limiter uses Redis**, so a Redis outage puts the probe
  // behind a dependency it is meant to be reporting on. Measured, with both
  // PostgreSQL and Redis unreachable, over a real socket:
  //
  //   Redis healthy   31ms   -> 503
  //   Redis down      8.1s, then 20.3s and 20.4s
  //
  // The handler itself reports its verdict in 2s in every case — that is the
  // per-dependency budget — so the time is spent in the limiter, before the
  // handler runs. Against `k8s/base/deployment.yaml`, whose readinessProbe has
  // `timeoutSeconds: 5`, the kubelet would see a **timeout** rather than the 503,
  // during precisely the outage the probe exists to report.
  //
  // A probe that cannot report the outage is worse than no probe, because it
  // looks like one. The kubelet is not a client and there is nothing to abuse
  // here: two requests per pod per 40 seconds.
  const globalLimiter = globalRateLimit({
    maxRequests: Number(config.GLOBAL_RATE_LIMIT_MAX) || 100,
    windowSeconds: Number(config.GLOBAL_RATE_LIMIT_WINDOW) || 60,
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions?.url ?? request.url.split("?")[0];
    // `/metrics` is here for the same reason as the probes, and the probe run is
    // what found it: with Redis unreachable, a single login produced
    // `keystone_rate_limit_redis_errors_total{key_prefix="global"} 3` — the login,
    // plus the two `/metrics` fetches around it.
    //
    // A scrape endpoint behind a rate limiter fails the way a dashboard failing at
    // 3am fails: the scraper gets 429s and stops, and the metrics are gone exactly
    // when something is wrong and they are the thing that would have said so.
    // Prometheus has no way to back off politely; the scrape is cheap and the
    // caller is infrastructure.
    if (path === "/health" || path === "/health/live" || path === "/health/ready" || path === "/health/startup" || path === "/ready" || path === "/metrics") return;
    return globalLimiter(request, reply);
  });
  // Note the bare `return`. An earlier version of this skipped the probes with
  // `return reply;` and every probe request **hung until its client gave up** —
  // an async `onRequest` hook that resolves to the reply deadlocks the request.
  // Fastify is being passed a value it treats as a continuation. `undefined` is
  // the only thing that means "carry on", and the cost of getting it wrong was a
  // probe that could not answer at all, which is the failure this whole change
  // exists to remove.

  await app.register(appContextPlugin);
  await app.register(authPlugin);
  await app.register(machinePrincipal);
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

  // Liveness and readiness, registered as a unit so they cannot drift apart.
  await app.register(healthRoutes);

  await app.register(setupRoutes, { prefix: "/setup" });

  app.setErrorHandler((error: unknown, request, reply) => {
    const isZodLike = error instanceof ZodError || (
      error &&
      typeof error === "object" &&
      ((error as { name?: unknown }).name === "ZodError" ||
        ("issues" in error && Array.isArray((error as { issues?: unknown }).issues)))
    );
    if (isZodLike) {
      const issues = error instanceof ZodError
        ? error.issues
        : (error as { issues: Array<{ path?: Array<string | number>; message?: string }> }).issues;
      return reply.status(400).send({
        error: "Invalid input",
        code: "VALIDATION_ERROR",
        details: issues.map((issue) => ({ path: issue.path ?? [], message: issue.message ?? "Invalid value" })),
      });
    }

    if (error && typeof error === "object" && "validation" in error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: "Invalid input", code: "VALIDATION_ERROR", details: message });
    }

    if (error instanceof Error && "statusCode" in error) {
      const statusCode = (error as Error & { statusCode: number }).statusCode;
      const code = (error as Error & { code?: string }).code;
      if (statusCode >= 400 && statusCode < 600) {
        return reply.status(statusCode).send({ error: error.message, code: code ?? defaultErrorCodeForStatus(statusCode) });
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
  const profileDefaults = securityDefaults(resolveProfile(config.NODE_ENV));

  // §6.5. A failed migration used to be logged and then ignored: the process went
  // on to `listen()` with a schema the application does not match. In a
  // production-like profile that is a refusal to start — a process serving from an
  // unknown schema answers 500s to every request while telling the orchestrator it
  // is healthy. Development keeps the old behaviour so a half-built local database
  // stays debuggable.
  try {
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "./db/migrations") });
    app.log.info("Database migrations applied");

    // The journal says what it applied; this says what is actually there. They
    // disagree after an interrupted migration, a stale restore, or a `search_path`
    // that resolves elsewhere — and only the second one matters to a request.
    const schemaCheck = await verifySchema();
    if (!schemaCheck.ok) {
      app.log.error(
        { missing: schemaCheck.missing },
        `Schema verification failed: ${schemaCheck.missing.length} table(s) missing after migration`
      );
      if (profileDefaults.strict && !config.ALLOW_DEV_DEFAULTS) {
        app.log.fatal(
          "Refusing to start with an incomplete schema. Run `keystone migrate --verify`, or restore the database."
        );
        process.exit(1);
      }
    } else {
      app.log.info({ tables: schemaCheck.expected.length }, "Schema verified");
    }
  } catch (err) {
    app.log.error({ err }, "Database migration failed — the application may not work correctly");
    if (profileDefaults.strict && !config.ALLOW_DEV_DEFAULTS) {
      app.log.fatal(
        "Refusing to start after a failed migration. Run `keystone migrate --verify`, or restore the database."
      );
      process.exit(1);
    }
  }

  // §6.4. Collect what a previous instance left behind, before this one starts
  // taking work. Placed after the migration because it queries the deliveries
  // table, and before `listen()` so the first queued job cannot race the reclaim.
  try {
    await runStartupRecovery();
  } catch (err) {
    // `runStartupRecovery` is written not to throw; this is the belt for a
    // dependency that surprises it. Recovery is never a reason to refuse to boot.
    app.log.warn({ err }, "Startup recovery could not complete");
  }

  try {
    await loadSigningKeys();
    app.log.info("JWT signing keys loaded");
  } catch (err) {
    app.log.error({ err }, "JWT signing key loading failed — token signing will not work");
  }

  // Adopt a pre-1.9 SCIM_BEARER_TOKEN / SCIM_ORG_ID pair into a per-organization
  // connection so an upgrade does not break an existing identity provider.
  try {
    const { migrateLegacyScimEnv } = await import("./services/scimLegacyMigration.js");
    await migrateLegacyScimEnv(getContainer().scimConnectionRepository);
  } catch (err) {
    app.log.warn({ err }, "Could not adopt a legacy SCIM configuration");
  }

  try {
    generateSetupToken();
    printSetupToken();
  } catch (err) {
    app.log.warn({ err }, "Could not generate setup token (may already exist)");
  }

  try {
    await app.container.permissionRepository.ensureRolePermissionsSeeded();
    app.log.info("Role permissions seeded");
  } catch (err) {
    app.log.error({ err }, "Role permission seeding failed — authorization may not work correctly");
  }

  try {
    await loadWorkflows();
    app.log.info("Workflows loaded");
  } catch (err) {
    app.log.warn({ err }, "Workflow loading failed (workflows feature may be unavailable)");
  }

  app.addHook("onClose", async () => {
    await stopTracing();
  });

  // §6.1. One report, one place to read. The three checks that used to live here —
  // weak TOTP key, missing encryption key, insecure cookie — are now findings in a
  // single report, alongside the conditions that previously had no check at all: an
  // in-process queue in production, an insecure-webhook escape hatch left switched
  // on, debug logging, an empty CORS list, unsigned webhooks, private-network
  // allowlists.
  //
  // A finding at `error` level stops the process unless KEYSTONE_ALLOW_DEV_DEFAULTS
  // is set — the same escape hatch the checks here always honoured.
  const validation = validateConfiguration(configValidationInput());
  logConfigurationReport(validation, app.log);
  if (validation.fatal) {
    app.log.fatal(
      `Refusing to start: ${validation.errors.length} unsafe setting(s) for profile ${validation.profile}. ` +
        "Fix them, or set KEYSTONE_ALLOW_DEV_DEFAULTS=true for a deliberate development deployment."
    );
    process.exit(1);
  }
  if (validation.errors.length > 0) {
    app.log.warn(
      `Continuing with ${validation.errors.length} unsafe setting(s) because KEYSTONE_ALLOW_DEV_DEFAULTS=true`
    );
  }

  // §6.3. From this point on a deploy, `docker stop`, or pod eviction drains
  // instead of severing every in-flight request. Installed before `listen()` so a
  // signal arriving during the bind cannot skip the teardown.
  installShutdownHandlers(
    {
      closeApp: () => app.close(),
      closeDatabase: closeDb,
      closeRedis,
    },
    {
      timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
      log: (message) => app.log.info({}, message),
      error: (message, err) => app.log.error({ err }, message),
    }
  );

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`Hilbras Keystone running on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (config.SETUP_MODE) {
    // The container entrypoint is always `dist/index.js`; setup mode must pick
    // the standalone setup server here or `KEYSTONE_SETUP_MODE=true` silently
    // boots the main application — which needs a database that does not exist
    // yet, which is the entire point of setup mode.
    const { startSetupServer } = await import("./setup-server.js");
    void startSetupServer();
  } else {
    start();
  }
}
