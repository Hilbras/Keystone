import { Redis } from "ioredis";
import { config } from "../config.js";
import { serviceLogger } from "../lib/logger.js";

const log = serviceLogger("redis");

/**
 * Shared Redis connection used by rate limiting, anomaly detection, and any
 * other distributed state in Keystone. Lazy connection means the process will
 * not fail at import time if Redis is temporarily unavailable.
 *
 * `commandTimeout` is what bounds a *slow* Redis (§8.1). A dropped connection
 * is already bounded — ioredis reconnects and `maxRetriesPerRequest` rejects
 * the command — but a Redis that accepts the socket and answers late makes
 * every command wait indefinitely, and the rate limiter sits in front of every
 * request. Without this, a degraded Redis takes the API down rather than just
 * the limiter, and the degraded path that exists to keep serving never gets a
 * chance to engage.
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  commandTimeout: config.REDIS_COMMAND_TIMEOUT_MS,
});

/**
 * Log Redis failures instead of letting ioredis print them.
 *
 * With no `error` listener, ioredis writes a stack trace to stderr for every
 * failed command. During an outage that is one trace per request per
 * Redis-backed call — unbounded, and loud enough to bury the line that says
 * what actually broke. The failures are still visible (the metrics count them,
 * and the degraded paths handle them), but they are logged once, at a level
 * an operator is looking at, rather than printed.
 */
redis.on("error", (err: Error) => {
  log.warn({ err: err.message }, "redis connection error");
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
  if (redis.status === "end") return;
  await closeRedisClient(redis);
}

/**
 * Close an ioredis client, in a bounded time.
 *
 * `quit()` is the polite close: it sends QUIT and waits for the server's
 * answer. When the server cannot be reached, the command sits in the client's
 * offline queue until it reconnects — which may be never, because the reason
 * it cannot be reached is that it is down. So `quit()` alone can wait forever,
 * and a caller waiting on it never finishes.
 *
 * `disconnect()` is the close that always finishes, because it drops the
 * socket rather than negotiating with it. So the polite close is given a
 * deadline and the impolite one takes over when it expires.
 */
export async function closeRedisClient(
  client: Redis,
  timeoutMs: number = config.REDIS_COMMAND_TIMEOUT_MS * 2
): Promise<void> {
  if (client.status === "end") return;

  // One timer, doing both things: it drops the socket *and* releases the
  // wait. Two timers would have to be ordered against each other, and the
  // order that matters is the one that decides whether the socket is ever
  // dropped.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forced = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      client.disconnect();
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([client.quit().catch(() => client.disconnect()), forced]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
