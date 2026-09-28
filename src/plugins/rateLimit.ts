import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { redis } from "../services/redis.js";
import { clientAddress } from "../services/trustedProxies.js";
import { localRateLimit } from "../services/localRateLimit.js";
import { emit } from "../services/events/bus.js";

interface RateLimitPluginOptions {
  keyPrefix: string;
  maxAttempts: number;
  windowSeconds: number;
  /**
   * Override how the caller is identified. Used where the meaningful principal
   * is not an IP address — for example SCIM, which is limited per credential so
   * one noisy identity provider cannot exhaust the budget of every other tenant.
   */
  keyFrom?: (request: FastifyRequest) => string;
  /**
   * Whether the submitted address is part of the key.
   *
   * The key is the control, so it is worth being explicit about. This used to be
   * unconditional — every limiter's key was `prefix:identifier:body.email` — and
   * that silently gave every limiter the same shape regardless of what it was
   * written to do. `login-per-address` is the case that matters: it exists to bound
   * *spraying*, and the comment next to it says so, but because the submitted
   * address was appended it was keyed on address **and** account, so an attacker
   * varying the address on each attempt got a fresh budget every time and the
   * control bounded nothing. See SEC-048.
   *
   * Defaults to `true` so no existing limiter's behaviour moves; set it to `false`
   * where the budget is meant to be per address alone.
   */
  includeSubmittedAddress?: boolean;
  /**
   * Hold a local in-process budget while Redis is unavailable.
   *
   * Set this on endpoints where unlimited attempts are dangerous — anything that
   * authenticates. It is weaker than the distributed limiter, because a client
   * gets one budget per instance, but it is bounded, whereas failing open is not.
   */
  emergencyLocalLimit?: boolean;
}

export interface GlobalRateLimitOptions {
  maxRequests?: number;
  windowSeconds?: number;
  keyPrefix?: string;
}

/**
 * Atomic sliding-window rate limit script.
 *
 * Returns the number of requests already seen in the current window *before*
 * recording the current request. The request is only recorded when the count
 * is still below the limit, so blocked requests do not pollute the window.
 */
const slidingWindowLua = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local member = ARGV[3]
local maxAttempts = tonumber(ARGV[4])
local windowStart = now - windowMs

redis.call("zremrangebyscore", key, 0, windowStart)
local count = redis.call("zcard", key)
if count >= maxAttempts then
  return count
end

