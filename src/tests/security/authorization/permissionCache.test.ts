import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "permission-cache-test";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../../db/index.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { DrizzlePermissionRepository } = await import("../../../repositories/permission.js");
const { redis, isRedisReady } = await import("../../../services/redis.js");
import type { PermissionCacheClient } from "../../../services/permissionCache.js";
const {
  permissionCacheStats,
  resetPermissionCacheStats,
  setPermissionCacheClient,
} = await import("../../../services/permissionCache.js");
const { permissions, rolePermissions } = await import("../../../db/schema.js");
const { migrationsFolder } = await import("../../../lib/paths.js");

/**
 * The permission cache must be correct, and being fast must never come first.
 *
 * Three properties, each of which is a way this could have gone wrong quietly:
 *
 * 1. **A permission change is visible on the next request.** Not after a TTL. A
 *    cache whose invalidation is eventually-consistent turns "revoke this
 *    permission" into a five-minute delay, which is a security defect wearing a
 *    caching trade-off's clothes.
 *
 * 2. **A Redis failure still authorizes correctly.** The fallback is the
 *    database, and specifically *not* an in-process copy — the general-purpose
 *    cache in `services/cache.ts` falls back to a `Map`, which is right for a
 *    dashboard and wrong here, because a fallback entry has no invalidation path
 *    and two instances would answer differently.
 *
 * 3. **The cache is actually used.** A cache that is silently never hitting is
 *    indistinguishable from one that does not exist, and only the counter tells
 *    the two apart.
 *
 * Every test here was confirmed to fail against a version with the
 * corresponding property removed.
 */

let app: FastifyInstance;
const repository = new DrizzlePermissionRepository();

/**
 * Every probe this suite created, not just the last one.
 *
 * The first version kept a single id, so each test leaked its probe into the
 * catalogue and the next test's `some(key => key.startsWith("cache_probe_"))`
 * matched the *previous* test's leftover. Two tests then failed while asserting
 * that the cache was broken, when the assertions were matching the wrong row.
 */
const probeIds: string[] = [];

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
  await app.container.permissionRepository.ensureRolePermissionsSeeded();
  // The shared client is created with `lazyConnect`, so it is still in status
  // "wait" until something asks it to connect. Nothing has yet, which means the
  // first permission read on a cold process always misses the cache. That is a
  // cold-start cost and not a correctness problem — the first read populates it —
  // but it does mean a test has to connect before it can observe a hit.
  await redis.connect().catch(() => {});
  assert.ok(
    isRedisReady(),
    "these tests need Redis; the cache is Redis-only by design, and a " +
      "permission answer is never served from an in-process copy"
  );
});

