import path from "node:path";
import { fastifyTrustProxySetting, isOriginAllowed } from "./services/trustedProxies.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { generateSetupToken, printSetupToken } from "./services/setup/token.js";
import setupRoutes from "./routes/setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function buildSetupApp() {
  const app = fastify({
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
    trustProxy: fastifyTrustProxySetting(),
    genReqId: () => crypto.randomUUID(),
  });

  // The setup server creates the owner account and writes configuration. It
  // previously reflected any origin with credentials, so any page a browser
  // visited could attempt a credentialed request against it. Origins must now be
  // listed explicitly.
  //
  // Empty means no browser origin at all, which is the right default: setup is
  // normally driven from the same machine, and a server-to-server client sends
  // no Origin header.
  const setupOrigins = (config.ALLOWED_ORIGINS.length > 0
    ? config.ALLOWED_ORIGINS
    : [`http://localhost:${config.PORT}`, `http://127.0.0.1:${config.PORT}`]
  ).filter((origin) => /^https?:\/\//.test(origin));

  await app.register(cors, {
    origin: (origin, cb) => {
      if (isOriginAllowed(origin, { allowedOrigins: config.ALLOWED_ORIGINS, nodeEnv: config.NODE_ENV, additionallyAllowed: setupOrigins })) {
        return cb(null, true);
      }
      cb(new Error("Origin not allowed"), false);
    },
    credentials: true,
  });

  await app.register(setupRoutes, { prefix: "/setup" });

  // Serve the built setup frontend if available.
  const frontendDist = path.resolve(__dirname, "../frontend/dist");
  try {
    const stat = await fs.stat(frontendDist);
    if (stat.isDirectory()) {
      app.register(import("@fastify/static"), {
        root: frontendDist,
        wildcard: true,
      });
    }
  } catch {
    // Built frontend not present; the Vite dev server should be used instead.
  }

  app.get("/health", async () => ({ status: "setup" }));

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error && typeof error === "object" && "validation" in error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: "Invalid input", details: message });
    }
    request.log.error({ err: error }, "Unhandled error");
    const message = config.NODE_ENV === "production" ? "Internal server error" : String(error);
    return reply.status(500).send({ error: message });
  });

  return app;
}

/**
 * Interface the setup server binds to.
 *
 * The main server defaults to `0.0.0.0`, which is right for it and wrong for
 * this one: the setup surface creates the owner account and writes
 * configuration, and a full-initialisation credential should not be reachable
 * from the internet because someone copied a default from the main server.
 *
 * Defaults to loopback. Set `KEYSTONE_SETUP_HOST` to a private interface
 * address to serve a trusted network, or to `0.0.0.0` deliberately — which logs
 * a warning, because that is the decision this default exists to make explicit.
 */
function setupBindHost(): string {
  const explicit = process.env.KEYSTONE_SETUP_HOST?.trim();
  if (explicit) return explicit;
  if (config.HOST === "0.0.0.0" || config.HOST === "::") return "127.0.0.1";
  return config.HOST;
}

async function start() {
  generateSetupToken();
  printSetupToken();

  const app = await buildSetupApp();
  const host = setupBindHost();
  if (host === "0.0.0.0" || host === "::") {
    app.log.warn(
      "Setup server is binding to all interfaces. It creates the owner account and writes " +
        "configuration; bind it to loopback or a private interface unless this is intended."
    );
  } else {
    app.log.info(`Setup server bound to ${host}`);
  }
  try {
    await app.listen({ port: config.PORT, host });
    app.log.info(`Hilbras Keystone setup server running on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  start();
}
