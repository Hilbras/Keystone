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
 * How long a dependency took to answer, as measured by `/ready`.
 *
 * **This is a probe measurement and is named as one.** It is the round trip of
 * `select 1` against PostgreSQL and `ping` against Redis, taken on every readiness
 * call — every 10 seconds under `k8s/base/deployment.yaml` and
 * `docker-compose.yml`, so in a deployed system the series moves continuously.
 *
 * It is deliberately *not* labelled as request-path database latency, because it is
 * not that, and presenting it as that would mislead exactly the person it is meant
 * to help. postgres.js offers no per-query completion hook: its `debug` option is
 * called with the statement *before* it is written to the socket, and is otherwise
 * only used to attach an origin stack to errors. A per-statement duration histogram
 * would mean wrapping the Drizzle client, which every query in the system goes
 * through, to measure something the connection pool already reports as a pool-wait
 * problem. What an operator can actually act on here is "is the dependency slow",
 * and "is it slow for everyone or for one query" is answered by
 * `keystone_db_statements_total` next to `keystone_http_requests_total` — a query
 * count per request, which is what an N+1 regression looks like.
 */
export const dependencyLatency = new Histogram({
  name: "keystone_dependency_latency_seconds",
  help: "Round-trip time of a dependency check, as measured by /ready",
  labelNames: ["dependency"],
  // The probe's own budget is 2s per dependency (PROBE_TIMEOUT_MS), so the buckets
  // concentrate below it: a value in the top bucket means the probe timed out.
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
});

/**
 * Statements executed against PostgreSQL.
 *
 * The counter behind "is a query in a loop". Paired with
 * `keystone_http_requests_total`, the ratio is what a request costs in queries; on
 * its own it is a rate. It is counted at the driver's per-statement callback, which
 * every path in the system goes through, so there is no query that reaches
 * PostgreSQL without being counted — a counter maintained by remembering to call it
 * at each repository would answer "how many queries did we remember".
 *
 * Costs one increment per statement, on a path that is already executing a network
 * round trip.
 */
export const dbStatements = new Counter({
  name: "keystone_db_statements_total",
  help: "PostgreSQL statements executed by this process",
});

/**
 * Queue jobs by driver, type and outcome.
 *
 * `outcome` distinguishes the three things that can happen to a job, because a
 * single "jobs" count answers none of the questions an operator has:
 *
 * - `completed` — the handler returned. Work done.
 * - `retried` — the handler threw and the job will run again. Expected sometimes;
 *   a rising rate is a dependency going bad before it is an outage.
 * - `failed` — the handler threw on its last attempt and the job was dropped or
 *   dead-lettered. **Non-zero is a bug report**: work that was supposed to happen
 *   did not, and nothing will retry it.
 *
 * `provider` is `bullmq` or `in-process`. It is a label rather than two metrics so
 * a deployment that changed `KEYSTONE_QUEUE_PROVIDER` does not silently stop
 * reporting: the series continues with the other label value, and an alert written
 * against `{outcome="failed"}` keeps working.
 */
export const queueJobs = new Counter({
  name: "keystone_queue_jobs_total",
  help: "Queue jobs by driver, job type and outcome",
  labelNames: ["provider", "type", "outcome"],
});

export const queueJobDuration = new Histogram({
  name: "keystone_queue_job_duration_seconds",
  help: "Queue job handler duration by driver and job type",
  labelNames: ["provider", "type"],
  // Most jobs are a delivery or a reconcile and finish in well under a second; the
  // tail is the interesting part, so the buckets keep resolution out to a minute.
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
});

