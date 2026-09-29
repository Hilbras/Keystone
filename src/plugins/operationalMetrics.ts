import { Counter, Gauge, Histogram } from "prom-client";

/**
 * The metrics an operator needs at 3am.
 *
 * `plugins/metrics.ts` answers "is the server being used and is it fast". This
 * answers "is the platform working", and the difference is the set of series that
 * only move when something is wrong.
 *
 * **The one that matters most is `emergency_local_limiter_total`.** The global and
 * per-endpoint rate limiters run on Redis so the budget is shared across the
 * fleet. When Redis is unavailable they fall back to a per-process budget — and
 * before this module existed, that fallback was **completely silent**: a `catch`
 * returned a local decision with no counter, no log line, and no event. So a
 * deployment could be running on per-process limits, with every instance
 * budgeting independently, and nothing said so. That is the exact weakness the
 * distributed limiter exists to remove, and it activated with no signal at all.
 *
 * A counter of refusals would not have caught it either: under per-process limits
 * the *refusal* rate looks normal, because each instance is still enforcing a
 * budget. Only the fallback engaging is anomalous, and that was the thing with no
 * counter.
 *
 * Every series here is registered in this file and incremented at the chokepoint
 * that already exists, so the cost is a counter increment on a path that was
 * already doing the work. `src/tests/integration/operationalMetrics.test.ts`
 * asserts each one moves on a real request, because a counter that is registered
 * and never incremented exports as a series of zeros — which on a dashboard is
 * indistinguishable from a counter that should read zero. That is not
 * hypothetical: `keystone_failed_logins_total` was exactly that state until 3.4.0.
 */

/**
 * Whether each dependency is answering, as reported by `/ready`.
 *
 * A gauge rather than a counter, because the question is "is it up now" and a
 * counter cannot answer it. `1` is healthy, `0` is not, so a dashboard reads it as
 * a health column instead of a graph, and an alert is `== 0 for 2m` rather than
 * something involving a rate.
 *
 * It is fed from the readiness report rather than from a background poll, so the
 * metric and the probe endpoint cannot disagree — the same reasoning as counting
 * token issuance at the same door as its span.
 */
export const dependencyUp = new Gauge({
  name: "keystone_dependency_up",
  help: "1 when a dependency is answering, 0 when it is not, as last checked by /ready",
  labelNames: ["dependency"],
});

export const rateLimitRedisErrors = new Counter({
  name: "keystone_rate_limit_redis_errors_total",
  help: "Rate-limit checks that could not reach Redis",
  labelNames: ["key_prefix"],
});

export const emergencyLocalLimiter = new Counter({
  name: "keystone_emergency_local_limiter_total",
  help:
    "Rate-limit decisions served from the per-process fallback because Redis was unreachable. " +
    "While this moves, rate limiting is NOT shared across the fleet.",
  labelNames: ["key_prefix", "outcome"],
});

export const authenticationAttempts = new Counter({
  name: "keystone_authentication_attempts_total",
  help: "Authentication attempts by outcome and reason",
  labelNames: ["outcome", "reason"],
});

export const tokenOperations = new Counter({
  name: "keystone_token_operations_total",
  help: "Token issuance, rotation and replay detection",
  labelNames: ["operation", "outcome"],
});

export const deliveries = new Counter({
  name: "keystone_deliveries_total",
  help: "Outbound deliveries by kind and outcome",
  labelNames: ["kind", "outcome"],
});

export const deliveryDuration = new Histogram({
  name: "keystone_delivery_duration_seconds",
  help: "Outbound delivery duration by kind",
  labelNames: ["kind"],
  // A webhook consumer that takes ten seconds is a problem; one that takes 200ms is
  // not worth a separate bucket. The default prom-client buckets stop at 10s, which
  // would put every slow delivery in one bucket and make the histogram useless for
  // answering "which consumer is slow".
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
});

/**
 * Publish the dependency state from a readiness report.
 *
 * Redis and PostgreSQL are two label values on one series rather than two series,
 * so a query covers both and a new dependency does not need a metric of its own.
 *
 * Fed from the readiness report rather than from a background poll, so the metric
 * and the `/ready` endpoint cannot disagree — the same reasoning as counting token
 * issuance at the same door as its span.
 */
export function recordDependencyState(report: {
  checks: { database: { ok: boolean }; redis: { ok: boolean } };
}): void {
  dependencyUp.set({ dependency: "postgres" }, report.checks.database.ok ? 1 : 0);
  dependencyUp.set({ dependency: "redis" }, report.checks.redis.ok ? 1 : 0);
}

/**
 * Count an authentication attempt.
 *
 * `reason` is separate from `outcome` because the question an operator asks is not
 * "are logins failing" but "why". A sudden `invalid_credentials` is a spray; a
 * sudden `mfa_failed` is a user with a broken second factor; a sudden
 * `rate_limited` is a client with a bug. Folded into one label, all three read as
 * "logins are failing" and none of them is actionable.
 */
export function recordAuthentication(outcome: string, reason: string): void {
  authenticationAttempts.inc({ outcome, reason });
}

/**
 * Count the emergency fallback engaging.
 *
 * Called from the one place that decides it, so there is no path to the fallback
 * that is not counted. `outcome` is `allowed` or `denied` because the two mean
 * different things to an operator: denials are visible to users, allowances are
 * invisible and are the ones that hide the degradation.
 */
export function recordEmergencyFallback(keyPrefix: string, outcome: "allowed" | "denied"): void {
  emergencyLocalLimiter.inc({ key_prefix: keyPrefix, outcome });
}

/** Count a token operation. `operation` is `issue`, `rotate` or `replay`. */
export function recordTokenOperation(operation: string, outcome: string): void {
  tokenOperations.inc({ operation, outcome });
}

/** Count and time an outbound delivery. */
export function recordDelivery(kind: string, outcome: string, startedAt: number): void {
  deliveries.inc({ kind, outcome });
  deliveryDuration.observe({ kind }, (Date.now() - startedAt) / 1000);
}
