# Redis

Redis holds the state that has to be shared between Keystone instances, and
that cannot be derived from the database. It is a dependency, not a cache: the
rate limiter's budget, the distributed lock and the permission cache all live
there, and losing Redis changes what the server does.

This document is about what Redis holds, what happens when it is unavailable,
and how to recover from it.

---

## 1. What Redis holds

| what | key shape | what breaks without it |
|---|---|---|
| rate-limit budgets | `<prefix>:<client>:<subject>` | every client gets a fresh budget per instance |
| distributed locks | `keystone:lock:<name>` | two instances can hold the same lock |
| permission cache | `keystone:perm:<role>` | permissions are read from the database instead — slower, same answers |
| anomaly counters | `anomaly:*` | failed-login and new-device detection sees nothing |
| the queue (BullMQ) | BullMQ's own keys | jobs stop being handed out |

The first two are the ones that matter. The permission cache and the anomaly
counters degrade to "slower" and "blind"; the rate limiter and the lock
degrade to "not shared", and "not shared" is a security property failing.

**The lock is the one to be careful about.** A lock that is not shared means
two instances can hold it at once, and whatever it protects happens twice.
Keystone's locks are session-scoped and expire (30 seconds by default), so a
lock left behind by a dead process is released rather than held forever — but
only if the process actually died. A lock held by a *live* process is a
different matter, and the lock's own TTL is the backstop.

---

## 2. What happens when Redis is unavailable

Keystone does not stop. It degrades, and it says so.

### The rate limiter falls back to a local budget

The distributed limiter is the real control, and it lives in Redis. When Redis
is unreachable, the per-endpoint limiters answer from a **bounded local
budget** instead (`src/services/localRateLimit.ts`):

- the budget is **per instance**, so a fleet of N instances allows N times the
  intended rate while Redis is down;
- the store is **capped at 10,000 keys**, so a flood cannot grow it without
  bound;
- it is a **fixed window**, which is weaker than the distributed limiter's
  sliding window.

The global limiter and the pre-authentication budget use the same fallback.
They used to fail open — see [Rate limiting](../security/rate-limiting.md) — and
an unbounded server during an outage is exactly the window an attack wants.

### The metrics tell you

| metric | meaning |
|---|---|
| `keystone_rate_limit_redis_errors_total` | rate-limit checks that could not reach Redis |
| `keystone_emergency_local_limiter_total` | the local fallback engaged, labelled `allowed` or `denied` |
| `keystone_dependency_up{dependency="redis"}` | whether Redis answered the last readiness check |

The first two move together: the first says something is broken, the second
says protection is degraded. The `allowed` label is the one to watch — denials
are visible to users, allowances are invisible, and an invisible allowance is
the one that hides the degradation.

### A slow Redis is bounded too

A Redis that is *absent* fails fast: the command is refused. A Redis that is
*slow* — the socket is open, the server is healthy, it just answers later than
it should — is the case that used to take the server down, because the rate
limiter is in front of every request and ioredis had no command timeout. There
is one now: `KEYSTONE_REDIS_COMMAND_TIMEOUT_MS`, one second by default.

---

## 3. Running Redis

Redis 7 or later. The server itself needs very little:

```
maxmemory-policy noeviction
```

**`noeviction` matters.** With `allkeys-lru`, Redis evicts keys under memory
pressure — and the keys it evicts are the rate limiter's budgets, which means
the limit silently disappears under load, which is when you least want it to.
A Redis that cannot hold its keys should refuse writes rather than forget
them.

Persistence is a separate question, and the answer is that **Redis does not
need to be persisted** — see [Backup and restore](backup-restore.md). Everything
in it is either derived (the permission cache) or reconstructible (the rate
limiter's windows expire within their window; a lock expires with its TTL).
Restoring a Redis snapshot would restore rate-limit budgets that should have
expired and locks that should have been released.

A managed Redis is the right answer for more than one instance, and a local
Redis is the right answer for one.

---

## 4. Redis in the container

The `redis:7-alpine` image is fine for development. For anything else, set a
password (`requirepass`), and set `REDIS_URL` to include it:

```
REDIS_URL=redis://:the-password@redis.internal:6379
```

TLS is a separate question: if your Redis requires it, use a URL with
`rediss://` and a certificate your server trusts.

---

## 5. Checking it

```bash
# Is it answering?
redis-cli -u "$REDIS_URL" ping

# How many keys, and what shape are they?
redis-cli -u "$REDIS_URL" dbsize
redis-cli -u "$REDIS_URL" --scan --pattern 'keystone:*' | head

# The rate limiter's counters for one client
redis-cli -u "$REDIS_URL" zcard "login:203.0.113.7:someone@example.test"

# The locks, and who holds them
redis-cli -u "$REDIS_URL" --scan --pattern 'keystone:lock:*'
```

The last one is worth knowing before you need it. A lock that is held by a
worker id you do not recognise is a lock left behind by an instance that is
gone; it expires on its own, and `keystone` releases orphaned locks at startup
([startup recovery](migrations.md) covers the rest of that pass).

---

## 6. When Redis is down for a while

1. **Watch the fallback metric.** `keystone_emergency_local_limiter_total` with
   the `allowed` label climbing means clients are getting more attempts than
   the configured budget, and it is worth deciding whether to tighten the
   local budget while Redis is out.
2. **Do not restart the instances to "fix" it.** The fallback is per instance
   and a restart resets it, so a restart loop during a Redis outage hands every
   client a fresh budget on every restart.
3. **Fix Redis, then watch the limiter resume.** The first request after
   Redis returns goes back to the shared budget. Nothing has to be reloaded.
4. **Check the locks when it is over.** An instance that was killed during the
   outage may have left a lock; it expires on its own, and the startup
   recovery releases the orphans.

---

## 7. Related

- [Rate limiting and abuse prevention](../security/rate-limiting.md) — the
  budgets, and the fallback.
- [Running Keystone on more than one instance](../multi-instance.md) — what
  has to be shared, and what happens when it is not.
- [Backup and restore](backup-restore.md) — why Redis is not in the backup.
- [Monitoring](../security/monitoring.md) — the metrics in context.
