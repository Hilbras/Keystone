import { redis } from "./redis.js";
import { config } from "../config.js";

/**
 * A cache for values that decide whether a request is allowed.
 *
 * This exists because the general-purpose cache in `./cache.ts` is the wrong tool
 * here, and using it would have been a security regression wearing a performance
 * improvement's clothes.
 *
 * `cache.get` falls back to an in-process `Map` when Redis is unreachable. That
 * is right for a rendered dashboard and wrong for an authorization decision,
 * because a fallback copy has no invalidation path: a permission revoked in one
 * process would keep being honoured by every process holding a fallback entry,
 * for as long as its TTL, with no write anywhere to trigger the invalidation. A
 * multi-instance deployment would authorize differently depending on which
 * instance answered.
 *
 * So the rules here are different on purpose:
 *
 * - **Miss or error goes to the database, always.** There is no in-process copy
 *   at all. Redis is a speed-up, never a source of truth.
 * - **Errors are counted, not swallowed.** A permission check that is quietly
 *   running 3x slower because Redis is down is a problem someone needs to see;
 *   the fallback is correct, but it is not free.
 * - **Writes invalidate, and the TTL is only a backstop.** A permission change
 *   deletes the key, so the next request reads the database. The TTL exists for
 *   the case where an invalidation is missed, not as the primary mechanism.
 */

const PERMISSION_CACHE_TTL_SECONDS = 300;

const keyFor = (role: string): string => `${config.CACHE_KEY_PREFIX || "keystone:"}perms:role:${role}`;

/**
 * The subset of the Redis client this module uses.
 *
 * Declared as an interface rather than importing the concrete type so the outage
 * test can supply a client that fails every command. The first version of that
 * test disconnected the shared client and then tried to patch `status` back with
 * `Object.defineProperty`; it hung for the full suite timeout and left the client
 * unusable for the five tests after it. A seam is smaller than that and does not
 * take the shared connection hostage to test one branch.
 */
export interface PermissionCacheClient {
  readonly status: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(cursor: string, match: string, pattern: string, count: string, n: string): Promise<[string, string[]]>;
}

let client: PermissionCacheClient = redis;

/**
 * Swap the client. Test-only, and named so that it reads as such at the call site.
 *
 * Passing `null` restores the real connection.
 */
export function setPermissionCacheClient(next: PermissionCacheClient | null): void {
  client = next ?? (redis as unknown as PermissionCacheClient);
}

/**
 * How many times the permission cache was bypassed.
 *
 * Read by `/metrics` and asserted by a test. A cache that is silently never
 * hitting is indistinguishable from one that does not exist, and the metric is
 * the only thing that tells the two apart.
 */
let bypasses = 0;
let hits = 0;

/**
 * No readiness check on the read path.
 *
 * The obvious implementation is `if (!isRedisReady()) return null`, and it is
 * wrong in a way that is invisible: the shared client is created with
 * `lazyConnect`, so on a cold process its status is `"wait"` until some *other*
 * code path issues a command. Gating on readiness therefore disables the cache
 * for exactly the first requests of a process's life, and — because the only
 * things that connect Redis early are the rate limiters — it disables the cache
 * entirely on any endpoint that is not rate limited. `/v1/authz/check` is one.
 *
 * A lazily-connecting client connects on the first command, so the command is
 * simply attempted. If Redis is genuinely unavailable the command throws, the
 * catch runs, and the caller reads the database — which is the behaviour that
 * was wanted, arrived at by one fewer branch.
 */

export function permissionCacheStats(): { hits: number; bypasses: number } {
  return { hits, bypasses };
}

/** Test seam. Resets the counters; does not touch Redis. */
export function resetPermissionCacheStats(): void {
  hits = 0;
  bypasses = 0;
}

/**
 * The cached permission keys for a role, or `null` if they must be read.
 *
 * `null` means "ask the database", and covers all three ways that can happen: not
 * cached, Redis not ready, or Redis returning an error. The caller cannot tell
 * them apart, which is the point — none of them is a reason to answer from
 * memory.
 */
export async function getCachedRolePermissions(role: string): Promise<string[] | null> {
  try {
    const raw = await client.get(keyFor(role));
    if (raw === null) {
      // A genuine miss, which is most of the time on a cold cache. Not counted as
      // a bypass: nothing is wrong, the entry simply is not there yet.
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((k) => typeof k !== "string")) {
      // Something wrote a value that is not a string array. Treating it as a miss
      // is the only safe reading: a malformed entry must not become an empty
      // permission set, which would deny every request for the role.
      bypasses += 1;
      return null;
    }
    hits += 1;
    return parsed as string[];
  } catch {
    // Redis is unreachable. Counted, so an operator can see the cache is not
    // working rather than discovering it as a slow endpoint.
    bypasses += 1;
    return null;
  }
}

export async function setCachedRolePermissions(role: string, keys: string[]): Promise<void> {
  try {
    await client.set(keyFor(role), JSON.stringify(keys), "EX", PERMISSION_CACHE_TTL_SECONDS);
  } catch {
    // A failed write costs a database read on the next request. That is the whole
    // cost, and it is not worth turning a cache miss into a failed request.
    bypasses += 1;
  }
}

/**
 * Drop one role's cached permissions.
 *
 * Called after any write that changes what a role may do. There is no TTL-only
 * path: a revoked permission that is still honoured for five minutes is a
 * security defect, not a caching trade-off.
 */
export async function invalidateRolePermissions(role: string): Promise<void> {
  try {
    await client.del(keyFor(role));
  } catch {
    // The TTL is the backstop for exactly this case.
  }
}

/**
 * Drop every role's cached permissions.
 *
 * For writes whose blast radius is not one role: a permission row created or
 * deleted, and the seeder. A deleted permission cascades to `role_permissions`,
 * so any role may have lost a key, and knowing which would cost a read to find
 * out — while getting it wrong leaves a revoked permission alive.
 */
export async function invalidateAllRolePermissions(): Promise<void> {
  try {
    let cursor = "0";
    const pattern = `${config.CACHE_KEY_PREFIX || "keystone:"}perms:role:*`;
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", "100");
      cursor = next;
      if (keys.length > 0) await client.del(...keys);
    } while (cursor !== "0");
  } catch {
    // The TTL bounds this to five minutes. That is a known, documented, bounded
    // failure rather than an unbounded one, which is why it is acceptable here
    // and why a per-request authorization answer is not served from memory.
  }
}