/**
 * OAuth2 token-endpoint refusals, by grant and by the error returned.
 *
 * Counted at the OAuth2 routes' `onSend`, so every 4xx the endpoint produces is
 * counted — including a refusal added later by someone who did not know this
 * metric existed. That is the point: the alternative is a counter incremented at
 * each of the endpoint's fifteen-odd refusal sites, which is a counter that
 * answers "how many refusals did we remember to count".
 *
 * `error` is the RFC 6749 error code the client received (`invalid_grant`,
 * `invalid_client`, `unsupported_grant_type`), which is the same vocabulary a
 * client's logs and an operator's dashboard can agree on. A rising
 * `invalid_grant` is a client bug or a replay attempt; a rising `invalid_client`
 * is a misconfigured integration or credential stuffing.
 */
export const oauthFailures = new Counter({
  name: "keystone_oauth_failures_total",
  help: "OAuth2 token endpoint refusals by grant type and error code",
  labelNames: ["grant_type", "error"],
});

/**
 * Rate-limit refusals, by the limiter that produced them.
 *
 * Separate from `keystone_emergency_local_limiter_total`, which counts the
 * *fallback engaging* — a different event, and one that is anomalous whether or
 * not it refused anything. This counts the refusals a client actually saw.
 *
 * The two together are what makes an incident readable: a spike in blocks with no
 * movement in the fallback counter is an attack being absorbed by the shared
 * budget; a spike in both means the fleet is degraded and each instance is
 * enforcing its own limits.
 */
export const rateLimitBlocks = new Counter({
  name: "keystone_rate_limit_blocks_total",
  help: "Requests refused by a rate limiter, by key prefix and limiter",
  labelNames: ["key_prefix", "limiter"],
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

/**
 * Publish the latency of every dependency the readiness probe just measured.
 *
 * Fed from the same report as `dependencyUp`, at the same moment, so an operator
 * reading "redis is down" and "redis took 2s just before it went down" is reading
 * two views of one measurement rather than two measurements that can disagree.
 */
export function recordDependencyLatency(report: { checks: { database: DependencyLatency; redis: DependencyLatency } }): void {
  dependencyLatency.observe({ dependency: "postgres" }, report.checks.database.latencyMs / 1000);
  dependencyLatency.observe({ dependency: "redis" }, report.checks.redis.latencyMs / 1000);
}

interface DependencyLatency {
  latencyMs: number;
}

/**
 * Count a job's fate, and how long the handler ran.
 *
 * `outcome` is one of `completed`, `retried` or `failed`; see `queueJobs` for what
 * each one means and why they are three labels rather than one count.
 *
 * Called from both queue drivers at the point where the handler settles, so an
 * `in-process` development run and a `bullmq` production run report the same
 * series with a different `provider` value. A metric that only existed on the
 * production driver would be a metric that is always zero in every environment
 * anyone develops in, which is how a broken counter ships.
 */
export function recordQueueJob(provider: string, type: string, outcome: string, startedAt: number): void {
  queueJobs.inc({ provider, type, outcome });
  queueJobDuration.observe({ provider, type }, (Date.now() - startedAt) / 1000);
}

/**
 * Count an OAuth2 token-endpoint refusal.
 *
 * `error` is the RFC 6749 code, not the HTTP status: `invalid_grant` and
 * `invalid_client` are both 400-adjacent answers to entirely different problems,
 * and a dashboard that folds them into "4xx" cannot tell a broken client from a
 * credential-stuffing run.
 */
export function recordOAuthFailure(grantType: string, error: string): void {
  oauthFailures.inc({ grant_type: grantType, error });
}

/** Count a refusal a client actually received, and which limiter produced it. */
export function recordRateLimitBlock(keyPrefix: string, limiter: string): void {
  rateLimitBlocks.inc({ key_prefix: keyPrefix, limiter });
}

/**
 * Count a statement sent to PostgreSQL.
 *
 * Deliberately **unlabelled**. A label carrying the statement text is unbounded
 * cardinality — the same failure `keystone_http_requests_total` had with request
 * URLs, and one that would take Prometheus down rather than merely make it slow. A
 * query fingerprint is a Prometheus query on `pg_stat_statements`, which is where
 * it belongs; this counter's job is to say how many statements a request costs.
 */
export function recordDbStatement(): void {
  dbStatements.inc();
}
