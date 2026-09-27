/**
 * In-process rate limiting, for when Redis is unavailable.
 *
 * The distributed limiter is the real control: it is shared across instances, so
 * a client cannot multiply its budget by spreading requests over a fleet. But it
 * depends on Redis, and when Redis is down the previous behaviour was to allow
 * everything.
 *
 * That is backwards. An outage is exactly when an attacker wants unlimited
 * attempts at `login`, `mfa-verify`, or a token exchange — the requests that
 * matter are the ones worth brute-forcing. Losing the limiter because a cache
 * restarted removes the control at the worst possible moment.
 *
 * So sensitive endpoints carry a local fallback. It is strictly weaker than the
 * distributed limiter: a client gets `instanceCount` times the budget by
 * spreading requests, since each process counts independently. That is a
 * degradation worth having, and unbounded is not.
 *
 * The store is bounded. An unbounded map keyed by client address is itself a
 * denial-of-service vector — an attacker rotating addresses would grow it without
 * limit — so expired windows are swept and the oldest entries are evicted once
 * the cap is reached.
 */

interface Window {
  count: number;
  resetAt: number;
}

/** Cap on tracked keys. Roughly a few thousand clients per process. */
const MAX_TRACKED_KEYS = 10_000;

const windows = new Map<string, Window>();

/** Drop expired windows. Cheap enough to run on every check at this size. */
function sweep(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

/**
 * Evict the oldest window when the cap is reached.
 *
 * `Map` preserves insertion order, so the first key is the oldest. Its window is
 * expired, so evicting it grants no extra budget — it simply forgets a key that
 * has already been refilled.
 */
function enforceCap(now: number): void {
  if (windows.size < MAX_TRACKED_KEYS) return;
  sweep(now);
  while (windows.size >= MAX_TRACKED_KEYS) {
    const oldest = windows.keys().next();
    if (oldest.done) return;
    windows.delete(oldest.value);
  }
}

export type LocalLimiterResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Count one request against an in-process window.
 *
 * Fixed window rather than sliding: a sliding window needs per-request
 * timestamps and this is a degraded path, not the primary control. The
 * consequence is that a client can spend its budget at the end of one window and
 * again at the start of the next, which is acceptable for a fallback and would
 * not be for the primary limiter.
 */
export function localRateLimit(
  key: string,
  maxAttempts: number,
  windowSeconds: number
): LocalLimiterResult {
  const now = Date.now();
  enforceCap(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true };
  }

  existing.count += 1;
  if (existing.count > maxAttempts) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { allowed: true };
}

/** Test seam: forget every tracked window. */
export function resetLocalRateLimits(): void {
  windows.clear();
}

/** Test seam: how many windows are currently tracked. */
export function localRateLimitSize(): number {
  return windows.size;
}
