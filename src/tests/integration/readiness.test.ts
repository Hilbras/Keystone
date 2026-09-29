import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

const run = promisify(execFile);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "health-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { hashPassword } = await import("../../services/secrets/index.js");
const { users } = await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");
const { redis } = await import("../../services/redis.js");

/**
 * Liveness and readiness.
 *
 * §5.2: "`/health` and `/ready` exist." **They did not.** Only `/health` existed,
 * `README.md` documented `/ready` as a probe endpoint, and
 * `k8s/base/deployment.yaml` pointed its `readinessProbe` at `/health` — which
 * returns `{status: "ok"}` unconditionally. So the deployed system advertised a
 * readiness probe and had none: with PostgreSQL unreachable the pod stayed in the
 * load balancer's rotation and every authenticated request it received failed.
 *
 * The two are separate here on purpose, and the gate is the separation:
 *
 * - `/ready` must fail with the database unreachable. That is the assertion the
 *   old routing could not make, because `/health` cannot fail.
 * - `/health` must still succeed with the database unreachable. A liveness probe
 *   that depends on PostgreSQL turns a transient database blip into a restart
 *   loop, which is a worse outage than the one it was reacting to.
 *
 * **The dependency outage is produced in a separate process.** Three attempts at
 * doing it in-process are recorded in `tests/helpers/deadDatabaseProbe.ts`, and
 * the one that matters is that a cache-busting query string on the entry module
 * does not reach its dependencies: `import("./index.js?dead=1")` re-evaluates
 * `index.ts`, whose `import { db } from "../db/index.js"` resolves to the
 * *cached* module, so the "broken" server got the healthy pool and reported 200.
 * Taking the real pool down instead would leave this suite unable to clean up
 * after itself.
 *
 * The probe also goes over a **real socket** rather than `app.inject`, for the
 * same class of reason: `inject` resolves at a different moment from a TCP client
 * seeing the bytes, and the two diverge sharply when the event loop is busy with
 * reconnect attempts — which is the exact situation the probe exists for.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Health-Passw0rd!";
const PROBE = path.resolve(__dirname, "../helpers/deadDatabaseProbe.js");
const createdUserIds: string[] = [];
let scratch: string;

let app: FastifyInstance;

interface ProbeReport {
  databaseUrl?: string;
  redisUrl?: string;
  transport?: string;
  port?: number;
  bootError?: string;
  health?: { statusCode: number; body: string; elapsedMs: number };
  ready?: { statusCode: number; body: string; elapsedMs: number };
  secondReady?: { statusCode: number; body: string; elapsedMs: number };
  thirdReady?: { statusCode: number; body: string; elapsedMs: number };
}

let probeCounter = 0;

/**
 * Boot a server against an unreachable database (and optionally Redis) and
 * report what both probes answered.
 */
const DEAD_PORT_DB = "postgresql://hilbras:hilbras@127.0.0.1:59999/hilbras";

/**
 * Boot a server and report what both probes answered.
 *
 * Every case states *both* dependencies, because the interesting properties are
 * about one of them being down: `degraded` means PostgreSQL is up and Redis is
 * not, and a fixture that killed both could not tell the difference.
 */
async function probeWith(options: {
  redisUrl: string;
  databaseUrl: string;
}): Promise<ProbeReport> {
  const out = path.join(scratch, `probe-${RUN_ID}-${probeCounter++}.json`);
  await run(process.execPath, [PROBE, out], {
    env: {
      ...process.env,
      PROBE_REDIS_URL: options.redisUrl,
      PROBE_DATABASE_URL: options.databaseUrl,
      KEYSTONE_LOG_LEVEL: "error",
    },
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((err: unknown) => {
    // The fixture exits 0 by design; anything else is worth surfacing rather than
    // turning into a confusing "file not found" further down.
    const e = err as { stderr?: string; stdout?: string };
    throw new Error(`the dead-dependency probe failed to run.\n${e.stderr ?? e.stdout ?? String(err)}`);
  });
  return JSON.parse(await readFile(out, "utf8")) as ProbeReport;
}

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "keystone-probe-"));
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
  if (redis.status !== "ready") await redis.ping();
});

