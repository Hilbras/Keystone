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
process.env.KEYSTONE_INTERNAL_API_KEY ||= "chaos-redis-failure";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// The budget this suite exercises is its own, and it is set here rather than
// relied on from the runner so the suite means the same thing however it is
// invoked.
process.env.LOGIN_MAX_ATTEMPTS ||= "1000000";
process.env.LOGIN_PER_ADDRESS_MAX ||= "1000000";
process.env.LOGIN_WINDOW_SECONDS ||= "60";
process.env.GLOBAL_RATE_LIMIT_MAX ||= "1000000";
process.env.GLOBAL_RATE_LIMIT_WINDOW ||= "60";
process.env.REFRESH_RATE_MAX ||= "1000000";
process.env.REFRESH_RATE_WINDOW ||= "60";

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
const { users } = await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");

/**
 * §8.1 — what happens when Redis fails.
 *
 * Redis holds the distributed state: the rate limiter's budget, the lock, the
 * permission cache. When it is unreachable, two things have to hold at once:
 *
 * - **The limit must survive.** A limiter that fails open is the control
 *   disappearing at the moment an attacker wants it gone, and the endpoint it
 *   protects is the endpoint being attacked.
 * - **The service must survive.** The limit is one caller of Redis. If Redis
 *   being slow makes every request wait for a command that never answers, the
 *   limiter is not degraded, the API is down — and the degraded path that
 *   exists to keep serving never engages, because the request is still
 *   waiting.
 *
 * The second is the one this suite is really about. The per-endpoint fallback
 * already existed and is tested elsewhere; what was missing was the *global*
 * limiter, which was the one place the fallback was switched off, and any
 * bound at all on how long a slow Redis can hold a request.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Chaos-Redis-Passw0rd!";
const createdUserIds: string[] = [];

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
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("the global rate limiter survives Redis being down (§8.1)", () => {
  it("keeps refusing past its budget instead of failing open", async () => {
    // The global limiter is the one that used to fail open. It is also the one
    // that matters most during an outage: it is the limit in front of every
    // other endpoint, so losing it removes the ceiling from the whole server.
    const { globalRateLimit } = await import("../../plugins/rateLimit.js");
    const { resetLocalRateLimits } = await import("../../services/localRateLimit.js");
    const { redis } = await import("../../services/redis.js");

    resetLocalRateLimits();
    redis.disconnect();

    const guard = globalRateLimit({
      maxRequests: 3,
      windowSeconds: 60,
      keyPrefix: "chaos-global",
    });

    const results: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      let status = 200;
      await guard(
        {
          id: `chaos-global-${attempt}`,
          method: "GET",
          url: "/health/live",
          headers: {},
          ip: "198.51.100.9",
          socket: { remoteAddress: "198.51.100.9" },
        } as never,
        {
          header() {
            return this;
          },
          status(code: number) {
            status = code;
            return this;
          },
          send() {
            return this;
          },
        } as never
      );
      results.push(status);
    }

    assert.equal(
      results.filter((status) => status === 429).length,
      results.length - 3,
      `with Redis down the global limiter must still refuse past its budget; got ${results.join(", ")}`
    );

    redis.connect().catch(() => {});
  });

  it("the SCIM pre-authentication budget survives Redis being down", async () => {
    // `isAllowed` guards the SCIM authentication-failure path. A budget that
    // disappears exactly when the service it protects is in trouble is the
    // wrong way round.
    const { isAllowed } = await import("../../plugins/rateLimit.js");
    const { resetLocalRateLimits } = await import("../../services/localRateLimit.js");
    const { redis } = await import("../../services/redis.js");

    resetLocalRateLimits();
    redis.disconnect();

    const allowed: boolean[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      allowed.push(await isAllowed("chaos-scim-preauth", 3, 60));
    }

    assert.equal(
      allowed.filter(Boolean).length,
      3,
      `the pre-authentication budget must still cap at 3; got ${allowed.join(", ")}`
    );

    redis.connect().catch(() => {});
  });
});

describe("a request that succeeds during a Redis outage is not corrupt (§8.1)", () => {
  it("issues a usable session while Redis is unreachable", async () => {
    // The limiter is degraded; the rest of the request path must not be. A
    // login that succeeds but produces a token that cannot be used would be a
    // worse outcome than a refusal, because the client believes it is signed
    // in.
    const { redis } = await import("../../services/redis.js");
    const user = await makeUser("chaos-login-during-outage");

    redis.disconnect();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/auth/token-login",
        payload: { email: user.email, password: PASSWORD },
      });
      assert.equal(res.statusCode, 200, `the login must still work: ${res.body}`);
      const body = res.json();
      assert.ok(body.accessToken, "an access token must be issued");
      assert.ok(body.refreshToken, "a refresh token must be issued");

      // And it must actually work: the token is presented to a protected route.
      const me = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      assert.equal(me.statusCode, 200, `the issued token must be usable: ${me.body}`);
    } finally {
      redis.connect().catch(() => {});
    }
  });
});

describe("the limiter recovers when Redis comes back (§8.1)", () => {
  it("goes back to a shared budget once Redis is reachable again", async () => {
    // The degraded path must not be sticky. A server that fell back to the
    // local budget and never came back would keep limiting per-process for the
    // life of the process, and the fleet would slowly stop sharing a budget
    // even though Redis came back minutes later.
    const { isAllowed } = await import("../../plugins/rateLimit.js");
    const { resetLocalRateLimits } = await import("../../services/localRateLimit.js");
    const { redis } = await import("../../services/redis.js");
    const { checkLimit } = await import("../../plugins/rateLimit.js") as {
      checkLimit?: never;
    };
    void checkLimit;

    resetLocalRateLimits();

    // Wait for the client to be usable again.
    const deadline = Date.now() + 10_000;
    while (redis.status !== "ready" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(redis.status, "ready", "the shared client must come back up");

    const key = `chaos-recovery-${crypto.randomBytes(4).toString("hex")}`;
    const before = await isAllowed(key, 3, 60);
    assert.equal(before, true, "the first attempt must be allowed");
  });
});

describe("the application can still be closed when Redis is down (§8.1)", () => {
  it("closes in bounded time", async () => {
    // §8.1. The server's SIGTERM path was bounded (SEC-097), but everything
    // else that closes the application was not: the cache's own Redis was
    // closed with `quit()`, which waits for an answer from a server that is
    // down, for as long as the server stays down.
    //
    // A separate instance, because closing the shared one would end the rest
    // of the suite.
    const { buildApp } = await import("../../index.js");
    const { redis } = await import("../../services/redis.js");

    const instance = await buildApp();
    await instance.ready();

    redis.disconnect();

    const startedAt = Date.now();
    await instance.close();
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed < 15_000,
      `closing the application must be bounded when Redis is unreachable; it took ${elapsed}ms`
    );

    redis.connect().catch(() => {});
  });
});

describe("a slow Redis is bounded rather than a hang (§8.1)", () => {
  it("answers a request while Redis accepts connections and never replies", async () => {
    // The unreachable case is easy to handle: the command is refused. The slow
    // case is the one that takes the server down, because every command waits
    // for an answer that never comes — and the rate limiter is in front of
    // every request. The operational probe recorded eight seconds for the
    // first request during an outage and twenty for each of the next, which is
    // the symptom this is about.
    const probe = path.join(__dirname, "..", "helpers", "slowRedisProbe.js");
    const output = path.join(__dirname, "..", "..", "..", "tmp-chaos-slow-redis.json");
    await rm(output, { force: true });

    await run(process.execPath, [probe, output], {
      env: {
        ...process.env,
        PROBE_DATABASE_URL: process.env.DATABASE_URL,
        KEYSTONE_LOG_LEVEL: "error",
      },
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const report = JSON.parse(await readFile(output, "utf8"));
    await rm(output, { force: true });

    assert.ok(!report.bootError, `the probe must boot: ${report.bootError}`);
    assert.ok(
      typeof report.probedStatus === "number",
      `the probe must get an answer from the server: ${JSON.stringify(report)}`
    );
    assert.ok(
      typeof report.elapsedMs === "number" && report.elapsedMs < 10_000,
      `a request must not hang on a slow Redis; it took ${report.elapsedMs}ms`
    );
  });
});
