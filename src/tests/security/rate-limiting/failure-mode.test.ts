import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyReply, FastifyRequest } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "rate-limit-failure-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

interface FakeReply {
  reply: FastifyReply;
  /** The live state — read it *after* awaiting the guard; the value mutates. */
  state: { statusCode: number; headers: Record<string, string> };
}

/** A request shaped like the ones the login limiter sees. */
function request(): FastifyRequest {
  return {
    id: "failure-mode-request",
    method: "POST",
    url: "/auth/login",
    body: { email: "someone@example.test" },
    headers: {},
    ip: "203.0.113.7",
    socket: { remoteAddress: "203.0.113.7" },
  } as unknown as FastifyRequest;
}

function fakeReply(): FakeReply {
  const state = { statusCode: 200, headers: {} as Record<string, string> };
  const reply = {
    header(name: string, value: string) {
      state.headers[name] = value;
      return reply;
    },
    status(code: number) {
      state.statusCode = code;
      return reply;
    },
    send() {
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

/**
 * §1.3 — what a sensitive endpoint does when Redis is gone.
 *
 * The distributed limiter is the real control, and it lives in Redis. A limiter
 * without a fallback failed *open* when Redis was unreachable — losing the
 * control exactly when an attacker most wants it gone. An endpoint that
 * authenticates carries `emergencyLocalLimit`, which answers from a bounded
 * per-process budget instead.
 *
 * These cases disconnect the shared client and drive the real preHandler, because
 * the property under test is what the endpoint *does*: a test of the local counter
 * alone would stay green if the plugin stopped consulting it.
 */
describe("a sensitive endpoint stays rate-limited while Redis is down (§1.3)", () => {
  let guard: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  let redis: { disconnect: () => void };
  let resetLocalRateLimits: () => void;
  let localRateLimitSize: () => number;
  /**
   * Kept as the module rather than as two counters: `Counter.get()` resolves the
   * metric's own label types, and re-declaring that shape here only creates
   * something for the two to disagree about.
   */
  let metrics: typeof import("../../../plugins/operationalMetrics.js");

  const PREFIX = "failure-mode-test";
  const LIMIT = 2;

  before(async () => {
    const rateLimitModule = await import("../../../plugins/rateLimit.js");
    const local = await import("../../../services/localRateLimit.js");
    const shared = await import("../../../services/redis.js");
    metrics = await import("../../../plugins/operationalMetrics.js");

    resetLocalRateLimits = local.resetLocalRateLimits;
    localRateLimitSize = local.localRateLimitSize;
    redis = shared.redis as unknown as typeof redis;

    guard = rateLimitModule.rateLimit({
      keyPrefix: PREFIX,
      maxAttempts: LIMIT,
      windowSeconds: 60,
      // The setting that distinguishes an endpoint worth protecting from one
      // where a Redis outage means an unbounded endpoint.
      emergencyLocalLimit: true,
    }) as unknown as typeof guard;

    // The precondition: every command on this client now rejects, which is the
    // state `checkLimit`'s catch is written for.
    redis.disconnect();

    // Exercise the failure path once, so the metric assertions below have
    // something to read regardless of the order the cases run in.
    resetLocalRateLimits();
    await guard(request(), fakeReply().reply);
  });

  after(() => {
    redis.disconnect();
  });

  it("refuses once the bounded local budget is spent, rather than allowing without limit", async () => {
    resetLocalRateLimits();

    for (let attempt = 1; attempt <= LIMIT; attempt++) {
      const { reply, state } = fakeReply();
      await guard(request(), reply);
      assert.equal(state.statusCode, 200, `attempt ${attempt} of ${LIMIT} is inside the budget`);
    }

    const { reply, state } = fakeReply();
    await guard(request(), reply);

    assert.equal(
      state.statusCode,
      429,
      "with Redis down the endpoint must still refuse past its budget; failing open is the defect"
    );
    assert.ok(state.headers["Retry-After"], "a refusal must tell the client when to retry");
  });

  it("does not escalate the budget on repeated Redis failures", async () => {
    // Each request is still a *counted* request. If a Redis error reset the local
    // window — or skipped recording — the budget would widen with every failed
    // check, which is the failure mode wearing the fix's clothes.
    const before = localRateLimitSize();
    for (let i = 0; i < 10; i++) {
      await guard(request(), fakeReply().reply);
    }
    assert.equal(localRateLimitSize(), before, "the fallback must not mint a new window per failed request");

    const { reply, state } = fakeReply();
    await guard(request(), reply);
    assert.equal(state.statusCode, 429, "ten further requests must not have bought a fresh budget");
  });

  it("counts the Redis failure, so an operator can see the limiter degraded", async () => {
    const values = (await metrics.rateLimitRedisErrors.get()).values.filter((v) => v.labels.key_prefix === PREFIX);
    assert.ok(
      values.some((v) => v.value > 0),
      "keystone_rate_limit_redis_errors_total must move when Redis is unreachable"
    );
  });

  it("counts the fallback engaging, which is the signal that limits are per-process", async () => {
    const values = (await metrics.emergencyLocalLimiter.get()).values.filter((v) => v.labels.key_prefix === PREFIX);
    assert.ok(
      values.some((v) => v.value > 0),
      "keystone_emergency_local_limiter_total must move when the fallback answers"
    );
  });
});

describe("the local fallback itself is bounded (§1.3)", () => {
  it("tracks a bounded number of keys, so rotating addresses cannot grow it without limit", async () => {
    const local = await import("../../../services/localRateLimit.js");
    local.resetLocalRateLimits();

    // One more key than the cap allows, each with a long window so nothing is
    // swept as merely expired. An unbounded map keyed by client address is itself
    // a denial-of-service vector: the attacker supplies the keys.
    for (let i = 0; i < 10_050; i++) {
      local.localRateLimit(`flood-${i}`, 5, 3600);
    }

    assert.ok(
      local.localRateLimitSize() <= 10_000,
      `the store must stay capped, saw ${local.localRateLimitSize()} entries`
    );
    local.resetLocalRateLimits();
  });

  it("never grants more than the configured budget within one window", async () => {
    const local = await import("../../../services/localRateLimit.js");
    local.resetLocalRateLimits();

    const key = "budget-check";
    const allowed = Array.from({ length: 5 }, () => local.localRateLimit(key, 3, 60)).filter((r) => r.allowed);
    assert.equal(allowed.length, 3, "exactly the budget is allowed, and no more");
    local.resetLocalRateLimits();
  });
});
