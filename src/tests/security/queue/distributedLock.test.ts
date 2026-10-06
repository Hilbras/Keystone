import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "lock-test";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

const { redis } = await import("../../../services/redis.js");
const {
  acquireLock,
  releaseLock,
  renewLock,
  inspectLock,
  withLock,
  DEFAULT_LOCK_TTL_MS,
} = await import("../../../services/lock.js");

/**
 * §2.4 — a distributed lock.
 *
 * The property that matters is **not** "two callers cannot both acquire", which
 * `SET NX` gives for free. It is the one that makes a lock safe to build anything on:
 *
 * > a holder whose lease has expired **cannot release or renew a lock another caller
 * > now holds**.
 *
 * Without ownership verification, `SET NX PX` plus a plain `DEL` produces this:
 *
 * ```text
 * A acquires with a 5s TTL, then pauses 6s (GC, a slow downstream).
 * The lease expires; B acquires.
 * A finishes and DELs — deleting B's lock.
 * Now two callers believe they hold it, and nothing reports it.
 * ```
 *
 * That is not a race that shows up in a test suite; it is a race that shows up in
 * production, under load, as an intermittent double-execution that nobody can
 * reproduce. So it is asserted deliberately here by simulating the expiry.
 */
describe("distributed lock ownership (SEC-084, §2.4)", () => {
  const key = (suffix: string) => `keystone:test-lock:${suffix}`;

  beforeEach(async () => {
    // Only this suite's keys — `flushdb` would race the rest of the suite.
    const keys = await redis.keys("keystone:test-lock:*");
    if (keys.length > 0) await redis.del(...keys);
  });

  after(async () => {
    const keys = await redis.keys("keystone:test-lock:*");
    if (keys.length > 0) await redis.del(...keys);
    const { closeDb } = await import("../../../db/index.js");
    await closeDb().catch(() => {});
  });

  it("grants the lock to exactly one of several concurrent callers", async () => {
    const k = key("contended");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => acquireLock(k))
    );
    const held = results.filter((r) => r !== null);
    assert.equal(held.length, 1, `exactly one caller may hold the lock, got ${held.length}`);
    assert.ok(await releaseLock(held[0]!), "the winner must be able to release");
  });

  it("a second caller is refused while the first holds it", async () => {
    const k = key("exclusive");
    const first = await acquireLock(k);
    assert.ok(first, "the first caller must acquire");
    assert.equal(await acquireLock(k), null, "the second must be refused");
    await releaseLock(first!);
    const after = await acquireLock(k);
    assert.ok(after, "and must acquire once released");
    await releaseLock(after!);
  });

  describe("ownership verification", () => {
    it("a holder whose lease expired cannot release the new holder's lock", async () => {
      // **The case the whole module exists for.** A's lease is given 1ms so it is
      // certainly gone by the time A releases; B acquires in the gap; A's release
      // must be refused and must leave B holding.
      const k = key("stale-release");

      const a = await acquireLock(k, { ttlMs: 1 });
      assert.ok(a, "A must acquire");

      // Wait past A's lease.
      await new Promise((r) => setTimeout(r, 60));

      const b = await acquireLock(k, { ttlMs: 5_000 });
      assert.ok(b, "B must acquire the expired lease");
      assert.notEqual(a!.token, b!.token, "each acquisition needs its own token");

      const releasedByA = await releaseLock(a!);
      assert.equal(releasedByA, false, "A must NOT be able to delete B's lock");

      // B must still hold it, and a third caller must still be refused.
      const state = await inspectLock(k);
      assert.ok(state?.held, "B's lock must survive A's release");
      assert.equal(state!.workerId, b!.workerId, "and it must still name B");
      assert.equal(await acquireLock(k), null, "a third caller must still be refused");
    });

    it("a holder whose lease expired cannot renew the new holder's lock", async () => {
      const k = key("stale-renew");
      const a = await acquireLock(k, { ttlMs: 1 });
      assert.ok(a);
      await new Promise((r) => setTimeout(r, 60));
      const b = await acquireLock(k, { ttlMs: 5_000 });
      assert.ok(b);

      assert.equal(await renewLock(a!), false, "A must NOT be able to extend B's lease");

      // B's lease must be untouched — still short, not extended to A's value.
      const before = await redis.pttl(k);
      const bState = await inspectLock(k);
      assert.ok(bState?.held);
      assert.ok(before > 0 && before <= 5_000, `B's TTL must be B's, got ${before}`);
    });

    it("a forged token cannot release the lock", async () => {
      const k = key("forged");
      const real = await acquireLock(k);
      assert.ok(real);

      const forged = { ...real!, token: "0".repeat(32) };
      assert.equal(await releaseLock(forged), false, "a wrong token must be refused");
      assert.ok((await inspectLock(k))?.held, "and the real lock must survive");
      assert.ok(await releaseLock(real!));
    });

    it("a handle for a different key cannot release this one", async () => {
      const mine = key("mine");
      const theirs = key("theirs");
      const a = await acquireLock(mine);
      const b = await acquireLock(theirs);
      assert.ok(a && b);
      assert.equal(await releaseLock({ ...a!, key: theirs }), false);
      assert.ok((await inspectLock(theirs))?.held, "B's lock must be untouched");
      await releaseLock(a!);
      await releaseLock(b!);
    });
  });

  it("renews a lease it still holds, extending the expiry", async () => {
    const k = key("renew");
    const h = await acquireLock(k, { ttlMs: 400 });
    assert.ok(h);
    const first = await redis.pttl(k);
    assert.ok(first <= 400 && first > 0, `expected <=400ms, got ${first}`);

    assert.equal(await renewLock(h!, 5_000), true, "the holder must be able to renew");
    const after = await redis.pttl(k);
    assert.ok(after > 400, `the lease must have grown, got ${after}ms`);
    await releaseLock(h!);
  });

  it("withLock releases even when the body throws", async () => {
    const k = key("finally");
    await assert.rejects(
      withLock(k, async () => {
        throw new Error("boom");
      }),
      /boom/
    );
    assert.equal(await inspectLock(k), null, "a throw must not leave the lock held");
  });

  it("withLock reports non-acquisition rather than running the body", async () => {
    const k = key("busy");
    const held = await acquireLock(k);
    assert.ok(held);
    let ran = false;
    const result = await withLock(k, async () => {
      ran = true;
      return "value";
    });
    assert.equal(result.acquired, false);
    assert.equal(ran, false, "the body must not run without the lock");
    assert.equal(result.value, undefined, "and no value may be reported");
    await releaseLock(held!);
  });

  it("withLock releases on the success path too", async () => {
    const k = key("success");
    const result = await withLock(k, async () => "done");
    assert.equal(result.acquired, true);
    assert.equal(result.value, "done");
    assert.equal(await inspectLock(k), null);
  });

  it("waits for a contended lock when asked, and gives up after the wait", async () => {
    const k = key("wait");
    const held = await acquireLock(k);
    assert.ok(held);

    // Zero wait: immediate refusal.
    const immediate = await withLock(k, async () => "no", { waitMs: 0 });
    assert.equal(immediate.acquired, false);

    // Short wait: still refused, but it actually polled.
    const waited = await withLock(k, async () => "no", { waitMs: 120, pollMs: 10 });
    assert.equal(waited.acquired, false, "must give up once the wait elapses");

    await releaseLock(held!);
    const now = await withLock(k, async () => "yes", { waitMs: 50 });
    assert.equal(now.acquired, true, "and acquire once the holder is gone");
  });

  it("waitMs: 0 does not poll at all", async () => {
    // A regression guard on the loop: `waitMs <= 0` must return on the first
    // refusal. If it fell through to the sleep, `acquireLock` on a busy key would
    // block for `pollMs` on every call — which on a hot path is a latency bug that
    // looks like nothing.
    const k = key("no-poll");
    const held = await acquireLock(k);
    assert.ok(held);
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) await acquireLock(k, { waitMs: 0, pollMs: 50 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 400, `20 uncontended waitMs:0 calls took ${elapsed}ms — it is polling`);
    await releaseLock(held!);
  });

  it("names the holder, and reports an unheld lock as null", async () => {
    const k = key("inspect");
    assert.equal(await inspectLock(k), null, "an unheld lock must read as null");

    const h = await acquireLock(k);
    const state = await inspectLock(k);
    assert.ok(state?.held);
    assert.equal(state.workerId, h!.workerId, "the holder must be identifiable");
    assert.ok((state.ttlMs ?? 0) > 0, "a held lock must report a live lease");
    assert.ok(state.ttlMs! <= DEFAULT_LOCK_TTL_MS, "and no more than its lease");

    await releaseLock(h!);
    assert.equal(await inspectLock(k), null);
  });

  it("a value this module did not write cannot be released or inspected as ours", async () => {
    // Hand-set keys and format changes must not be treated as ours, or a stale
    // handle could delete a key it never owned.
    const k = key("foreign");
    await redis.set(k, "someone-elses-value", "PX", 5_000);
    assert.equal(await releaseLock({ key: k, token: "x", workerId: "w", acquiredAt: new Date(), ttlMs: 100 }), false);
    const state = await inspectLock(k);
    assert.ok(state?.held, "the key exists, so it is held by something");
    assert.equal(state.workerId, undefined, "but the holder must not be invented");
    await redis.del(k);
  });

  it("uses a TTL in milliseconds, not seconds", async () => {
    // `EX` takes seconds, so a sub-second lease would round up to a full second —
    // four hundred times longer than asked for.
    const k = key("px");
    await redis.del(k);
    const h = await acquireLock(k, { ttlMs: 250 });
    assert.ok(h);
    const ttl = await redis.pttl(k);
    assert.ok(ttl > 0 && ttl <= 250, `lease must respect 250ms, got ${ttl}ms`);
    await releaseLock(h!);
  });

  it("two acquisitions by one worker get different tokens", async () => {
    // If the token were the worker id, releasing the first would be permitted
    // while the second still held it — the exact bug ownership verification exists
    // to prevent, reintroduced at the source.
    const k = key("token");
    const first = await acquireLock(k);
    await releaseLock(first!);
    const second = await acquireLock(k);
    assert.notEqual(first!.token, second!.token, "each acquisition needs a fresh token");
    assert.equal(first!.workerId, second!.workerId, "the worker is the same, the token is not");
    await releaseLock(second!);
  });
});