import { writeFile } from "node:fs/promises";

/**
 * Boot a Keystone server, drive real traffic, and write out what `/metrics` says.
 *
 * §5.1 needs to assert that the emergency local limiter's series moves. That
 * requires a server whose **Redis is unreachable** and whose database is fine —
 * the opposite of the readiness suite's case — and it cannot be done in this
 * process for the same reason as there: a cache-busting query string on the entry
 * module does not reach its dependencies, so an in-process "broken" server gets
 * the healthy pool and the test would pass for the wrong reason.
 *
 * Both dependencies are the caller's choice, read from the environment. The
 * default is whatever the parent process had, so a caller that wants one broken
 * says which one.
 *
 * Invoked as: node dist/tests/helpers/operationalProbe.js <output.json>
 */

/** Ports nothing listens on, for the dependency the caller wants broken. */
const DEAD_REDIS = process.env.PROBE_DEAD_REDIS ?? "redis://127.0.0.1:59994";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.DATABASE_URL = process.env.PROBE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
process.env.REDIS_URL = process.env.PROBE_REDIS_URL ?? DEAD_REDIS;
process.env.KEYSTONE_INTERNAL_API_KEY = "opmetrics-probe";
process.env.KEYSTONE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
// The budgets the probe drives would otherwise be refused by the limiter before
// the limiter is reached, and a 429 tells us nothing about the fallback.
process.env.LOGIN_MAX_ATTEMPTS = "1000";
process.env.GLOBAL_RATE_LIMIT_MAX = "10000";

if (!process.env.DATABASE_URL) {
  console.error("usage: operationalProbe <output.json>  (needs DATABASE_URL, or PROBE_DATABASE_URL)");
  process.exit(2);
}

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const OUTPUT_PATH = process.argv[2];
if (!OUTPUT_PATH) {
  console.error("usage: operationalProbe <output.json>");
  process.exit(2);
}

const { buildApp } = await import("../../index.js");
const { hashPassword } = await import("../../services/secrets/index.js");
const { db, closeDb } = await import("../../db/index.js");
const { users } = await import("../../db/schema.js");

const report: Record<string, unknown> = {
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
};
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  report.port = port;

  const email = `opmetrics-probe-${Date.now()}@example.test`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      username: `opprobe${Date.now()}`.slice(0, 32),
      name: "probe",
      emailVerified: true,
      passwordHash: await hashPassword("Probe-Passw0rd!"),
    })
    .returning();
  report.email = email;

  const metricsBefore = await (await fetch(`${base}/metrics`)).text();

  // **One** request, deliberately.
  //
  // The global rate limiter runs on every request and it uses Redis, so with Redis
  // unreachable each request pays the full failure path — measured in the
  // readiness suite at 8s for the first and 20s for each of the next. Three
  // requests here would spend a minute and a half proving something one request
  // already shows: the limiter's fallback engages on the first attempt.
  //
  // The authentication and token counters are asserted against the healthy server
  // instead, where they cost milliseconds. This probe exists only for the two
  // series that need a broken Redis.
  const probed = await fetch(`${base}/auth/token-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "wrong-on-purpose" }),
  });
  report.probedStatus = probed.status;

  const metricsAfter = await (await fetch(`${base}/metrics`)).text();
  report.metricsBefore = metricsBefore;
  report.metricsAfter = metricsAfter;
  report.sample = { userId: user.id, email };
  await writeFile(OUTPUT_PATH, JSON.stringify(report), "utf8");
} catch (err) {
  report.bootError = err instanceof Error ? err.message : String(err);
  await writeFile(OUTPUT_PATH, JSON.stringify(report), "utf8");
} finally {
  await app?.close().catch(() => {});
  // Remove the probe's own user so repeated runs do not accumulate rows.
  if (report.email) {
    const { eq: eqOp } = await import("drizzle-orm");
    await db.delete(users).where(eqOp(users.email, report.email as string)).catch(() => {});
  }
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  redis.disconnect();
  process.exit(0);
}
