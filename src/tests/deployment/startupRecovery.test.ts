import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
// Keep the process off a real BullMQ connection: this suite drives recovery with
// fakes, and the module-level queue is constructed at import time.
process.env.KEYSTONE_QUEUE_PROVIDER = "in-process";

const {
  getStartupRecoveryReport,
  resetStartupRecoveryForTests,
  runStartupRecovery,
} = await import("../../services/startup-recovery.js");

/**
 * §6.4. Recovery was partly present — the webhook sweep existed — but its result
 * was only logged by the webhook service and nothing could answer "what did this
 * instance find when it booted?" afterwards. These tests pin the report, and the
 * safety rule that matters: a lock *with* a TTL is never stolen.
 */

beforeEach(() => resetStartupRecoveryForTests());

describe("startup recovery", () => {
  it("reports what a previous instance left behind", async () => {
    const released: string[] = [];
    const report = await runStartupRecovery({
      queue: {
        provider: "in-process",
        getStats: async () => [
          { type: "email", count: 3, failed: 1, delayed: 2 },
          { type: "webhook-delivery", count: 2, failed: 0, delayed: 0 },
        ],
      },
      reclaimStaleDeliveries: async () => 7,
      reenqueuePendingDeliveries: async () => 2,
      scanLocks: async () => [
        { key: "keystone:lock:a", workerId: "w1", ttlMs: 30_000 },
        { key: "keystone:lock:b", workerId: "w2", ttlMs: 0 },
      ],
      releaseOrphanedLocks: async () => {
        released.push("keystone:lock:b");
        return 1;
      },
    });

    assert.equal(report.reclaimedDeliveries, 7);
    assert.equal(report.reenqueuedDeliveries, 2);
    assert.deepEqual(report.queue, {
      provider: "in-process",
      backlog: 5,
      failed: 1,
      delayed: 2,
    });
    assert.deepEqual(report.locks, { scanned: 2, withoutExpiry: 1, released: 1 });
    assert.deepEqual(released, ["keystone:lock:b"]);
    assert.ok(report.durationMs >= 0);
    assert.notEqual(report.finishedAt, "");
  });

  it("does not touch a lock that still has a TTL", async () => {
    let releaseCalls = 0;
    const report = await runStartupRecovery({
      queue: { provider: "in-process", getStats: async () => [] },
      reclaimStaleDeliveries: async () => 0,
      reenqueuePendingDeliveries: async () => 0,
      scanLocks: async () => [{ key: "keystone:lock:live", workerId: "w1", ttlMs: 12_000 }],
      releaseOrphanedLocks: async () => {
        releaseCalls += 1;
        return 0;
      },
    });

    // A TTL lock may belong to a live instance that is merely slow. Stealing it is
    // the double-holder race `services/lock.ts` exists to prevent.
    assert.equal(releaseCalls, 0, "a lock with a TTL must never be released at boot");
    assert.equal(report.locks.withoutExpiry, 0);
    assert.equal(report.locks.released, 0);
  });

  it("survives a dependency that fails and still reports the rest", async () => {
    const report = await runStartupRecovery({
      queue: {
        provider: "bullmq",
        getStats: async () => {
          throw new Error("redis unreachable");
        },
      },
      reclaimStaleDeliveries: async () => {
        throw new Error("database unreachable");
      },
      reenqueuePendingDeliveries: async () => {
        throw new Error("database unreachable");
      },
      scanLocks: async () => {
        throw new Error("redis unreachable");
      },
      releaseOrphanedLocks: async () => 0,
    });

    // Booting degraded is how an operator gets to see the failure, so a recovery
    // failure is recorded rather than thrown.
    assert.equal(report.reclaimedDeliveries, null);
    assert.equal(report.queue.error, "queue statistics unavailable");
    assert.equal(report.locks.error, "lock scan unavailable");
    assert.equal(report.queue.backlog, null);
  });

  it("keeps the last report for diagnostics", async () => {
    assert.equal(getStartupRecoveryReport(), null);
    await runStartupRecovery({
      queue: { provider: "in-process", getStats: async () => [] },
      reclaimStaleDeliveries: async () => 0,
      reenqueuePendingDeliveries: async () => 0,
      scanLocks: async () => [],
      releaseOrphanedLocks: async () => 0,
    });
    assert.ok(getStartupRecoveryReport());
  });
});
