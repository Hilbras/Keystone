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

export async function isFailedLoginAnomaly(identifier: string): Promise<boolean> {
  const count = await recordFailedLogin(identifier);
  return count >= FAILED_LOGIN_THRESHOLD;
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

export async function isNewDeviceAnomaly(userId: string): Promise<boolean> {
  const count = await recordNewDevice(userId);
  return count >= NEW_DEVICE_THRESHOLD;
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
