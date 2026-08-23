import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { redis, isRedisReady } from "../services/redis.js";

interface RateLimitPluginOptions {
  keyPrefix: string;
  maxAttempts: number;
  windowSeconds: number;
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

async function isAllowed(key: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
  if (!isRedisReady()) {
    // Fail open when Redis is not connected; the endpoint remains functional.
    return true;
  }

  const now = Date.now();
  const member = `${now}:${cryptoRandom()}`;

  try {
    const count = (await redis.eval(
      slidingWindowLua,
      1,
      key,
      windowSeconds * 1000,
      now,
      member,
      maxAttempts
    )) as number;
    return count < maxAttempts;
  } catch (err) {
    // Fail open on transient Redis errors so a network blip cannot lock users out.
    console.error("[rateLimit] Redis error:", err);
    return true;
  }
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2);
}

function clientIdentifier(request: FastifyRequest): string {
  return (
    (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    request.ip
  );
}

export function rateLimit(options: RateLimitPluginOptions) {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply) {
    const id = clientIdentifier(request);
    const key = `${options.keyPrefix}:${id}:${(request.body as Record<string, string> | undefined)?.email ?? ""}`;
    const allowed = await isAllowed(key, options.maxAttempts, options.windowSeconds);
    if (!allowed) {
      return reply
        .header("Retry-After", String(options.windowSeconds))
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
    const allowed = await isAllowed(key, maxRequests, windowSeconds);
    if (!allowed) {
      return reply
        .header("Retry-After", String(windowSeconds))
        .status(429)
        .send({ error: "Rate limit exceeded. Please slow down." });
    }
  };
}

export function appRateLimit(options: { maxAttempts: number; windowSeconds: number }) {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply) {
    const clientId = (request.body as Record<string, string> | undefined)?.client_id ?? "anonymous";
    const id = clientIdentifier(request);
    const key = `app:${clientId}:${id}`;
    const allowed = await isAllowed(key, options.maxAttempts, options.windowSeconds);
    if (!allowed) {
      return reply
        .header("Retry-After", String(options.windowSeconds))
        .status(429)
        .send({ error: "Too many attempts for this application. Please try again later." });
    }
  };
}

export default fp(async function rateLimitPlugin(app: FastifyInstance) {
  app.addHook("onClose", async () => {
    await redis.quit();
  });
});
