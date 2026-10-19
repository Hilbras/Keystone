import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "diagnostics-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys, getPublicJwks } = await import("../../services/tokens.js");
const { hashPassword } = await import("../../services/secrets/index.js");
const { users } = await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");
const { redis } = await import("../../services/redis.js");

/**
 * §5.5: "Admin diagnostics — database status, Redis status, queue status, worker
 * status, key status, configuration health. Never expose secrets."
 *
 * The endpoint's value and its risk are the same property: it reports on the
 * running system, so it is the most complete description of a deployment that any
 * one request produces. The tests below are therefore about the boundary as much as
 * the content — that it needs an owner, and that what it returns is a description of
 * the system rather than a copy of its configuration.
 *
 * The negative assertions are the load-bearing ones, and they are written against
 * the values actually in this process's environment rather than against a list of
 * field names: a field-by-field check passes as soon as someone adds a field, and
 * adding a field is exactly how a connection string gets into a response body.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Diagnostics-Passw0rd!";

let app: FastifyInstance;
let ownerToken: string;
let userToken: string;
const createdUserIds: string[] = [];

/** The credential-bearing values this process holds, none of which may appear in a response. */
function environmentSecrets(): Array<{ label: string; value: string }> {
  const databasePassword = (() => {
    try {
      return decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").password);
    } catch {
      return "";
    }
  })();
  return [
    { label: "KEYSTONE_ENCRYPTION_KEY", value: process.env.KEYSTONE_ENCRYPTION_KEY ?? "" },
    { label: "KEYSTONE_INTERNAL_API_KEY", value: process.env.KEYSTONE_INTERNAL_API_KEY ?? "" },
    { label: "DATABASE_URL password", value: databasePassword },
    {
      label: "JWT private key",
      value: (process.env.JWT_PRIVATE_KEY ?? "").split("\n")[1]?.trim() ?? "",
    },
    { label: "REDIS_URL credentials", value: new URL(process.env.REDIS_URL ?? "").password ?? "" },
  ].filter((entry) => entry.value.length > 8);
}

async function signIn(email: string, password: string, role: "owner" | "user"): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email,
      username: `diag${RUN_ID}${role === "owner" ? "o" : "u"}`.slice(0, 32),
      name: `diagnostics ${role}`,
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
      isActive: true,
      role,
    })
    .returning();
  createdUserIds.push(user.id);

  const login = await app.inject({
    method: "POST",
    url: "/auth/token-login",
    payload: { email: user.email, password },
  });
  assert.equal(login.statusCode, 200, `login as ${role} failed: ${login.body}`);
  return login.json().accessToken as string;
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
  await redis.ping();

  ownerToken = await signIn(`diag-owner-${RUN_ID}@example.test`, PASSWORD, "owner");
  userToken = await signIn(`diag-user-${RUN_ID}@example.test`, PASSWORD, "user");
});