redis.call("zadd", key, now, member)
redis.call("pexpire", key, windowMs)
return count
`;

/**
 * Result of a limit check, including which limiter decided it.
 *
 * The distinction matters to an operator reading a rate-limit event: "we limited
 * this in Redis" and "we limited this in one process because Redis was down" call
 * for different responses.
 */
type LimitDecision = { allowed: boolean; limiter: "redis" | "local" | "none"; retryAfterSeconds?: number };

/**
 * The local fallback, for when Redis genuinely cannot be reached.
 *
 * Failing open removes the control exactly when an attacker would most like it
 * gone, so sensitive endpoints fall back to a bounded in-process budget instead.
 */
function localDecision(
  key: string,
  maxAttempts: number,
  windowSeconds: number,
  useEmergencyLocal: boolean
): LimitDecision {
  if (!useEmergencyLocal) return { allowed: true, limiter: "none" };
  const result = localRateLimit(key, maxAttempts, windowSeconds);
  return result.allowed
    ? { allowed: true, limiter: "local" }
    : { allowed: false, limiter: "local", retryAfterSeconds: result.retryAfterSeconds };
}

async function checkLimit(
  key: string,
  maxAttempts: number,
  windowSeconds: number,
  useEmergencyLocal: boolean
): Promise<LimitDecision> {
  // No readiness check before the command, and the reason is worth recording.
  //
  // The shared client is created with `lazyConnect`, so on a fresh process its
  // status is `"wait"` — and `isRedisReady()` is false. A guard here therefore
  // returned the local budget *without ever issuing a command*, so the client
  // stayed lazy, so the next request made the same decision, and the distributed
  // limiter never activated at all. Whether rate limiting was shared across the
  // fleet depended on whether some unrelated code path — the queue, anomaly
  // detection — happened to touch Redis first. In a deployment where nothing did,
  // every instance limited independently, which is the exact weakness the
  // distributed limiter exists to remove.
  //
  // A lazily-connecting client connects on its first command, so the command is
  // simply attempted. A real outage rejects, the catch runs, and the local
  // budget applies — which is the behaviour that was wanted, arrived at with one
  // fewer branch and no guess about the client's state.
  try {
    const now = Date.now();
    const member = `${now}:${cryptoRandom()}`;
    const count = (await redis.eval(
      slidingWindowLua,
      1,
      key,
      windowSeconds * 1000,
      now,
      member,
      maxAttempts
    )) as number;
    return {
      allowed: count < maxAttempts,
      limiter: "redis",
      retryAfterSeconds: windowSeconds,
    };
  } catch {
    // A Redis error is the same situation as Redis being down, which is the only
    // thing that should reach the local budget.
    return localDecision(key, maxAttempts, windowSeconds, useEmergencyLocal);
  }
}

/** Kept for callers that only need a yes/no, such as a pre-authentication budget. */
async function isAllowed(key: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
  const decision = await checkLimit(key, maxAttempts, windowSeconds, false);
  return decision.allowed;
}

function cryptoRandom(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Rate-limit key source. Uses the peer address unless the request came from a
 * configured trusted proxy, so a client cannot rotate `x-forwarded-for` to get a
 * fresh budget.
 */
function clientIdentifier(request: FastifyRequest): string {
  return clientAddress(request);
}

/**
 * Re-exported so a route that must run before the normal limiter (because it
 * emits audit events on failure) can still budget itself rather than being
 * unbounded.
 */
export { clientAddress };

/** Raw sliding-window check, for the same pre-limiter case. */
export { isAllowed };

/**
 * Report a refused request.
 *
 * A rate-limit trip used to leave no trace at all: the request was answered with
 * a 429 and nothing was recorded. An operator therefore could not distinguish
 * ordinary traffic from a sustained brute-force attempt against `login` or
 * `mfa-verify` — the requests that most warrant attention were the only ones
 * invisible in the log.
 *
 * `limiter` is included because "limited in Redis" and "limited in one process
 * because Redis was down" call for different responses, and conflating them would
 * hide a degraded control.
 */
async function reportLimited(
  request: FastifyRequest,
  options: { keyPrefix: string; maxAttempts: number; windowSeconds: number },
  decision: LimitDecision
): Promise<void> {
  try {
    await emit({
      type: "rate_limit_triggered",
      payload: {
        keyPrefix: options.keyPrefix,
        clientAddress: clientIdentifier(request),
        maxAttempts: options.maxAttempts,
        windowSeconds: options.windowSeconds,
        limiter: decision.limiter,
        requestId: request.id,
        method: request.method,
        path: request.url,
      },
    });
  } catch {
    // A monitoring failure must not turn a 429 into a 500.
  }
}

export function rateLimit(options: RateLimitPluginOptions) {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply) {
    const id = options.keyFrom ? options.keyFrom(request) : clientIdentifier(request);
    const subject =
      options.includeSubmittedAddress === false
        ? ""
        : `${(request.body as Record<string, string> | undefined)?.email ?? ""}`;
    const key = `${options.keyPrefix}:${id}:${subject}`;
    const decision = await checkLimit(
      key,
      options.maxAttempts,
      options.windowSeconds,
      options.emergencyLocalLimit === true
    );
    if (!decision.allowed) {
      await reportLimited(request, options, decision);
      return reply
        .header("Retry-After", String(decision.retryAfterSeconds ?? options.windowSeconds))
        .status(429)
        .send({ error: "Too many attempts. Please try again later." });
    }
  };
}

export function globalRateLimit(options: GlobalRateLimitOptions = {}) {
  const maxRequests = options.maxRequests ?? 100;
  const windowSeconds = options.windowSeconds ?? 60;
  const keyPrefix = options.keyPrefix ?? "global";

  return async function onRequest(request: FastifyRequest, reply: FastifyReply) {
    const id = clientIdentifier(request);
    const key = `${keyPrefix}:${id}`;
    const decision = await checkLimit(key, maxRequests, windowSeconds, false);
    if (!decision.allowed) {
      await reportLimited(request, { keyPrefix, maxAttempts: maxRequests, windowSeconds }, decision);
      return reply
        .header("Retry-After", String(decision.retryAfterSeconds ?? windowSeconds))
        .status(429)
        .send({ error: "Rate limit exceeded. Please slow down." });
    }
  };
}
