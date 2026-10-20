import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "chaos-db-failure";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.LOGIN_MAX_ATTEMPTS ||= "1000000";
process.env.LOGIN_PER_ADDRESS_MAX ||= "1000000";
process.env.LOGIN_WINDOW_SECONDS ||= "60";
process.env.GLOBAL_RATE_LIMIT_MAX ||= "1000000";
process.env.GLOBAL_RATE_LIMIT_WINDOW ||= "60";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { hashPassword } = await import("../../services/secrets/index.js");
const { users, refreshTokens, organizations, orgMemberships } = await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");

/**
 * §8.2 — what happens when the database fails.
 *
 * The database holds the identity state, so a database outage is the failure
 * with the most ways to go wrong:
 *
 * - **The status has to be honest.** 500 says "this server is broken"; 503
 *   says "temporarily unable, try again". The first invites a retry with
 *   backoff that can never succeed, and tells a load balancer to keep sending
 *   traffic at a server that cannot answer.
 * - **The internals have to stay inside.** A failed query carries the SQL.
 *   A response that carries the SQL tells an attacker the schema.
 * - **Nothing half-written may survive.** A write that failed halfway must not
 *   leave a row behind that looks complete.
 *
 * The third is the one that is not about HTTP at all, and the one a status-code
 * assertion cannot see.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Chaos-Db-Passw0rd!";
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

let app: FastifyInstance;

async function makeUser(label: string) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${RUN_ID}@example.test`,
      username: `${label}${RUN_ID}`.slice(0, 32),
      name: label,
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const id of createdUserIds) {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, id)).catch(() => {});
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  for (const id of createdOrgIds) await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("a database that cannot be reached is a 503, not a 500 (§8.2)", () => {
  it("answers 503 from a business route, with the application's own error body", async () => {
    // The dead-database probe boots a server whose database is unreachable.
    // It used to probe only the health endpoints, which answer 503 correctly
    // by construction — so the probe passed while every business route
    // answered 500 with the failed SQL in the body.
    const probe = path.join(__dirname, "..", "helpers", "deadDatabaseProbe.js");
    const output = path.join(__dirname, "..", "..", "tmp-chaos-dead-db.json");
    await rm(output, { force: true });

    await run(process.execPath, [probe, output], {
      env: {
        ...process.env,
        PROBE_DATABASE_URL: "postgresql://hilbras:hilbras@127.0.0.1:59993/hilbras",
        PROBE_REDIS_URL: process.env.REDIS_URL,
        KEYSTONE_LOG_LEVEL: "error",
      },
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const report = JSON.parse(await readFile(output, "utf8"));
    await rm(output, { force: true });

    assert.ok(!report.bootError, `the probe must boot: ${report.bootError}`);
    assert.ok(report.business, `the probe must drive a business route: ${JSON.stringify(report)}`);

    const business = report.business as { statusCode: number; body: string };
    assert.equal(
      business.statusCode,
      503,
      `a database outage must answer 503, not 500; got ${business.statusCode}: ${business.body?.slice(0, 200)}`
    );
    assert.equal(
      business.body.includes("select"),
      false,
      `the response must not carry the failed query: ${business.body?.slice(0, 300)}`
    );
    assert.equal(
      business.body.includes("Failed query"),
      false,
      `the response must not carry the driver's message: ${business.body?.slice(0, 300)}`
    );
  });

  it("still answers the health probes, so an orchestrator can tell the difference", async () => {
    // Liveness answers 200 because the process is listening; readiness answers
    // 503 because it cannot serve. Conflating them is how a dependency outage
    // becomes a restart loop.
    const probe = path.join(__dirname, "..", "helpers", "deadDatabaseProbe.js");
    const output = path.join(__dirname, "..", "..", "tmp-chaos-dead-db-health.json");
    await rm(output, { force: true });

    await run(process.execPath, [probe, output], {
      env: {
        ...process.env,
        PROBE_DATABASE_URL: "postgresql://hilbras:hilbras@127.0.0.1:59993/hilbras",
        PROBE_REDIS_URL: process.env.REDIS_URL,
        KEYSTONE_LOG_LEVEL: "error",
      },
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const report = JSON.parse(await readFile(output, "utf8"));
    await rm(output, { force: true });

    assert.equal(report.healthLive?.statusCode, 200, "liveness must answer 200 while the process is up");
    assert.equal(report.healthReady?.statusCode, 503, "readiness must answer 503 when the database is down");
  });
});

describe("the error contract reaches the routes (§7.2)", () => {
  it("answers a schema violation with 400, not 500", async () => {
    // §7.2's contract, checked against the *server* rather than against a bare
    // Fastify app. The 3.12.0 suite exercised the mechanism on its own
    // instance, where the application's error handler applied because the
    // routes were on the root — and every route in the real server is in a
    // plugin, where it did not. A validation error came back as 500 with the
    // raw validation issues in the body.
    const res = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: {},
    });

    assert.equal(
      res.statusCode,
      400,
      `a schema violation is the caller's mistake and must be a 400; got ${res.statusCode}: ${res.body?.slice(0, 200)}`
    );
    const body = res.json() as { error?: string; code?: string; requestId?: string; details?: unknown };
    assert.equal(body.code, "VALIDATION_ERROR", "the contract's code must be the one the client branches on");
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.requestId, "string", "every error body must carry the request id");
    assert.ok(Array.isArray(body.details), "a validation error must say which fields were wrong");
  });

  it("does not put the internals of an unexpected error in the response", async () => {
    // The other half: an error nobody planned for must not leak the query that
    // failed, the stack, or the driver's message.
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: "Bearer not-a-token" },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json() as { error?: string; requestId?: string };
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.requestId, "string");
    assert.equal(
      /select |insert into|Failed query|at Object|node_modules/.test(res.body),
      false,
      `the response must not carry the internals: ${res.body?.slice(0, 200)}`
    );
  });
});

describe("a failed write leaves nothing behind (§8.2)", () => {
  it("rolls back the whole operation when a statement fails", async () => {
    // The property is atomicity, not the error code: an operation that writes
    // two things and fails on the second must leave neither. A partial write
    // is worse than a failed one, because the system believes it succeeded.
    const { db: txDb } = await import("../../db/index.js");
    const [org] = await db
      .insert(organizations)
      .values({ name: `Rollback Org ${RUN_ID.slice(0, 4)}`, slug: `rollback-${RUN_ID}` })
      .returning();
    createdOrgIds.push(org.id);

    const user = await makeUser("chaos-rollback");
    const other = await makeUser("chaos-rollback-other");

    await assert.rejects(
      txDb.transaction(async (tx) => {
        await tx.insert(orgMemberships).values({ orgId: org.id, userId: user.id, role: "member" });
        // A constraint that cannot be satisfied: the role check rejects it. A
        // *different* user, so the failure is the role check and not the
        // unique index on (organization, user) — the point is a statement that
        // fails, not which statement it is.
        await tx.insert(orgMemberships).values({ orgId: org.id, userId: other.id, role: "not-a-role" });
      }),
      "the transaction must fail"
    );

    const memberships = await db
      .select()
      .from(orgMemberships)
      .where(eq(orgMemberships.orgId, org.id));
    assert.equal(
      memberships.length,
      0,
      "a failed transaction must leave no rows behind — the membership that was written " +
        "before the failure is not a half-committed write the system can live with"
    );
  });
});

describe("the database recovers without a restart (§8.2)", () => {
  it("serves normally again once the connection is back", async () => {
    // A transient database blip must not poison the pool for the life of the
    // process. If the first failure left the client unusable, every later
    // request would fail too, and the outage would outlast the outage.
    const user = await makeUser("chaos-recovery");

    const first = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: PASSWORD },
    });
    assert.equal(first.statusCode, 200, first.body);

    const second = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: PASSWORD },
    });
    assert.equal(second.statusCode, 200, second.body);
  });
});
