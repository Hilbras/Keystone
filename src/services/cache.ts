import { Redis } from "ioredis";
import { Counter } from "prom-client";
import { config } from "../config.js";

const cacheHits = new Counter({ name: "keystone_cache_hits_total", help: "Cache hits", labelNames: ["cache"] });
const cacheMisses = new Counter({ name: "keystone_cache_misses_total", help: "Cache misses", labelNames: ["cache"] });
const cacheSets = new Counter({ name: "keystone_cache_sets_total", help: "Cache writes", labelNames: ["cache"] });
const cacheDeletes = new Counter({ name: "keystone_cache_deletes_total", help: "Cache invalidations", labelNames: ["cache"] });

interface CacheMetrics {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class CacheProvider {
  private redis: Redis | null = null;
  private memory = new Map<string, CacheEntry<unknown>>();
  private metrics: CacheMetrics = { hits: 0, misses: 0, sets: 0, deletes: 0 };
  private prefix: string;

  constructor() {
    this.prefix = config.CACHE_KEY_PREFIX || "keystone:";
    if (config.REDIS_URL) {
      this.redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
      this.redis.on("error", (err) => {
        console.warn("[cache] redis error, falling back to in-memory:", err.message);
      });
    }
  }

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.redis?.status === "ready") {
      try {
        const value = await this.redis.get(this.key(key));
        if (value !== null) {
          this.metrics.hits++;
          cacheHits.inc({ cache: "redis" });
          return JSON.parse(value) as T;
        }
      } catch {
        // fall through to memory fallback
      }
    }

    const entry = this.memory.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      this.metrics.hits++;
      cacheHits.inc({ cache: "memory" });
      return entry.value as T;
    }
    if (entry) this.memory.delete(key);
    this.metrics.misses++;
    cacheMisses.inc({ cache: this.redis ? "redis" : "memory" });
    return null;
  }

  async set<T>(key: string, value: T, ttlSeconds = 60): Promise<void> {
    if (this.redis?.status === "ready") {
      try {
        await this.redis.setex(this.key(key), ttlSeconds, JSON.stringify(value));
        this.metrics.sets++;
        cacheSets.inc({ cache: "redis" });
        return;
      } catch {
        // fall through to memory fallback
      }
    }
    this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    this.metrics.sets++;
    cacheSets.inc({ cache: "memory" });
  }

  async del(key: string): Promise<void> {
    this.memory.delete(key);
    if (this.redis?.status === "ready") {
      try {
        await this.redis.del(this.key(key));
      } catch {
        // ignore
      }
    }
    this.metrics.deletes++;
    cacheDeletes.inc({ cache: this.redis ? "redis" : "memory" });
  }

  async invalidate(pattern: string): Promise<void> {
    const memoryKeys = [...this.memory.keys()].filter((k) => k.includes(pattern));
    for (const k of memoryKeys) this.memory.delete(k);

    if (this.redis?.status === "ready") {
      try {
        let cursor = "0";
        do {
          const result = await this.redis.scan(cursor, "MATCH", this.key(`*${pattern}*`), "COUNT", 100);
          cursor = result[0];
          const keys = result[1];
          if (keys.length) await this.redis.del(...keys);
        } while (cursor !== "0");
      } catch {
        // ignore
      }
    }
    this.metrics.deletes += memoryKeys.length;
    cacheDeletes.inc({ cache: this.redis ? "redis" : "memory" }, memoryKeys.length);
  }

  getMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  async close(): Promise<void> {
    this.memory.clear();
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}

export const cache = new CacheProvider();
