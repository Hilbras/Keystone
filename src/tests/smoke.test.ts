import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.ZITADEL_DOMAIN = process.env.ZITADEL_DOMAIN || "http://localhost:8080";
process.env.ZITADEL_CLIENT_ID = process.env.ZITADEL_CLIENT_ID || "test-client";
process.env.ZITADEL_CLIENT_SECRET = process.env.ZITADEL_CLIENT_SECRET || "test-secret";

// Generate an ephemeral JWT key pair so JWKS and auth tests don't need the secrets table.
const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
const jwtPair = await generateKeyPair("RS256", { extractable: true });
process.env.JWT_PRIVATE_KEY = await exportPKCS8(jwtPair.privateKey);
process.env.JWT_PUBLIC_KEY = await exportSPKI(jwtPair.publicKey);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbAvailable = false;

before(async () => {
  try {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const { db } = await import("../db/index.js");
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../db/migrations") });
    dbAvailable = true;
  } catch (err) {
    console.warn("Postgres not available; skipping DB-dependent smoke tests:", (err as Error).message);
  }
});

const { buildApp } = await import("../index.js");

// The postgres pool (db/index.ts) and the shared lazy ioredis client
// (services/redis.ts, used by the global rate limiter on every request) are
// process-wide singletons that app.close() does not release. Without this,
// open sockets keep the node:test process alive after all tests finish.
after(async () => {
  const { closeDb } = await import("../db/index.js");
  const { redis } = await import("../services/redis.js");
  await closeDb().catch(() => {});
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("Hilbras Keystone smoke test", () => {
  it("boots and responds to /health", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.status, "ok");
    await app.close();
  });

  it("serves OIDC discovery document", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/.well-known/openid-configuration" });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.response_types_supported[0], "code");
    assert.ok(body.token_endpoint_auth_methods_supported.includes("client_secret_basic"));
    await app.close();
  });

  it("serves JWKS", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.keys));
    await app.close();
  });

  it("serves Prometheus metrics", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes("keystone_http_requests_total"));
    await app.close();
  });

  it("requires authentication for /v1/authz/check", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/authz/check",
      payload: { resource: "application", action: "read" },
    });
    assert.strictEqual(res.statusCode, 401);
    await app.close();
  });

  it("lists federation providers", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/federation/providers" });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.providers));
    assert.ok(body.providers.some((p: { type: string }) => p.type === "google"));
    await app.close();
  });

  it("exposes admin permissions endpoint", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/admin/permissions" });
    assert.strictEqual(res.statusCode, 401);
    await app.close();
  });

  (dbAvailable ? it : it.skip)("registers and logs in a local password user without Zitadel", async () => {
    const app = await buildApp();
    const email = `smoke-${Date.now()}@example.com`;
    const registerRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: `smoke${Date.now()}`, email, password: "SmokeTest123!" },
    });
    assert.strictEqual(registerRes.statusCode, 200);
    const registerBody = JSON.parse(registerRes.body);
    assert.strictEqual(registerBody.user.email, email);

    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "SmokeTest123!" },
    });
    assert.strictEqual(loginRes.statusCode, 200);
    const loginBody = JSON.parse(loginRes.body);
    assert.strictEqual(loginBody.user.email, email);
    await app.close();
  });
});
