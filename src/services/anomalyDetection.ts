import { redis } from "./redis.js";

const ANOMALY_WINDOW_SECONDS = 300;
const FAILED_LOGIN_THRESHOLD = 10;
const NEW_DEVICE_THRESHOLD = 3;
// Two logins from different IPs within this window are flagged as
// suspicious (approximation of impossible travel without a GeoIP database).
const IMPOSSIBLE_TRAVEL_WINDOW_SECONDS = 900;

export async function recordFailedLogin(identifier: string): Promise<number> {
  if (redis.status !== "ready" && redis.status !== "connect") return 0;
  const key = `anomaly:failed_login:${identifier}`;
  const now = Date.now();
  const windowStart = now - ANOMALY_WINDOW_SECONDS * 1000;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, `${now}:${Math.random().toString(36).slice(2)}`);
  pipeline.zcard(key);
  pipeline.pexpire(key, ANOMALY_WINDOW_SECONDS * 1000);
  const results = await pipeline.exec();
  return (results?.[2]?.[1] as number) ?? 0;
}

/**
 * How many failures are recorded for `identifier` in the window. A **read**.
 *
 * Split out from `recordFailedLogin` because `isFailedLoginAnomaly` used to call
 * the recorder to get its answer, which made asking the question itself count as
 * evidence. Every call site then recorded the failure twice — once through the
 * `user_login_failed` subscriber and once by asking — so the threshold of 10 was
 * reached after **5** real failed logins rather than 10 (SEC-053).
 *
 * A predicate named `is...` that mutates the thing it measures is the kind of
 * signature that makes the next call site wrong too, so the two operations are
 * now separate and the name says which one it is.
 */
export async function countFailedLogins(identifier: string): Promise<number> {
  if (redis.status !== "ready" && redis.status !== "connect") return 0;
  const key = `anomaly:failed_login:${identifier}`;
  // Trim the window first, so a count is not inflated by entries that have already
  // aged out. The recorder does the same trim; doing it here too means a caller
  // that only ever reads still sees the number it would see after a write.
  await redis.zremrangebyscore(key, 0, Date.now() - ANOMALY_WINDOW_SECONDS * 1000);
  return redis.zcard(key);
}

export async function isFailedLoginAnomaly(identifier: string): Promise<boolean> {
  return (await countFailedLogins(identifier)) >= FAILED_LOGIN_THRESHOLD;
}

export async function recordNewDevice(userId: string): Promise<number> {
  if (redis.status !== "ready" && redis.status !== "connect") return 0;
  const key = `anomaly:new_device:${userId}`;
  const now = Date.now();
  const windowStart = now - ANOMALY_WINDOW_SECONDS * 1000;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, `${now}:${Math.random().toString(36).slice(2)}`);
  pipeline.zcard(key);
  pipeline.pexpire(key, ANOMALY_WINDOW_SECONDS * 1000);
  const results = await pipeline.exec();
  return (results?.[2]?.[1] as number) ?? 0;
}

/**
 * Whether a device has been seen enough times to be an anomaly. A **read**, for
 * the same reason as `isFailedLoginAnomaly`.
 */
export async function isNewDeviceAnomaly(userId: string): Promise<boolean> {
  if (redis.status !== "ready" && redis.status !== "connect") return false;
  const key = `anomaly:new_device:${userId}`;
  await redis.zremrangebyscore(key, 0, Date.now() - ANOMALY_WINDOW_SECONDS * 1000);
  return (await redis.zcard(key)) >= NEW_DEVICE_THRESHOLD;
}

/**
 * Records the login location (IP) for a user and returns true when the
 * previous login happened from a *different* IP within the impossible-travel
 * window. Without a GeoIP database this is an approximation: physically
 * changing networks within a few minutes usually indicates credential misuse
 * (or a VPN/mobile network switch, so alerts should say "suspicious", not
 * "blocked").
 */
export async function checkImpossibleTravel(userId: string, ip: string | undefined): Promise<boolean> {
  if (!ip || (redis.status !== "ready" && redis.status !== "connect")) return false;
  const key = `anomaly:last_login:${userId}`;
  const now = Date.now();

  const previous = await redis.hgetall(key);
  await redis
    .multi()
    .hset(key, "ip", ip, "ts", String(now))
    .pexpire(key, 30 * 24 * 60 * 60 * 1000)
    .exec();

  if (!previous?.ip || !previous?.ts) return false;
  const elapsed = now - Number(previous.ts);
  return previous.ip !== ip && elapsed < IMPOSSIBLE_TRAVEL_WINDOW_SECONDS * 1000;
}
