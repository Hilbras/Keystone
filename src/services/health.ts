import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { redis } from "./redis.js";

/**
 * What the probes are allowed to know about.
 *
 * Kept out of `routes/health.ts` because it *is* data access — it runs
 * `select 1` — and §3.1's layering rule says a route must not touch the database
 * directly. That rule fired on the first version of this, correctly: a route with
 * `db` in scope can skip a repository's guarantees by accident, and a readiness
 * probe is exactly the kind of code that ends up being copied somewhere it should
 * not be.
 *
 * The rule is about routes reaching past the data layer for *domain* data. This is
 * the one query in the system that has no domain: it is the question "is the
 * connection alive", and it belongs to no entity. Putting it in a repository would
 * mean inventing a `SystemRepository` with one method, so the service is the
 * honest home and the route stays pure HTTP.
 *
 * The checks are real commands, not `db !== undefined`:
 *
 * - The database is asked with `select 1`. A pool that exists is not a database
 *   that answers, and a pool whose connection has gone stale still exists.
 * - Redis is asked with `ping`, and the **command is attempted** rather than
 *   `isRedisReady()` consulted. The shared client is created with `lazyConnect`,
 *   so its status is `"wait"` until some *other* code path issues a command — a
 *   readiness guard on the status would report "not ready" on a process that has
 *   simply not used Redis yet. This is the same trap the permission cache fell
 *   into in 3.2.0.
 *
 * The two are independent on purpose. A deployment with no Redis at all falls back
 * to the in-process queue and the local rate limiter, which is a supported
 * degraded mode, so a hard Redis failure is reported as `degraded` rather than
 * failing readiness outright. PostgreSQL has no such fallback: without it nothing
 * works.
 */

export interface DependencyCheck {
  ok: boolean;
  detail?: string;
  latencyMs: number;
}

export interface ReadinessReport {
  status: "ready" | "degraded" | "unavailable";
  checks: { database: DependencyCheck; redis: DependencyCheck };
}

export const PROBE_TIMEOUT_MS = 2000;

/** Race a probe against a deadline, so one hung dependency cannot hang the probe. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkDatabase(): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    await within(db.execute(sql`select 1`), PROBE_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

export async function checkRedis(): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    const reply = await within(redis.ping(), PROBE_TIMEOUT_MS);
    return {
      ok: reply === "PONG",
      detail: reply === "PONG" ? undefined : `unexpected reply: ${String(reply)}`,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

export async function buildReadinessReport(): Promise<ReadinessReport> {
  // In parallel: a probe is asked two independent questions and the answer is the
  // slower one, not the sum. Sequential checks would make the budget 4s for no
  // reason.
  const [database, cache] = await Promise.all([checkDatabase(), checkRedis()]);

  if (!database.ok) {
    return { status: "unavailable", checks: { database, redis: cache } };
  }
  if (!cache.ok) {
    // Redis down means the queue is in-process and the distributed rate limiter is
    // on its local fallback: degraded, not unavailable. Auth still works.
    return { status: "degraded", checks: { database, redis: cache } };
  }
  return { status: "ready", checks: { database, redis: cache } };
}
