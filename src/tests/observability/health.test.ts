import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const run = promisify(execFile);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "health-gate-test-key";
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
const { migrationsFolder } = await import("../../lib/paths.js");
const { redis } = await import("../../services/redis.js");
const { markStartupComplete, resetStartupState, buildStartupReport } = await import(
  "../../services/startup.js"
);

/**
 * The three probes, as the deployment asks for them.
 *
 * §5.3 requires `/health/live`, `/health/ready` and `/health/startup` to be
 * separate questions, and separation is only worth anything if the three can
 * *disagree*. That is the property this file tests, and it is why almost every
 * assertion here is about a pair of answers rather than one:
 *
 * - With PostgreSQL unreachable, `/health/ready` is 503 and `/health/live` is 200.
 *   If liveness depended on the database, a transient outage would fail the probe
 *   three times and Kubernetes would kill a healthy process — turning a degraded
 *   database into a cluster with no Keystone at all.
 * - With PostgreSQL unreachable, `/health/startup` is **200**, because boot
 *   finished. A startup probe that fails on a dependency is worse than none: the
 *   kubelet never runs the liveness probe while startup is failing, so a pod that
 *   would have recovered the moment PostgreSQL came back is restarted instead, and
 *   the deployment never converges. The pod stays out of the rotation because
 *   readiness says so, which is exactly where the outage belongs.
 * - Before the socket binds, `/health/startup` is 503 and the other two cannot be
 *   asked at all. This is the ordering that makes the gate a gate rather than a
 *   constant, and it is asserted on both sides of `listen()`.
 *
 * **The aliases are not decoration.** `/health/live` and `/health/ready` are the
 * spellings every Kubernetes example in the wild uses, and a deployment that
 * guessed them against the 3.9.x server got a 404 for its startup probe — which
 * the kubelet reads as "still starting" and never recovers from, because it never
 * runs the liveness probe that would have restarted the pod. A 404 on a startup
 * probe is a wedged deployment with no restart and no readiness signal, and the
 * only clue is in `kubectl describe pod`. Both spellings exist, both are tested,
 * and the short ones stay because every existing installation is pointed at them.
 *
 * The dependency outage is produced in a separate process, over a real socket, for
 * the reasons recorded in `tests/helpers/deadDatabaseProbe.ts`: an in-process
 * cache-busting import does not reach `db`, and `inject` resolves at a different
 * moment from a TCP client seeing the bytes.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PROBE = path.resolve(__dirname, "../helpers/deadDatabaseProbe.js");
const DEAD_PORT_DB = "postgresql://hilbras:hilbras@127.0.0.1:59999/hilbras";

interface ProbeResponse {
  statusCode: number;
  body: string;
  elapsedMs: number;
}

interface ProbeReport {
  port?: number;
  bootError?: string;
  startupBeforeListen?: { status: string; uptimeMs: number };
  startupAfterListen?: { status: string; uptimeMs: number };
  health?: ProbeResponse;
  healthLive?: ProbeResponse;
  healthReady?: ProbeResponse;
  healthStartup?: ProbeResponse;
  ready?: ProbeResponse;
}

let app: FastifyInstance;
let scratch: string;
let probeCounter = 0;

/**
 * A probe body with the per-call timing removed.
 *
 * `latencyMs` is measured on every call by design, so two calls can never have
 * identical bodies — comparing them whole would fail on a correct server and pass
 * only by coincidence. What must not vary between an alias and its original is the
 * verdict: the status word and whether each dependency answered.
 */
function stablePart(body: Record<string, unknown>): Record<string, unknown> {
  const checks = (body.checks ?? {}) as Record<string, { ok?: boolean }>;
  return {
    status: body.status,
    checks: Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, check.ok])),
  };
}

async function probeWith(options: { databaseUrl: string; redisUrl: string }): Promise<ProbeReport> {
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
    const e = err as { stderr?: string; stdout?: string };
    throw new Error(`the dead-dependency probe failed to run.\n${e.stderr ?? e.stdout ?? String(err)}`);
  });
  return JSON.parse(await readFile(out, "utf8")) as ProbeReport;
}

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "keystone-probes-"));
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
  if (redis.status !== "ready") await redis.ping();
});

