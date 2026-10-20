import { writeFile } from "node:fs/promises";
import net from "node:net";

/**
 * Boot a Keystone server against a Redis that accepts connections and never
 * answers, and report how long a request took.
 *
 * §8.1 lists "Redis slow response" as a case to test, and it is the one the
 * existing probes cannot reach. "Redis unreachable" is easy: point the client at
 * a port nothing listens on and every command is refused. A *slow* Redis is
 * harder, and it is the worse failure — the socket is open, the server is
 * healthy, it just answers later than it should. ioredis has no command
 * timeout by default, so every command waits for an answer that never comes.
 *
 * The operational probe records what that cost: eight seconds for the first
 * request during an outage and twenty for each of the next. The rate limiter
 * is in front of every request, so a Redis that is slow rather than absent
 * takes the whole API down rather than just the limiter — and the degraded
 * path that exists to keep serving never gets a chance to engage, because the
 * request is still waiting on the command that will not return.
 *
 * The probe starts the slow server itself, so the caller does not have to
 * arrange one, and it drives exactly one request: three would spend a minute
 * and a half proving something one request already shows.
 *
 * Invoked as: node dist/tests/helpers/slowRedisProbe.js <output.json>
 */

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.DATABASE_URL = process.env.PROBE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
process.env.KEYSTONE_INTERNAL_API_KEY = "slowredis-probe";
process.env.KEYSTONE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
// The budgets the probe drives would otherwise be refused by the limiter before
// the limiter is reached, and a 429 tells us nothing about the fallback.
process.env.LOGIN_MAX_ATTEMPTS = "1000";
process.env.GLOBAL_RATE_LIMIT_MAX = "10000";

if (!process.env.DATABASE_URL) {
  console.error("usage: slowRedisProbe <output.json>  (needs DATABASE_URL, or PROBE_DATABASE_URL)");
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
  console.error("usage: slowRedisProbe <output.json>");
  process.exit(2);
}

/**
 * A server that accepts every connection and says nothing.
 *
 * Not a refusal and not a reset: the connection succeeds, which is the part
 * that makes this failure different from an unreachable Redis. A client that
 * only handles "connection refused" will look fine here and hang in
 * production.
 */
const sockets: net.Socket[] = [];
const slow = net.createServer((socket) => {
  sockets.push(socket);
  // Deliberately no data, ever. The socket stays open so the client believes
  // it is talking to a healthy server.
});
await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
const address = slow.address();
const port = typeof address === "object" && address ? address.port : 0;
process.env.REDIS_URL = `redis://127.0.0.1:${port}`;

const report: Record<string, unknown> = { slowRedisPort: port };
let app: Awaited<ReturnType<typeof import("../../index.js").buildApp>> | undefined;

try {
  const { buildApp } = await import("../../index.js");
  const { hashPassword } = await import("../../services/secrets/index.js");
  const { db } = await import("../../db/index.js");
  const { users } = await import("../../db/schema.js");

  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const serverAddress = app.server.address();
  const base = `http://127.0.0.1:${typeof serverAddress === "object" && serverAddress ? serverAddress.port : 0}`;

  const email = `slowredis-probe-${Date.now()}@example.test`;
  await db
    .insert(users)
    .values({
      email,
      username: `slowprobe${Date.now()}`.slice(0, 32),
      name: "probe",
      emailVerified: true,
      passwordHash: await hashPassword("Probe-Passw0rd!"),
    })
    .returning();
  report.email = email;

  // One request. The global rate limiter runs on every request and it uses
  // Redis, so this request pays the full cost of a Redis that never answers.
  const startedAt = Date.now();
  const probed = await fetch(`${base}/auth/token-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "wrong-on-purpose" }),
  });
  report.elapsedMs = Date.now() - startedAt;
  report.probedStatus = probed.status;

  const metrics = await (await fetch(`${base}/metrics`)).text();
  report.metrics = metrics;

  await writeFile(OUTPUT_PATH, JSON.stringify(report), "utf8");
} catch (err) {
  report.bootError = err instanceof Error ? err.message : String(err);
  await writeFile(OUTPUT_PATH, JSON.stringify(report), "utf8");
} finally {
  // The Redis connection is dropped *first*. `app.close()` waits for the
  // graceful-shutdown path, which asks Redis to quit — and a Redis that
  // accepts connections and never answers will not answer that either, so
  // the close hangs and the probe never reports. Disconnecting first is what
  // makes the shutdown bounded, and the close itself is given a deadline for
  // the same reason: a probe that cannot exit cannot report.
  try {
    const { redis } = await import("../../services/redis.js");
    redis.disconnect();
  } catch {
    // The client may never have been created.
  }
  for (const socket of sockets) socket.destroy();
  slow.close();
  await settle(app?.close(), 5000);
  try {
    const { closeDb } = await import("../../db/index.js");
    await settle(closeDb(), 5000);
  } catch {
    // The database may never have been opened.
  }
  process.exit(0);
}

/** Wait for a promise, but not forever. */
async function settle(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!promise) return;
  await Promise.race([
    promise.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}
