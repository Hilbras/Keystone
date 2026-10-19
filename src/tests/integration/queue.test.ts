import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "queue-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.LOGIN_MAX_ATTEMPTS ||= "1000";

function redisReachable(host = "localhost", port = 6379): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Exercise the BullMQ driver, and say so in the environment rather than assume it.
 *
 * The `BullMQ queue` cases below assert that the application's queue is a
 * `BullMQQueue`, because a private `new BullMQQueue(...)` in one process is not a
 * second queue: BullMQ addresses consumers by queue *name*, this driver uses the
 * single name `"keystone"`, and two instances on that name are two halves of one
 * consumer pool — a job the test enqueues can be claimed by the application's
 * worker, which has no handler for it. Those cases need the application itself on
 * the driver, so the driver has to be chosen here, before `config` is imported.
 *
 * `KEYSTONE_QUEUE_PROVIDER` defaults to `in-process` and nothing sets it in CI, so
 * without this line the four cases tested the assertion instead of the driver: they
 * failed on every machine that had not written the variable into a local `.env` —
 * which CI does not have — and passed only where one existed.
 *
 * Reachability decides it in both directions. With a Redis the cases run against
 * the real driver; without one they skip and the application stays on the
 * in-process provider that the rest of this file assumes.
 */
const redisAvailable = await redisReachable();
process.env.KEYSTONE_QUEUE_PROVIDER = redisAvailable ? "bullmq" : "in-process";

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
const { InProcessQueue } = await import("../../services/queue/inProcess.js");
const { BullMQQueue } = await import("../../services/queue/bullmq.js");
const { countFailedLogins, recordFailedLogin } = await import(
  "../../services/anomalyDetection.js"
);
const { redis } = await import("../../services/redis.js");