after(async () => {
  // Put the catalogue back exactly as it was.
  for (const id of probeIds) {
    await db.delete(rolePermissions).where(eq(rolePermissions.permissionId, id));
    await db.delete(permissions).where(eq(permissions.id, id));
  }
  await app?.close();
  await closeDb().catch(() => {});
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

/**
 * A permission created for this test, returned with the key it will appear under
 * so an assertion can name it rather than guess which probe it is looking at.
 */
async function makeProbePermission(): Promise<{ id: string; key: string }> {
  const resource = `cache_probe_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await db
    .insert(permissions)
    .values({ resource, action: "read", description: "permission cache test probe" })
    .returning();
  probeIds.push(created.id);
  return { id: created.id, key: `${resource}:read` };
}

describe("the permission cache", () => {
  it("serves a second read from the cache rather than the database", async () => {
    resetPermissionCacheStats();

    // First read populates, second should be served from Redis.
    const first = await repository.listKeysForRole("owner");
    const afterFirst = permissionCacheStats();
    const second = await repository.listKeysForRole("owner");
    const afterSecond = permissionCacheStats();

    assert.ok(first.size > 0, "the owner role should hold permissions");
    assert.deepEqual(
      [...second].sort(),
      [...first].sort(),
      "a cached read must return the same set as the read that populated it"
    );
    assert.equal(
      afterSecond.hits,
      afterFirst.hits + 1,
      "the second read should be a cache hit"
    );
  });

  it("makes a granted permission visible on the next read, with no TTL wait", async () => {
    const probe = await makeProbePermission();

    const before = await repository.listKeysForRole("member");
    assert.ok(before.size > 0, "the member role should already hold some permissions");
    assert.equal(before.has(probe.key), false, "the probe should not be granted yet");

    await repository.assignToRole("member", probe.id);

    const after = await repository.listKeysForRole("member");
    assert.equal(
      after.has(probe.key),
      true,
      "the grant should be visible immediately. A cache that needed a TTL to " +
        "notice would be a revoked permission that survives for five minutes too."
    );
  });

  it("makes a revoked permission stop being honoured on the next read", async () => {
    const probe = await makeProbePermission();
    await repository.assignToRole("member", probe.id);

    // Populated and asserted *before* the revoke, so the test cannot pass by
    // never having cached anything.
    const granted = await repository.listKeysForRole("member");
    assert.equal(granted.has(probe.key), true, "the granted permission should be in the set");

    await repository.removeFromRole("member", probe.id);

    const revoked = await repository.listKeysForRole("member");
    assert.equal(
      revoked.has(probe.key),
      false,
      "a revoked permission must stop being allowed on the next read"
    );
  });

  it("drops every role's cache when a permission row is deleted", async () => {
    const probe = await makeProbePermission();
    await repository.assignToRole("member", probe.id);
    // Populate the cache for every role, so the invalidation has something to
    // invalidate. An empty cache would make this test pass for the wrong reason.
    for (const role of ["owner", "admin", "member"]) {
      const keys = await repository.listKeysForRole(role);
      if (role === "member") assert.equal(keys.has(probe.key), true, "the probe should be cached");
    }

    await repository.remove(probe.id);

    for (const role of ["owner", "admin", "member"]) {
      const after = await repository.listKeysForRole(role);
      assert.equal(
        after.has(probe.key),
        false,
        `deleting a permission cascades to role_permissions, so ${role}'s cached ` +
          `set may still contain it — and that is a revoked permission still being honoured`
      );
    }
  });

  it("consults a client that has not connected yet", async () => {
    // The shared client is created with `lazyConnect`, so on a cold process it
    // reports status "wait" while being entirely capable of connecting on the
    // first command.
    //
    // A `if (!isRedisReady()) return null` guard looks correct and silently
    // disables the cache in exactly that state — and the only things that connect
    // Redis early are the rate limiters, so on an endpoint with no rate limit the
    // cache is never used at all. `/v1/authz/check` is one; the benchmark
    // measured it at 7 statements per request with the guard and 6 without.
    //
    // This is the test for that, and it only exists because the guard was put
    // back once and the suite stayed green.
    const lazilyConnecting: PermissionCacheClient = {
      status: "wait",
      get: async (key) => (key.endsWith(":owner") ? JSON.stringify(["cached:while:warming"]) : null),
      set: async () => "OK",
      del: async () => 1,
      scan: async () => ["0", []],
    };

    setPermissionCacheClient(lazilyConnecting);
    resetPermissionCacheStats();
    try {
      const keys = await repository.listKeysForRole("owner");
      assert.equal(
        keys.has("cached:while:warming"),
        true,
        "a client that has not connected yet must still be consulted — it would " +
          "connect on this command. Gating on readiness turns a working cache " +
          "into a permanently cold one on a cold process."
      );
      assert.equal(permissionCacheStats().hits, 1, "and the read should count as a hit");
    } finally {
      setPermissionCacheClient(null);
    }
  });

  it("falls through to the database when Redis is unavailable, and still authorizes", async () => {
    const probe = await makeProbePermission();
    await repository.assignToRole("owner", probe.id);

    // Warm the cache *before* the outage, so the test cannot pass by never having
    // cached anything — and cannot pass by reading a stale copy.
    const warm = await repository.listKeysForRole("owner");
    assert.equal(warm.has(probe.key), true, "the cache should be warm before Redis goes away");

    // A client that reports itself not-ready, and a client that reports itself
    // ready and then fails. Both must reach the database; the first is what a
    // booting process sees, the second is what a mid-request network failure
    // looks like, and they take different branches in the code.
    // An unreachable Redis. Every command rejects, which is what a real ioredis
    // client does when it cannot connect: with `lazyConnect` the first command
    // triggers the connection attempt, and a failed connection rejects rather
    // than returning a value. A stub that answered `null` here would model a
    // cold cache, not an outage, and would pass whether or not the fallback works.
    const unreachable: PermissionCacheClient = {
      status: "end",
      get: async () => {
        throw new Error("Connection is closed.");
      },
      set: async () => {
        throw new Error("Connection is closed.");
      },
      del: async () => {
        throw new Error("Connection is closed.");
      },
      scan: async () => {
        throw new Error("Connection is closed.");
      },
    };
    const brokenButReady: PermissionCacheClient = {
      status: "ready",
      get: async () => {
        throw new Error("connection reset");
      },
      set: async () => {
        throw new Error("connection reset");
      },
      del: async () => {
        throw new Error("connection reset");
      },
      scan: async () => {
        throw new Error("connection reset");
      },
    };

    for (const [label, client] of [
      ["unreachable", unreachable],
      ["connected but failing", brokenButReady],
    ] as const) {
      // Both are outages from the caller's point of view, and both must reach the
      // database. They take different branches in a readiness-checking
      // implementation, which is why there are two.
      setPermissionCacheClient(client);
      resetPermissionCacheStats();
      try {
        const duringOutage = await repository.listKeysForRole("owner");
        assert.equal(
          duringOutage.has(probe.key),
          true,
          `with Redis ${label}, the answer must still be correct — which means it ` +
            `came from the database, not from a copy taken before the outage`
        );
        assert.equal(
          permissionCacheStats().hits,
          0,
          `with Redis ${label} no hit is possible, so a hit would mean an ` +
            `in-process fallback is being consulted for an authorization answer`
        );
        assert.ok(
          permissionCacheStats().bypasses > 0,
          `with Redis ${label} the bypass should be counted, so an operator can ` +
            `see that the cache is not working`
        );

        // A write during the outage must not throw. A cache problem cannot be
        // allowed to become a failed permission change.
        await repository.removeFromRole("owner", probe.id);
        assert.equal(
          (await repository.listKeysForRole("owner")).has(probe.key),
          false,
          `a revocation during an outage where Redis is ${label} must still take effect`
        );
        // Put it back so the next iteration and the recovery check have something
        // to observe going away.
        await repository.assignToRole("owner", probe.id);
      } finally {
        setPermissionCacheClient(null);
      }
    }

    // The whole point: once Redis is back, the cache is correct again and the
    // revocation that happened during the outage is reflected rather than being
    // masked by a stale entry.
    const recovered = await repository.listKeysForRole("owner");
    assert.equal(
      recovered.has(probe.key),
      true,
      "after the outage, the cache is repopulated from the database"
    );
    await repository.removeFromRole("owner", probe.id);
    const afterRevoke = await repository.listKeysForRole("owner");
    assert.equal(
      afterRevoke.has(probe.key),
      false,
      "and a revocation with Redis back is visible immediately, not after a TTL"
    );
  });

  it("does not cache an empty set for a role that does not exist", async () => {
    // Caching "nothing" for a role that does not exist would mean a role that is
    // later granted permissions keeps nothing until the TTL expires — a grant
    // that silently does not take effect.
    const absent = `role_that_does_not_exist_${crypto.randomUUID().slice(0, 8)}`;
    resetPermissionCacheStats();

    const first = await repository.listKeysForRole(absent);
    assert.equal(first.size, 0, "an unknown role holds nothing");

    const probe = await makeProbePermission();
    await db.insert(rolePermissions).values({ role: absent, permissionId: probe.id });

    // Written straight to the table, deliberately bypassing the repository, so
    // nothing invalidates anything. This is the worst case for a cache: the read
    // above is exactly the one a cached empty set would have poisoned.
    const second = await repository.listKeysForRole(absent);
    assert.equal(
      second.has(probe.key),
      true,
      "the grant is visible immediately, with no invalidation and no TTL wait, " +
        "because the earlier empty answer was never cached. Had it been, this " +
        "role would have held nothing for five minutes after being given a " +
        "permission — a grant that silently does not take effect."
    );

    // And an empty read stays a miss every time, rather than being served from a
    // stored "nothing".
    const alsoAbsent = `also_absent_${crypto.randomUUID().slice(0, 8)}`;
    resetPermissionCacheStats();
    await repository.listKeysForRole(alsoAbsent);
    await repository.listKeysForRole(alsoAbsent);
    assert.equal(
      permissionCacheStats().hits,
      0,
      "an empty set is never cached, so a role with no permissions costs a " +
        "database read every time. That is the price of the guarantee above."
    );
  });

  it("treats a malformed cache entry as a miss rather than an empty set", async () => {
    // The dangerous failure is a poisoned entry resolving to `[]`, which would
    // deny every request for the role. A miss re-reads the database.
    const probe = await makeProbePermission();
    await repository.assignToRole("owner", probe.id);
    await repository.listKeysForRole("owner");

    const key = `${process.env.CACHE_KEY_PREFIX || "keystone:"}perms:role:owner`;
    await redis.set(key, JSON.stringify({ not: "an array" }), "EX", 60);
    try {
      const keys = await repository.listKeysForRole("owner");
      assert.ok(
        keys.size > 0,
        "a malformed entry must be read as a miss, not as an empty permission set"
      );
    } finally {
      await redis.del(key);
      await db.delete(rolePermissions).where(eq(rolePermissions.permissionId, probe.id));
    }
  });
});
