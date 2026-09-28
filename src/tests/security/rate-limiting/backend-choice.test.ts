import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";

/**
 * The distributed rate limiter is the primary control, and it was never running.
 *
 * `src/plugins/rateLimit.ts` opened with
 *
 *     if (!isRedisReady()) return localDecision(...);
 *
 * The shared client is created with `lazyConnect`, so on a fresh process its
 * status is `"wait"` and `isRedisReady()` is false. The guard therefore returned
 * the in-process budget **without ever issuing a command**, so the client stayed
 * lazy, so the next request reached the same verdict, and the Redis limiter was
 * never reached — on any request, ever, unless some unrelated code path happened
 * to touch Redis first.
 *
 * Whether rate limiting was shared across a fleet therefore depended on whether
 * the queue, or anomaly detection, or (after 3.2.0) the permission cache ran
 * before the first rate-limited request. That is the specific weakness the
 * distributed limiter exists to remove: a client that multiplies its budget by the
 * number of instances.
 *
 * This was found because the permission cache started issuing a command on the
 * same client, which connected it, which switched the limiter from per-process to
 * shared — and a test suite's aggregate request count then exceeded the shared
 * budget. The fix is to attempt the command and let a real failure select the
 * local path. These tests pin both halves of that.
 */

/**
 * A client that is connectable but not yet connected — exactly the state the
 * shared client is in on a fresh process, and the state the guard mistook for
 * "unavailable".
 */
function lazyButWorkingRedis(): Redis {
  return new Redis(process.env.REDIS_URL || "redis://localhost:6379", { lazyConnect: true });
}

describe("choosing a rate-limit backend", () => {
  it("treats an unconnected-but-connectable client as available", async () => {
    // A bare `ioredis` with lazyConnect: the status is "wait", and every command
    // works, because the command is what connects it.
    const client = lazyButWorkingRedis();
    try {
      assert.equal(
        client.status,
        "wait",
        "the precondition this test depends on: the client has not connected yet"
      );
      // This is the call the guard skipped.
      const reply = await client.get("rate-limit-backend-probe");
      assert.equal(reply, null, "an unconnected client still answers a command");
      assert.notEqual(client.status, "wait", "and it is connected afterwards");
    } finally {
      await client.quit().catch(() => client.disconnect());
    }
  });

  it("still refuses a command from a client that cannot connect", async () => {
    // The other half. If the command always "works", the local fallback is
    // unreachable and losing Redis silently removes the limiter everywhere —
    // which is the failure mode the emergency local limit was added to prevent.
    const unreachable = lazyButWorkingRedis();
    unreachable.disconnect();
    try {
      await assert.rejects(
        () => unreachable.get("rate-limit-backend-probe"),
        "a disconnected client must reject, so checkLimit can select the local path"
      );
    } finally {
      unreachable.disconnect();
    }
  });
});

describe("the emergency local limit", () => {
  let isAllowed: (key: string, max: number, window: number) => Promise<boolean>;
  let resetLocalRateLimits: () => void;
  let localRateLimitSize: () => number;
  let redisStatus: () => string;

  before(async () => {
    const rateLimit = await import("../../../plugins/rateLimit.js");
    isAllowed = rateLimit.isAllowed;
    const local = await import("../../../services/localRateLimit.js");
    resetLocalRateLimits = local.resetLocalRateLimits;
    localRateLimitSize = local.localRateLimitSize;
    const shared = await import("../../../services/redis.js");
    redisStatus = () => shared.redis.status;
  });

  after(async () => {
    const { redis } = await import("../../../services/redis.js");
    await redis.quit().catch(() => redis.disconnect());
  });

  it("uses Redis when Redis works, and says so", async () => {
    resetLocalRateLimits();
    // A budget no request in this file can exhaust, so the decision is about which
    // backend answered rather than about the number.
    const allowed = await isAllowed(`backend-choice-${crypto.randomUUID()}`, 1000, 60);

    assert.equal(allowed, true, "a first request inside the budget is allowed");
    assert.notEqual(
      redisStatus(),
      "wait",
      "issuing the command must have connected the shared client, which is the " +
        "whole point: the readiness guard meant it never did"
    );
    assert.equal(
      localRateLimitSize(),
      0,
      "with Redis reachable, nothing should have been counted against the " +
        "in-process budget"
    );
  });

  it("shares one budget across 'instances', which is what the limiter is for", async () => {
    resetLocalRateLimits();
    const key = `shared-budget-${crypto.randomUUID()}`;

    // The first "instance" spends the budget.
    for (let i = 0; i < 3; i++) {
      assert.equal(await isAllowed(key, 3, 60), true, `attempt ${i + 1} of 3 is inside budget`);
    }
    assert.equal(await isAllowed(key, 3, 60), false, "the fourth exceeds it");

    // A second "instance" is a separate process, so its own in-process window
    // would be empty and it would allow the request. With the budget in Redis the
    // second instance sees the first instance's spending — which is the property
    // that stops a client multiplying its budget across a fleet.
    assert.equal(
      localRateLimitSize(),
      0,
      "the refusal came from Redis, not from this process's local window"
    );
  });

  it("counts a different key against a different budget", async () => {
    resetLocalRateLimits();
    const suffix = crypto.randomUUID();
    for (let i = 0; i < 2; i++) await isAllowed(`budget-a-${suffix}`, 2, 60);
    assert.equal(await isAllowed(`budget-a-${suffix}`, 2, 60), false, "a is exhausted");
    assert.equal(await isAllowed(`budget-b-${suffix}`, 2, 60), true, "b is untouched");
  });
});