/**
 * The queue, and the failure accounting that depends on it.
 *
 * §4.4 asked for "enqueue → execute → retry → dead-letter". The existing suite
 * covered one happy path on BullMQ and nothing on the in-process queue, so the
 * retry and dead-letter behaviour of both was unasserted — and the retry
 * behaviour is where a queue actually goes wrong.
 *
 * The BullMQ cases run on the application's own queue, and two of them pin a
 * dispatch defect: the driver used to start one worker per job type, all of them
 * consuming the single `"keystone"` queue, so a job could be handed to the wrong
 * type's handler and a registered handler might never run at all. See the note on
 * `worker` in `services/queue/bullmq.ts`.
 *
 * The second half of this file is the SEC-053 regression: one real failed login
 * must produce exactly one `user_login_failed` event. It is here rather than in a
 * security suite because the thing being pinned is a count, and the count is what
 * the spray threshold and the metric both read.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Queue-Passw0rd!";
const createdUserIds: string[] = [];
let app: FastifyInstance;

/** Wait for a condition, bounded so a dead worker fails rather than hangs. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
  if (redisAvailable) await redis.ping();
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

describe("in-process queue", () => {
  it("runs a job and counts it", async () => {
    const queue = new InProcessQueue();
    let seen: unknown;
    queue.process("q_ok", (job) => {
      seen = job.payload;
    });

    await queue.enqueue({ type: "q_ok", payload: { n: 1 } });
    assert.ok(await waitFor(() => seen !== undefined), "the job never ran");

    const [stats] = await queue.getStats();
    assert.equal(stats.type, "q_ok");
    assert.equal(stats.count, 1, "one job should be counted once");
    assert.equal(stats.failed, 0, "and nothing should have failed");
    await queue.close();
  });

  it("retries a failing job and gives up after the attempt budget", async () => {
    // The behaviour §4.4 names, and the part that was unasserted. A queue that
    // retries forever is a queue that will keep a poison job alive for the life
    // of the process; one that never retries drops work that a transient failure
    // would have fixed.
    const queue = new InProcessQueue();
    const attempts: number[] = [];
    queue.process("q_flaky", () => {
      attempts.push(attempts.length + 1);
      throw new Error("always fails");
    });

    // The regression this covers is a *crash*, not a count. Before the fix the
    // attempt that exhausted the budget threw into an unhandled rejection —
    // `setTimeout(() => this.run(...))` discarded the promise — and Node
    // terminates the process on an unhandled rejection. One poison job took the
    // server down. The assertion that matters is that this test process is still
    // running when the assertions below execute.
    await queue.enqueue({ type: "q_flaky", payload: {}, attempts: 3 });
    assert.ok(
      await waitFor(() => attempts.length >= 3, 15000),
      `expected three attempts, saw ${attempts.length} — and the process survived, ` +
        "so the unhandled rejection is gone"
    );
    // Give any fourth attempt a chance to appear before asserting it did not.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(attempts.length, 3, "a job must not be retried past its attempt budget");

    const [stats] = await queue.getStats();
    assert.equal(stats.failed, 1, "the job should be recorded as failed once, not once per attempt");
    await queue.close();
  });

  it("records no dead-letter for a job that cannot succeed", async () => {
    // Stated rather than skipped, because it is a real limitation of this driver
    // and the assertion is what stops it being mistaken for a tested behaviour.
    // `getFailed` returns [] and `retryAll` is a no-op, so on the in-process
    // driver a permanently failing job is lost: a log line and a counter, and
    // nothing an operator can re-run. The BullMQ driver below does keep them.
    const queue = new InProcessQueue();
    queue.process("q_dead", () => {
      throw new Error("poison");
    });

    await queue.enqueue({ type: "q_dead", payload: {}, attempts: 1 });
    await new Promise((r) => setTimeout(r, 800));

    assert.deepEqual(
      await queue.getFailed(),
      [],
      "the in-process driver keeps no dead-letter; documented, not asserted as a feature"
    );
    await queue.close();
  });

  it("does not run a job whose type has no handler", async () => {
    const queue = new InProcessQueue();
    await queue.enqueue({ type: "q_unregistered", payload: {} });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(
      await queue.getStats(),
      [],
      "an unroutable job should not appear as processed work"
    );
    await queue.close();
  });
});

describe("BullMQ queue", () => {
  // These tests run against the application's own queue rather than a private
  // `new BullMQQueue(...)`, and that is not a convenience.
  //
  // BullMQ addresses consumers by *queue name*, and this driver uses the single
  // name `"keystone"`. Every consumer on that name competes for the same jobs, so
  // two `BullMQQueue` instances in one process are not two independent queues —
  // they are two halves of one consumer pool, and a job a test enqueues can be
  // delivered to the application's worker, whose handler map knows nothing about
  // the test's job type. That is the same defect the last test below pins, seen
  // from the other side, and it made these two tests pass or fail by which worker
  // happened to win the race. Using the singleton models the deployment: one
  // process, one handler registry, one set of consumers.
  //
  // The type names carry a run id so that repeated runs, and concurrent suites
  // sharing this Redis, cannot collide.
  (redisAvailable ? it : it.skip)("retries a failing job and dead-letters it", async () => {
    const queue = app.container.queue;
    assert.ok(
      queue instanceof BullMQQueue,
      "the provider is forced to `bullmq` at the top of this file; the application did not take it"
    );
    const type = `q_dead_${RUN_ID}`;
    const attempts: number[] = [];
    const jobId = `dead-${RUN_ID}`;

    queue.process(type, () => {
      attempts.push(attempts.length + 1);
      throw new Error("always fails");
    });

    await queue.enqueue({ id: jobId, type, payload: { poison: true }, attempts: 2 });

    assert.ok(
      await waitFor(() => attempts.length >= 2, 20000),
      `expected two attempts, saw ${attempts.length}`
    );

    // And the job is retrievable afterwards, which is the part the in-process
    // driver cannot do: an operator can look at what failed and re-run it.
    const found = await waitFor(async () => (await queue.getFailed(20)).length > 0, 20000);
    assert.ok(found, "a dead-lettered job should be retrievable");
    const failed = (await queue.getFailed(20)).filter((j) => j.id === jobId);
    assert.ok(failed.length > 0, `the failed job ${jobId} was not in the dead-letter list`);
  });

  (redisAvailable ? it : it.skip)("reports stats for work it has seen", async () => {
    const queue = app.container.queue;
    assert.ok(queue instanceof BullMQQueue, "these cases exercise the BullMQ driver");
    const type = `q_stats_${RUN_ID}`;
    let ran = false;
    queue.process(type, () => {
      ran = true;
    });
    await queue.enqueue({ id: `stats-${RUN_ID}`, type, payload: {} });
    assert.ok(await waitFor(() => ran), "the job never ran");
    const stats = await queue.getStats();
    assert.ok(Array.isArray(stats) && stats.length > 0, "getStats returned nothing");
    assert.ok(typeof stats[0].count === "number", "count should be a number");
  });

  (redisAvailable ? it : it.skip)(
    "delivers each job to the handler registered for its type",
    async () => {
      // The regression. `process()` used to create one Worker per job type, and
      // every one of them consumed the same `"keystone"` queue. Consumers are
      // addressed by queue name, so those workers were N competing consumers of
      // one stream rather than N specialized ones: with two types registered,
      // whichever worker won the race ran the job, and it ran it through the
      // handler it had closed over. A `type_a` handler was handed `type_b`
      // payloads, and `type_b`'s own handler sometimes never ran at all — which
      // is how the `workflow_run` handler came to be seen executing with a null
      // run id, and how an enqueued job could be silently consumed by the wrong
      // code path.
      //
      // The observable consequence asserted here is the pair: each handler sees
      // exactly its own type, and both types actually run. Either half alone
      // would pass under the old behaviour.
      const queue = app.container.queue;
      assert.ok(queue instanceof BullMQQueue, "this case exercises the BullMQ driver");

      const typeA = `q_cross_a_${RUN_ID}`;
      const typeB = `q_cross_b_${RUN_ID}`;
      const seenByA: string[] = [];
      const seenByB: string[] = [];
      queue.process(typeA, (job) => {
        seenByA.push(job.type);
      });
      queue.process(typeB, (job) => {
        seenByB.push(job.type);
      });

      await queue.enqueue({ id: `cross-a-${RUN_ID}`, type: typeA, payload: { n: 1 } });
      await queue.enqueue({ id: `cross-b-${RUN_ID}`, type: typeB, payload: { n: 2 } });

      assert.ok(
        await waitFor(() => seenByA.length > 0 && seenByB.length > 0, 20000),
        `both types must run — saw ${JSON.stringify({ seenByA, seenByB })}`
      );
      assert.deepEqual(seenByA, [typeA], "the A handler must only ever see A jobs");
      assert.deepEqual(seenByB, [typeB], "the B handler must only ever see B jobs");
    }
  );

  (redisAvailable ? it : it.skip)(
    "fails a job whose type has no handler instead of completing it",
    async () => {
      // The other half of the same fix, and the reason the dispatch above throws
      // rather than returning. Some instance must own every job on this queue;
      // if none of them has a handler for a job's type, the job is a mismatch or
      // a deploy skew, and both are better surfaced as a failed job an operator
      // can see and re-run than as a completion that quietly discarded the work.
      const queue = app.container.queue;
      assert.ok(queue instanceof BullMQQueue, "this case exercises the BullMQ driver");

      const type = `q_unhandled_${RUN_ID}`;
      const jobId = `unhandled-${RUN_ID}`;
      await queue.enqueue({ id: jobId, type, payload: {}, attempts: 1 });

      const recorded = await waitFor(
        async () => (await queue.getFailed(50)).some((j) => j.id === jobId),
        20000
      );
      assert.ok(recorded, "an unhandled job should be recorded as failed, not dropped");
    }
  );
});

describe("failed-login accounting (SEC-053)", () => {
  beforeEach(async () => {
    if (!redisAvailable) return;
    // Nothing global to clear: every key in these tests is namespaced by a run
    // id or a user id created inside the test.
  });

  (redisAvailable ? it : it.skip)("records exactly one anomaly entry per failed login", async () => {
    // Measured before the fix: 2, 4, 6, 8, 9, 10 across six real failed logins.
    // The threshold is 10, so the spray signal fired at five real attempts.
    const [user] = await db
      .insert(users)
      .values({
        email: `queue-${RUN_ID}@example.test`,
        username: `queue${RUN_ID}`.slice(0, 32),
        name: "queue",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    createdUserIds.push(user.id);

    await redis.del(`anomaly:failed_login:${user.id}`);

    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/token-login",
        payload: { email: user.email, password: "wrong-on-purpose" },
      });
      assert.ok(res.statusCode >= 400, `attempt ${attempt} should have failed`);
      // The subscriber is async, so the count settles a moment after the response.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(
        await countFailedLogins(user.id),
        attempt,
        `after ${attempt} real failed login(s) the anomaly count should be ${attempt}`
      );
    }
  });

  (redisAvailable ? it : it.skip)("does not record anything for a successful login", async () => {
    const [user] = await db
      .insert(users)
      .values({
        email: `queue-ok-${RUN_ID}@example.test`,
        username: `queueok${RUN_ID}`.slice(0, 32),
        name: "queue ok",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    createdUserIds.push(user.id);
    await redis.del(`anomaly:failed_login:${user.id}`);

    const res = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: PASSWORD },
    });
    assert.equal(res.statusCode, 200, res.body);
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(
      await countFailedLogins(user.id),
      0,
      "a successful sign-in must leave the failed-login count at zero"
    );
  });

  (redisAvailable ? it : it.skip)("counting does not itself count", async () => {
    // The structural cause. `isFailedLoginAnomaly` used to call the recorder to
    // get its answer, so asking the question was itself evidence — a predicate
    // that mutates the thing it measures. Pinned directly so the split between
    // `recordFailedLogin` and `countFailedLogins` cannot quietly collapse again.
    const identifier = `predicate-${RUN_ID}`;
    await redis.del(`anomaly:failed_login:${identifier}`);

    await recordFailedLogin(identifier);
    const afterFirstRecord = await countFailedLogins(identifier);
    for (let i = 0; i < 5; i++) await countFailedLogins(identifier);

    assert.equal(
      await countFailedLogins(identifier),
      afterFirstRecord,
      "reading the count five times must not add five entries"
    );
  });
});
