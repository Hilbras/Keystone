# Running Keystone on more than one instance

Keystone is a stateless application in front of a stateful database, but
"stateless" is not the same as "you can run two of them without thinking".
Two instances share a database and a Redis, and several things depend on that
sharing working. This document is about what they are, what happens when they
do not, and how to tell which you are in.

---

## 1. What each instance is

An instance is a Keystone process: an HTTP server, a set of background
workers, and a connection to PostgreSQL and to Redis. It serves requests, runs
the queue, delivers webhooks, and writes audit rows.

The instance is **not** where your data lives. The data lives in PostgreSQL.
The instance holds no session state, no signing key cache that matters, and no
list of who is logged in. A request can go to any instance and get the same
answer.

That is the design. It is also the design's *assumption*, and the rest of this
document is the list of things that have to be true for the assumption to hold.

---

## 2. What MUST be shared

### The database

Every instance points at the same PostgreSQL. Not a read replica: the
application writes to it, and a read replica cannot take a write.

Two instances on different databases is the most common way to break a
deployment, and it fails in a way that looks like data loss: a user logs in on
the instance behind the load balancer, refreshes, and the refresh goes to the
other instance, which has never heard of the token.

### The encryption key

`KEYSTONE_ENCRYPTION_KEY` must be **identical on every instance**. It encrypts
the secrets at rest — the TOTP shared secrets, the OAuth client secrets, the
webhook signing secrets. An instance with a different key cannot decrypt what
another instance wrote, and the failure is a decryption error on a record that
looks perfectly ordinary.

Generate it once and distribute it:

```bash
openssl rand -hex 32
```

### The signing keys

The JWT signing keys must be shared too, and there are two ways to do it.

**The environment** — set `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` to the same
pair on every instance. The key id is then the literal `env` on all of them,
so every instance accepts every other's tokens. This is the simple option and
the right one for most deployments.

**The database** — leave them unset and every instance reads the keys from the
`secrets` table. Because they are in the database, they are shared by
construction. Rotating a key in this mode keeps the old one valid for 24 hours
(so tokens signed with it still verify) and then retires it.

What you must not do is mix the two: one instance with the environment keys
and another reading from the database will not verify each other's tokens,
because the key ids differ.

### Redis

Redis holds the state that has to be shared between instances: the rate
limiter's budget, the distributed lock, the permission cache, and the anomaly
counters. See [Redis](OPERATIONS/redis.md).

The rule is the same one as for the database: **every instance points at the
same Redis**. A rate limiter that counts per instance is not a rate limiter.

---

## 3. What happens with N instances

| thing | with one instance | with N instances |
|---|---|---|
| rate limiting | one budget | one shared budget, counted in Redis |
| a login | one session row | one session row; any instance serves it |
| a webhook delivery | one worker delivers it | one worker claims it; the claim is exclusive |
| a refresh-token rotation | one writer | the rotation is atomic; exactly one wins |
| the platform owner | one row | one row; the bootstrap is serialized by an advisory lock |
| background jobs | one worker | one worker per instance, each taking different jobs |

The webhook delivery is the case worth understanding, because it is the one
where two instances can genuinely try to do the same thing.

A delivery is **claimed** before it is sent, and the claim is a single
conditional update:

```sql
update webhook_deliveries
   set status = 'processing', locked_at = now(), locked_by = <worker id>
 where id = ?
   and (status = 'pending' or (status = 'processing' and locked_at < <stale cutoff>))
```

Exactly one worker's update matches a row that is pending. The others match
nothing and send nothing. If a worker dies holding the claim, the claim goes
stale after ten minutes and another instance takes it — and the delivery
carries the **same delivery id** on every attempt, so a consumer that receives
it twice can tell that it is the same event and drop the duplicate.

The delivery is therefore **at-least-once**, not exactly-once. A consumer must
deduplicate on `X-Keystone-Delivery` (or `X-Keystone-Event-ID`, which is
stable across every endpoint subscribed to the same event). See
[Webhooks](security/webhooks.md).

---

## 4. The queue

The queue provider is chosen by `KEYSTONE_QUEUE_PROVIDER`:

- **`in-process`** (the default) — jobs run in the process that enqueued them.
  With one instance that is exactly right. With several, each instance runs
  its own workers and takes the jobs that arrive on it. Nothing is lost when
  an instance dies: the job was already running, and the work it was doing
  either finished or did not.