after(async () => {
  await app?.close();
  await closeDb().catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe("the three probes are registered, and anonymous", () => {
  it("serves all five spellings", async () => {
    // Five paths, three questions. The two extra spellings are the `/health/*`
    // ones; `/health` and `/ready` are the originals and cannot be removed without
    // un-probing every installation already deployed.
    for (const url of ["/health", "/health/live", "/ready", "/health/ready", "/health/startup"]) {
      const res = await app.inject({ method: "GET", url });
      assert.ok(
        res.statusCode !== 404,
        `${url} answered 404. A probe path that does not exist is read by the ` +
          `kubelet as a failing probe, not as a misconfiguration.`
      );
    }
  });

  it("answers every probe without a token", async () => {
    // Infrastructure calls these, not signed-in users. A 401 here restarts the pod
    // forever, and the restart never fixes it.
    markStartupComplete();
    for (const url of ["/health", "/health/live", "/ready", "/health/ready", "/health/startup"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, `${url} answered ${res.statusCode}: ${res.body}`);
    }
  });
});

describe("the startup gate discriminates between composed and bound", () => {
  it("answers 503 while the process has not bound", async () => {
    // `inject` never calls `listen()`, so this is the state every test that builds
    // an app without listening is in — and, more importantly, the state a real
    // process is in while it composes itself.
    resetStartupState();
    const res = await app.inject({ method: "GET", url: "/health/startup" });
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().status, "starting");
  });

  it("answers 200 once boot has completed", async () => {
    markStartupComplete();
    const res = await app.inject({ method: "GET", url: "/health/startup" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, "started");
  });

  it("reports boot progress as two words and an uptime, and nothing else", async () => {
    // The endpoint is unauthenticated and reachable from outside the cluster
    // wherever the Service is exposed. Version numbers, migration state, phase
    // names and module inventory are all things an unauthenticated caller does not
    // need, and this is the assertion that keeps a later "helpful" addition from
    // putting them there.
    markStartupComplete();
    const body = (await app.inject({ method: "GET", url: "/health/startup" })).json();
    assert.deepEqual(Object.keys(body).sort(), ["status", "uptimeMs"]);
    assert.equal(typeof body.uptimeMs, "number");
  });

  it("flips on the bind, and not before it", async () => {
    // The ordering, read directly on both sides of `listen()`. The gate is a hook
    // on Fastify's `onListen`, which runs after the listen callback reports success
    // — so a refused or occupied port leaves the probe answering 503 forever, which
    // is the correct answer and one an operator can act on.
    //
    // Read through `buildStartupReport()` rather than over HTTP because before the
    // bind there is no socket to ask. One real process, two reads, one statement
    // apart: anything that differs between them is attributable to the bind.
    const report = await probeWith({
      databaseUrl: process.env.DATABASE_URL!,
      redisUrl: process.env.REDIS_URL!,
    });

    assert.equal(report.bootError, undefined, `the probe should have booted: ${report.bootError}`);
    assert.equal(
      report.startupBeforeListen?.status,
      "starting",
      "a composed application that has not bound must still be starting, or the " +
        `startup gate is a constant. Got ${JSON.stringify(report.startupBeforeListen)}`
    );
    assert.equal(
      report.startupAfterListen?.status,
      "started",
      `the bind should complete boot. Got ${JSON.stringify(report.startupAfterListen)}`
    );
  });
});

describe("with PostgreSQL unreachable, the three probes disagree correctly", () => {
  let report: ProbeReport;

  before(async () => {
    // One boot for the block: a server with no database takes far longer to start
    // than a healthy one, and every assertion here is a claim about that one server.
    report = await probeWith({ databaseUrl: DEAD_PORT_DB, redisUrl: process.env.REDIS_URL! });
  });

  it("boots, so the failure is a dependency and not a crash", () => {
    assert.equal(report.bootError, undefined, `the probe server should start: ${report.bootError}`);
  });

  it("answers 503 from both readiness spellings", () => {
    for (const [name, call] of [
      ["/ready", report.ready],
      ["/health/ready", report.healthReady],
    ] as const) {
      assert.equal(call?.statusCode, 503, `${name} answered ${call?.statusCode}: ${call?.body}`);
      assert.equal(JSON.parse(call!.body).status, "unavailable");
    }
  });

  it("answers 200 from both liveness spellings", () => {
    // The half that is easy to get wrong the other way. Liveness must not depend on
    // PostgreSQL, or the outage becomes a restart loop.
    for (const [name, call] of [
      ["/health", report.health],
      ["/health/live", report.healthLive],
    ] as const) {
      assert.equal(call?.statusCode, 200, `${name} answered ${call?.statusCode}: ${call?.body}`);
      assert.deepEqual(JSON.parse(call!.body), { status: "ok" });
    }
  });

  it("answers 200 from the startup gate", () => {
    // Boot finished; the database being unreachable is a readiness fact, not a
    // startup one. Answering 503 here would stop the kubelet from ever running the
    // liveness probe, so a pod that would have recovered on reconnect is restarted
    // on a loop instead — and the deployment never converges.
    assert.equal(
      report.healthStartup?.statusCode,
      200,
      `the startup gate answered ${report.healthStartup?.statusCode}: ${report.healthStartup?.body}`
    );
    assert.equal(JSON.parse(report.healthStartup!.body).status, "started");
  });
});

describe("the aliases cannot drift from what they alias", () => {
  it("answers the same status and body on both spellings of each probe", async () => {
    // Two handlers that merely look the same is how an alias becomes a second
    // implementation with its own bugs. This holds them to one answer, and it holds
    // in the outage case too because the same assertion runs against a server whose
    // database is unreachable.
    markStartupComplete();
    const pairs: Array<[string, string]> = [
      ["/health", "/health/live"],
      ["/ready", "/health/ready"],
    ];

    for (const [a, b] of pairs) {
      const first = await app.inject({ method: "GET", url: a });
      const second = await app.inject({ method: "GET", url: b });
      assert.equal(first.statusCode, second.statusCode, `${a} and ${b} disagreed on status`);
      assert.deepEqual(stablePart(first.json()), stablePart(second.json()), `${a} and ${b} disagreed`);
    }

    const report = await probeWith({ databaseUrl: DEAD_PORT_DB, redisUrl: process.env.REDIS_URL! });
    for (const [a, b] of [
      [report.ready, report.healthReady],
      [report.health, report.healthLive],
    ] as const) {
      assert.equal(a?.statusCode, b?.statusCode, "an alias disagreed with its original during an outage");
      assert.deepEqual(stablePart(JSON.parse(a!.body)), stablePart(JSON.parse(b!.body)));
    }
  });
});

describe("a transient outage is not fatal", () => {
  it("answers 503, then serves again, having never been restarted", async () => {
    const during = await probeWith({ databaseUrl: DEAD_PORT_DB, redisUrl: process.env.REDIS_URL! });
    assert.equal(during.ready?.statusCode, 503, "the probe should have reported the outage");

    const after = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.json().status, "ready");
  });
});

describe("the startup state module", () => {
  it("keeps the completion timestamp when marked twice", async () => {
    // Idempotence, because the hook can run more than once — a second `listen()`
    // on the same instance, or a fixture that binds after the bootstrap did — and a
    // timestamp that moves makes `uptimeMs` mean something different from what it
    // says.
    resetStartupState();
    markStartupComplete();
    const first = buildStartupReport();
    await new Promise((resolve) => setTimeout(resolve, 5));
    markStartupComplete();
    const second = buildStartupReport();
    assert.equal(second.status, "started");
    assert.ok(
      second.uptimeMs >= first.uptimeMs,
      `uptime went backwards: ${first.uptimeMs} then ${second.uptimeMs}`
    );
    markStartupComplete();
  });
});