after(async () => {
  await app?.close();
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe("liveness and readiness, with both dependencies healthy", () => {
  it("registers both, as README.md claims", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    assert.equal(health.statusCode, 200, health.body);
    assert.equal(ready.statusCode, 200, ready.body);
    assert.deepEqual(health.json(), { status: "ok" });
  });

  it("reports both dependencies by name, with a latency for each", async () => {
    const body = (await app.inject({ method: "GET", url: "/ready" })).json();
    assert.equal(body.status, "ready", JSON.stringify(body));
    assert.equal(body.checks.database.ok, true);
    assert.equal(body.checks.redis.ok, true);
    assert.equal(typeof body.checks.database.latencyMs, "number");
    assert.equal(typeof body.checks.redis.latencyMs, "number");
  });

  it("answers an unauthenticated request to both", async () => {
    // A probe is called by infrastructure, not by a signed-in user. If either
    // needed a token the kubelet would get a 401 and restart the pod forever.
    for (const p of ["/health", "/ready"]) {
      const res = await app.inject({ method: "GET", url: p });
      assert.equal(res.statusCode, 200, `${p} answered ${res.statusCode}`);
    }
  });
});

describe("liveness and readiness, with PostgreSQL unreachable", () => {
  let report: ProbeReport;

  // One boot for the whole block, not one per test. A server with no database
  // takes far longer to start than a healthy one, and paying that five times over
  // six assertions buys nothing: the report describes one server, and all six are
  // claims about the same server.
  before(async () => {
    report = await probeWith({
      databaseUrl: DEAD_PORT_DB,
      redisUrl: process.env.REDIS_URL!,
    });
  });

  it("boots, so the failure is a dependency and not a crash", () => {
    assert.equal(
      report.bootError,
      undefined,
      `the probe server should start even with no database: ${report.bootError}`
    );
  });

  it("answers 503 from /ready", () => {
    // The assertion the old routing could not make. `/health` returns
    // `{status: "ok"}` unconditionally, so pointing the readiness probe at it
    // meant a pod with no database was reported ready.
    assert.equal(report.ready?.statusCode, 503, `got ${report.ready?.statusCode}: ${report.ready?.body}`);
    const body = JSON.parse(report.ready!.body);
    assert.equal(body.status, "unavailable");
    assert.equal(body.checks.database.ok, false);
    assert.equal(body.checks.redis.ok, true, "only the database should be down in this case");
  });

  it("says why, because a probe that says no without a reason cannot be acted on", () => {
    const body = JSON.parse(report.ready!.body);
    assert.ok(
      typeof body.checks.database.detail === "string" && body.checks.database.detail.length > 0,
      `the failure should carry a reason: ${JSON.stringify(body)}`
    );
  });

  it("still answers 200 from /health", () => {
    // The half that is easy to get wrong the other way. If liveness depends on
    // PostgreSQL, a transient database blip fails the probe three times and
    // Kubernetes kills a healthy process — turning a degraded database into a
    // cluster with no Keystone at all.
    assert.equal(report.health?.statusCode, 200, report.health?.body);
    assert.deepEqual(JSON.parse(report.health!.body), { status: "ok" });
  });

  it("answers within the k8s readinessProbe timeout", () => {
    // `k8s/base/deployment.yaml` sets `timeoutSeconds: 5`. A probe that reports
    // its verdict in two seconds but takes twenty to deliver it is worse than no
    // probe, because the kubelet records a timeout and the operator sees nothing.
    //
    // This is not hypothetical. With the probes behind the global rate limiter —
    // which uses Redis — the first answer took 8.1s and the next two took 20.3s
    // and 20.4s, while the handler itself reported 2s every time. The time was
    // spent in the limiter, before the handler ran.
    const budget = 5_000;
    for (const [name, call] of [
      ["/ready (first)", report.ready],
      ["/ready (second)", report.secondReady],
      ["/ready (third)", report.thirdReady],
      ["/health", report.health],
    ] as const) {
      assert.ok(
        call!.elapsedMs < budget,
        `${name} took ${call!.elapsedMs}ms, over the ${budget}ms the manifest allows; ` +
          `the kubelet would record a timeout instead of the probe's own answer`
      );
    }
  });

  it("keeps answering the same way on repeat calls", () => {
    // A readiness probe whose second answer differs from its first is worse than
    // one that is simply wrong: the pod flaps in and out of the load balancer.
    for (const call of [report.secondReady, report.thirdReady]) {
      assert.equal(call?.statusCode, 503, `repeat call answered ${call?.statusCode}`);
    }
  });
});

describe("liveness and readiness, with Redis unreachable", () => {
  it("reports degraded rather than unavailable, because auth still works", async () => {
    // Redis down means the queue is in-process and the distributed rate limiter
    // is on its local fallback. Removing every pod from the rotation would take
    // authentication offline entirely for a degradation that is recoverable —
    // so 200, with the failure visible in the body and in metrics.
    const report = await probeWith({ databaseUrl: process.env.DATABASE_URL!, redisUrl: "redis://127.0.0.1:59997" });
    const body = JSON.parse(report.ready!.body);

    assert.equal(body.status, "degraded", JSON.stringify(body));
    assert.equal(body.checks.database.ok, true);
    assert.equal(body.checks.redis.ok, false);
    assert.equal(report.ready?.statusCode, 200, "degraded must not remove the pod from rotation");
  });

  it("still answers both probes quickly when Redis is down", async () => {
    // The same limiter trap, reached the other way round: with Redis unreachable
    // the rate limiter has to fall back, and if the probes are behind it they
    // cannot report the degradation that made it slow.
    const report = await probeWith({ databaseUrl: process.env.DATABASE_URL!, redisUrl: "redis://127.0.0.1:59996" });
    for (const call of [report.ready, report.secondReady, report.health]) {
      assert.ok(
        call!.elapsedMs < 5_000,
        `a probe took ${call!.elapsedMs}ms with Redis down; the manifest allows 5000ms`
      );
    }
  });

  it("reports unavailable when both dependencies are gone", async () => {
    // The only case that passes a dead Redis explicitly; the database is dead by
    // default in this fixture.
    const report = await probeWith({ databaseUrl: DEAD_PORT_DB, redisUrl: "redis://127.0.0.1:59995" });
    const body = JSON.parse(report.ready!.body);
    assert.equal(body.status, "unavailable", JSON.stringify(body));
    assert.equal(body.checks.database.ok, false);
    assert.equal(body.checks.redis.ok, false);
    assert.equal(report.ready?.statusCode, 503);
  });
});

describe("a transient outage is not fatal", () => {
  it("serves real traffic again without a restart", async () => {
    // The point of the liveness/readiness split, stated as behaviour rather than
    // as prose: the same process reports 503, then serves requests once the
    // database is back, having never been killed.
    const [user] = await db
      .insert(users)
      .values({
        email: `health-${RUN_ID}@example.test`,
        username: `health${RUN_ID}`.slice(0, 32),
        name: "health",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    createdUserIds.push(user.id);

    const duringOutage = await probeWith({ databaseUrl: DEAD_PORT_DB, redisUrl: process.env.REDIS_URL! });
    assert.equal(duringOutage.ready?.statusCode, 503, "the probe should have reported the outage");

    const afterRecovery = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: PASSWORD },
    });
    assert.equal(afterRecovery.statusCode, 200, afterRecovery.body);

    const ready = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().status, "ready");
  });
});
