import { Redis } from "ioredis";
import { config } from "../config.js";

/**
 * Shared Redis connection used by rate limiting, anomaly detection, and any
 * other distributed state in Keystone. Lazy connection means the process will
 * not fail at import time if Redis is temporarily unavailable.
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

export function isRedisReady(): boolean {
  return redis.status === "ready" || redis.status === "connect";
}

/**
 * Release the shared connection. Safe to call more than once, and a no-op if the
 * client never connected.
 *
 * Exists for the CLI — the only part of Keystone that has to *exit* without serving —
 * and for the graceful shutdown path (§6.3), which releases the connection on the
 * way out. It must not be called anywhere else: the server has jobs to keep doing,
 * and a live Redis connection is the server's distributed state.
 *
 * A live socket is a live handle, so a command that touched Redis — anything that
 * builds the container — never reached an empty event loop and never returned.
 * `initializeContainer()` left three of them open, which is why closing the
 * database pool alone was not enough and why the command still hung.
 */
export async function closeRedis(): Promise<void> {
  try {
    if (redis.status === "end") return;
    await redis.quit();
  } catch {
    // Already closing, or never connected. Either way there is nothing to do and
    // nothing to report — this is cleanup on the way out of a process.
    redis.disconnect();
  }
}