after(async () => {
  await app?.close();
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

const DIAGNOSTICS = "/v1/admin/platform/diagnostics";

describe("admin diagnostics", () => {
  it("refuses an anonymous caller", async () => {
    const res = await app.inject({ method: "GET", url: DIAGNOSTICS });
    assert.equal(res.statusCode, 401, res.body);
  });

  it("refuses an authenticated non-owner", async () => {
    // Not a formality: the report names the instance, its worker id, its signing
    // key ids and its configuration warnings — the map of a deployment.
    const res = await app.inject({
      method: "GET",
      url: DIAGNOSTICS,
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(res.statusCode, 403, res.body);
  });

  it("reports all six subsystems to an owner", async () => {
    const res = await app.inject({
      method: "GET",
      url: DIAGNOSTICS,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();

    // The list is the requirement. A section that goes missing is a section an
    // operator stops checking.
    for (const section of ["instance", "startup", "dependencies", "queue", "keys", "configuration"]) {
      assert.ok(body[section], `the ${section} section is missing from the report`);
    }
  });

  it("answers the dependency questions with live probes", async () => {
    const res = await app.inject({
      method: "GET",
      url: DIAGNOSTICS,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const { dependencies } = res.json();

    // The same probes `/ready` uses, so the two cannot disagree — and against the
    // live test dependencies the answer here is `ready`, not a hard-coded string.
    assert.equal(dependencies.status, "ready", JSON.stringify(dependencies));
    assert.equal(dependencies.checks.database.ok, true);
    assert.equal(dependencies.checks.redis.ok, true);
    assert.equal(typeof dependencies.checks.database.latencyMs, "number");
  });

  it("names the queue driver it is actually running on", async () => {
    const res = await app.inject({
      method: "GET",
      url: DIAGNOSTICS,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const body = res.json();

    // Compared against the running container rather than against a literal: the
    // point is that the report cannot name a driver the process is not using.
    assert.equal(body.queue.provider, app.container.queue.provider);
    assert.ok(
      ["bullmq", "in-process"].includes(body.queue.provider),
      `unexpected queue provider ${body.queue.provider}`
    );
    assert.equal(body.queue.error, undefined, `queue status failed: ${body.queue.error}`);
    assert.equal(typeof body.queue.backlog.waiting, "number");
    assert.equal(typeof body.queue.backlog.failed, "number");
  });

  it("identifies the worker, so 'which instance' has an answer", async () => {
    const res = await app.inject({
      method: "GET",
      url: DIAGNOSTICS,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const { instance } = res.json();
    assert.equal(instance.pid, process.pid);
    assert.ok(instance.workerId.includes(String(process.pid)), "the worker id should name the pid");
    assert.ok(instance.uptimeSeconds >= 0);
  });

  it("reports key ids from the provider and the ones actually published", async () => {
    const res = await app.inject({
      method: "GET",
      url: DIAGNOSTICS,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const { keys } = res.json();
    assert.equal(keys.error, undefined, `key status failed: ${keys.error}`);
    assert.equal(typeof keys.provider, "string");
    assert.equal(keys.count, keys.active.length);

    // `published` is the set verifiers are handed, and it must be the JWKS this
    // process serves — not a second opinion about it.
    const served = (await getPublicJwks()).keys.map((key) => key.kid);
    assert.ok(served.length >= 1, "a serving instance publishes at least one key");
    assert.deepEqual(
      [...keys.published].sort(),
      [...served].sort(),
      "the report's published keys must be the JWKS this instance serves"
    );

    // The two lists are allowed to differ — `JWT_PRIVATE_KEY` in the environment
    // shadows the database provider entirely — and the point of reporting both is
    // that the difference is *visible*. What must not happen is `published` being
    // empty while `active` is not: that is a deployment whose rotation took effect
    // nowhere, and it is the case this assertion is here to keep distinguishable
    // from a healthy one.
    assert.ok(
      keys.published.length >= 1,
      `no key is published, though the provider lists ${keys.count}: ${JSON.stringify(keys)}`
    );
  });

  it("reports no key material, whatever the shape of the report is", async () => {
    // The assertion that survives the next field being added: it is made against
    // the response as a string, so it does not depend on knowing what the fields
    // are called.
    const res = await app.inject({
      method: "GET",
      url: DIAGNOSTICS,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const raw = res.body;

    for (const secret of environmentSecrets()) {
      assert.ok(
        !raw.includes(secret.value),
        `${secret.label} appears in the diagnostics report:\n${raw}`
      );
    }
    // And the PEM markers, in case the value is present in a form the check above
    // did not anticipate.
    assert.ok(!raw.includes("PRIVATE KEY"), `key material reached the report:\n${raw}`);
  });

  it("does not echo the configuration it summarises", async () => {
    // A response that mentioned the encryption key's *name* but not its value would
    // still pass the test above, and would still be a page that cannot be shared.
    // This one asserts the report describes the environment instead of quoting it.
    const res = await app.inject({
      method: "GET",
      url: DIAGNOSTICS,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const raw = res.body;

    assert.ok(!raw.includes("postgresql://"), "a connection string reached the report");
    assert.ok(!raw.includes("redis://"), "a connection string reached the report");
    assert.equal(typeof res.json().configuration.environment, "string");
    assert.ok(Array.isArray(res.json().configuration.warnings));
  });

  it("raises no production warnings in a test environment", async () => {
    const res = await app.inject({
      method: "GET",
      url: DIAGNOSTICS,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const { configuration } = res.json();
    assert.equal(configuration.environment, "test");
    assert.deepEqual(
      configuration.warnings,
      [],
      "configuration warnings are about production, so a test environment should have none"
    );
  });
});
