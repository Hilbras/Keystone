import path from "node:path";
import { fastifyTrustProxySetting } from "./services/trustedProxies.js";
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

  await app.register(cors, {
    origin: true,
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

async function start() {
  generateSetupToken();
  printSetupToken();

  const app = await buildSetupApp();
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`Hilbras Keystone setup server running on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  start();
}