- **`bullmq`** — jobs are stored in Redis and any instance can take any job.
  Use this when the queue is the thing you care about surviving: a job enqueued
  by an instance that then dies is still picked up.

For several instances, `bullmq` is the better answer, and it needs the Redis
that every instance already shares. Set it on every instance:

```
KEYSTONE_QUEUE_PROVIDER=bullmq
```

A mixed deployment — some instances `in-process`, some `bullmq` — works, but
the `in-process` instances cannot see the `bullmq` jobs, so the load is
uneven. Pick one.

**Never run the in-process provider in production with more than one
instance** and expect the queue to be shared. It is not, and no metric will
tell you.

---

## 5. The setup bootstrap

The first run of a new deployment creates the platform owner. Two instances
starting at the same time must not both create one.

The bootstrap is serialized by a **PostgreSQL advisory lock** — a session-level
lock, taken on a reserved connection so it belongs to one session for the whole
operation. The loser waits, and when the lock is released it finds that an
owner now exists and refuses.

That lock is released when the session ends, which includes the session ending
because the process was killed. A crashed instance does not leave the
bootstrap locked.

---

## 6. Load balancing

Any load balancer will do. Two things matter:

- **Session affinity is not required.** There is no server-side session, so a
  request may go to any instance. Affinity, if your infrastructure sets it, is
  a small optimisation and nothing more.
- **The instance's own address must be right.** Keystone uses the client
  address for rate limiting and for the audit log. Behind a proxy, that is the
  *proxy's* address unless you tell Keystone otherwise — see
  [Proxy and trust boundaries](security/proxy-security.md). With a proxy
  configured wrongly, every client looks like one client, so they share one
  rate-limit budget, and the audit log records the proxy rather than the
  caller.

The health endpoints are the ones a balancer or an orchestrator should use:

| endpoint | answers | use it for |
|---|---|---|
| `/health/live` | 200 while the process is up | liveness — "should this be restarted?" |
| `/health/ready` | 503 when a dependency is down | readiness — "should this receive traffic?" |
| `/health/startup` | 200 once boot has finished | startup — "has it finished starting?" |

The distinction is the point. A liveness probe that fails while PostgreSQL is
down turns a dependency outage into a restart loop, and a pod that is restarted
during an outage does not come back when the dependency does.

---

## 7. What to check when something is wrong

**A user is logged out on one device but not another.**
The two instances disagree about something they should share. Check, in this
order: the encryption key (different values), the signing keys (mixed sources),
and the database (different databases).

**The rate limit is not shared.**
The instances are not pointing at the same Redis, or one of them is failing
over to the local emergency budget because it cannot reach Redis. The metric
`keystone_rate_limit_redis_errors_total` counts the failures and
`keystone_emergency_local_limiter_total` counts the fallback engaging.

**A webhook is delivered twice.**
That is at-least-once delivery working as designed. Check that the consumer
deduplicates on `X-Keystone-Delivery`. If the consumer cannot, the delivery
is the wrong shape for it — see [Webhooks](security/webhooks.md).

**A webhook is never delivered.**
The endpoint's URL is probably being refused by the outbound policy — a
private address, a non-HTTPS scheme, a redirect. The refusal is recorded on
the delivery row and in the audit log, with the reason.

**A job ran twice.**
The provider is `bullmq` on some instances and `in-process` on others, or the
same job was enqueued twice by different code paths. The queue metrics carry
the provider, so a mixed deployment is visible.

---

## 8. A worked example

Three instances behind a load balancer, with managed PostgreSQL and managed
Redis:

```
                 ┌──────────────┐
   clients ────► │  load        │
                 │  balancer    │
                 └──┬───┬───┬───┘
                    │   │   │
              ┌─────┘   │   └─────┐
              ▼         ▼         ▼
        keystone-1 keystone-2 keystone-3
              │         │         │
              └─────────┼─────────┘
                        │
              ┌─────────┴─────────┐
              │                   │
        PostgreSQL            Redis
       (shared)             (shared)
```

Every instance has the same `DATABASE_URL`, the same `REDIS_URL`, the same
`KEYSTONE_ENCRYPTION_KEY`, and the same signing keys — either the same
`JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` pair, or neither of them set so both read
from the database.

```bash
KEYSTONE_QUEUE_PROVIDER=bullmq
KEYSTONE_ENCRYPTION_KEY=<one value, every instance>
DATABASE_URL=postgres://…
REDIS_URL=redis://…
```

Then scale the deployment. Nothing else changes.
