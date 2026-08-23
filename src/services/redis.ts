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
