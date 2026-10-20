import { writeFile } from "node:fs/promises";

/**
 * Boot a Keystone server against an unreachable database, and report what the
 * three probes answer.
 *
 * §5.2 needs a readiness probe that fails with PostgreSQL down. Producing that
 * in-process turned out to be harder than it looks, for a reason worth writing
 * down because it will come up again:
 *
 * **A cache-busting query string on the entry module does not reach its
 * dependencies.** `import("./index.js?dead-db=1")` evaluates a second copy of
 * `index.ts` — and `index.ts` does `import { db } from "../db/index.js"`, which
 * resolves to the *already-cached* module. So the "broken" server got the healthy
 * pool, reported 200, and the first version of this test asserted nothing.
 *
 * The alternative, pointing the shared pool at a dead address, would leave the
 * suite unable to clean up after itself. A separate process is the honest
 * version: separate module registry, separate pool, separate everything — which
 * is also what a deployment looks like.
 *
 * **Over a real socket, not `app.inject`.** `inject` resolves when the
 * in-process response is complete, which is not the moment a TCP client sees the
 * bytes, and the two diverge substantially when the event loop is busy with
 * reconnect attempts — which is precisely the situation the probe exists for. A
 * fix aimed at the probe when the delay is in the test would be aimed at nothing,
 * so the transport is the one the kubelet actually uses.
 *
 * Writes a file rather than printing, because the report embeds JSON response
 * bodies and extracting those out of a log-filled stdout stream turned out to be
 * its own small parsing problem.
 *
 * Invoked as: node dist/tests/helpers/deadDatabaseProbe.js <output.json>
 */
/**
 * Both dependencies are inherited from the caller's environment unless overridden,
 * so the caller states exactly which one is broken. Defaulting the database to a
 * dead port made "the database is unreachable" mean "both are unreachable", and
 * two tests failed for a reason that had nothing to do with what they were
 * testing.
 */
const PROBE_DATABASE_URL = process.env.PROBE_DATABASE_URL ?? process.env.DATABASE_URL;
const PROBE_REDIS_URL = process.env.PROBE_REDIS_URL ?? process.env.REDIS_URL;
if (!PROBE_DATABASE_URL || !PROBE_REDIS_URL) {
  console.error("usage: deadDatabaseProbe <output.json>  (needs DATABASE_URL and REDIS_URL, or PROBE_* overrides)");
  process.exit(2);
}

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.DATABASE_URL = PROBE_DATABASE_URL;
process.env.REDIS_URL = PROBE_REDIS_URL;
process.env.KEYSTONE_INTERNAL_API_KEY = "dead-db-probe";
process.env.KEYSTONE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const OUTPUT_PATH = process.argv[2];
if (!OUTPUT_PATH) {
  console.error("usage: deadDatabaseProbe <output.json>");
  process.exit(2);
}

async function writeReport(value: Record<string, unknown>): Promise<void> {
  await writeFile(OUTPUT_PATH, JSON.stringify(value), "utf8");
}

const { buildApp } = await import("../../index.js");
const { buildStartupReport } = await import("../../services/startup.js");

const report: Record<string, unknown> = {
  databaseUrl: PROBE_DATABASE_URL,
  redisUrl: PROBE_REDIS_URL,
  transport: "real socket, fetch",
};
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  app = await buildApp();

  // Recorded *before* the bind, and read directly rather than over HTTP because
  // there is no socket to ask yet. This is the half of the ordering that an HTTP
  // probe can never observe: a composed application that has not bound must still
  // report "starting", or the startup gate is a constant.
  report.startupBeforeListen = buildStartupReport();

  await app.listen({ port: 0, host: "127.0.0.1" });

  // And the other half, read the same way, one statement after the bind. Between
  // these two reads the only thing that happened is `listen()`, so a difference
  // between them is attributable to the bind and to nothing else.
  report.startupAfterListen = buildStartupReport();

  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  report.port = port;

  const get = async (path: string) => {
    const at = Date.now();
    const res = await fetch(`${base}${path}`);
    const body = await res.text();
    return { statusCode: res.status, body, elapsedMs: Date.now() - at };
  };

  const started = Date.now();
  report.health = await get("/health");
  report.ready = await get("/ready");
  report.probeElapsedMs = Date.now() - started;

  // A **business** route, not another probe endpoint.
  //
  // The health probes answer 503 when the database is down, by construction —
  // they check the database. So a probe that only asked them proved nothing
  // about what a *caller* gets, and the answer it gave was "503", while every
  // business route was answering 500 with the failed query in the body. The
  // status a caller sees during an outage is the thing worth knowing, and only
  // a business route knows it.
  //
  // The login route is used because it is unauthenticated, it reaches the
  // database on every call, and a body that never existed cannot answer.
  const businessStarted = Date.now();
  const business = await fetch(`${base}/auth/token-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.test", password: "wrong-on-purpose" }),
  });
  report.business = {
    statusCode: business.status,
    body: await business.text(),
    elapsedMs: Date.now() - businessStarted,
  };

  // The two aliases, and the startup gate.
  //
  // The startup gate is the one worth thinking about here: it is expected to
  // answer **200** with the database unreachable. Startup asks "has boot
  // finished", not "can this pod serve traffic" — that second question is
  // readiness, and it is the one that answers 503 below. Conflating them is how a
  // dependency outage becomes a restart loop: a startup probe that fails while
  // PostgreSQL is down stops the kubelet from ever running the liveness probe, so
  // a process that would have recovered the moment the database came back is
  // restarted instead, and the deployment never converges.
  //
  // Reported over the same real socket as everything else, because the ordering
  // between `listen()` and the flag is exactly the thing under test.
  report.healthLive = await get("/health/live");
  report.healthReady = await get("/health/ready");
  report.healthStartup = await get("/health/startup");

  // Repeat calls, to separate a one-off connection cost from the steady-state
  // one. The first pays whatever ioredis and postgres.js charge for discovering
  // the port is closed; later ones have already paid it.
  report.secondReady = await get("/ready");
  report.thirdReady = await get("/ready");

  // Written *before* the finally block, because the finally calls process.exit and
  // nothing after the try statement is ever reached. The first version of this
  // fixture did exactly that and printed nothing, which looked like the probe
  // failing rather than the fixture.
  await writeReport(report);
} catch (err) {
  // A server that cannot even start is a legitimate outcome for this probe, and
  // reporting it is more useful than a bare stack trace on stderr.
  report.bootError = err instanceof Error ? err.message : String(err);
  await writeReport(report);
} finally {
  await app?.close().catch(() => {});
  process.exit(0);
}
