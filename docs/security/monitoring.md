# Monitoring and background work

Covers SEC-053 and SEC-054. Both were found by §4.4 asking for job retry and
dead-letter coverage, and both are about **counts that a human reads**.

# Health, readiness and probes

Covers SEC-056 and SEC-057. Both are about a probe that could not report what it
claimed, found by §5.2 writing the test that makes `/ready` fail with the database
unreachable.

## A counter that never moved (found on the way)

`keystone_failed_logins_total` was registered in `src/plugins/metrics.ts` and
incremented from nowhere. It exported as a series with value 0, forever.

That is worse than an absent metric. An absent metric is obviously absent; a
registered one reads as **zero**, and zero is the reading a failed-login alert
would take at face value. It is now fed by `services/events/subscribers/metrics.ts`,
an event-bus subscriber rather than a call in the route, because the event is
emitted from six places and the route is only one of them —
`services/domain/authentication.ts` emits `user_login_failed` with five distinct
reasons (`unknown_user`, `invalid_password`, `account_deactivated`,
`account_reviewed`, `account_locked`) from the login service itself.

`reason` is the label rather than a constant, so a new failure mode appears as a
new series value instead of being folded into "failed" and becoming invisible.

## The general form, so the next dead counter is caught too

The suite asserts that **every registered series has a call site** in `src/`:

```ts
const unwired = registered.filter(
  (name) => !sources.some((t) => t.includes(`"${name}"`) && /\.(inc|observe|set|reset)\s*\(/.test(t))
);
assert.deepEqual(unwired, []);
```

A behavioural version of this — "every series moved after this traffic" — is the
wrong shape. `keystone_cache_hits_total` is perfectly alive and no amount of
logging in and out of the server touches it, so the assertion would be about
which subsystems a test happens to exercise. What actually rots is the *pairing*
between a registered name and the code that writes to it, and that is a static
property of the source. Rename a series and the call site stops matching; delete
the call site and it stops matching. Both fail.

## SEC-054, medium — every unmatched URL was its own time series

```ts
const route = request.routeOptions?.url || request.url;   // before
```

For a request that matched no route there is no template, so the fallback was the
concrete URL — and every distinct 404 became a permanent, individually-labelled
series:

```
keystone_http_requests_total{method="GET",route="/nope/aaaaaaaa-1111",status_code="404"} 1
keystone_http_requests_total{method="GET",route="/nope/bbbbbbbb-2222",status_code="404"} 1
```

Two requests, two series, no upper bound on how many follow. A scanner, a
crawler, or a client with a URL bug grows the count without limit, and unbounded
label cardinality is the standard way a metrics endpoint takes a Prometheus server
down.

The failure is silent. The endpoint keeps answering; the only symptom is a
Prometheus that runs out of memory hours later.

Unmatched requests are now labelled with the constant `unmatched`. 404 volume is
still visible and still alertable — that is what `status_code` is for — and the
series count is bounded by the number of routes.

## SEC-056, high — the deployment advertised a readiness probe that could not fail

`/ready` **did not exist.** `README.md` documented `GET /health` and `GET /ready` as
probe endpoints, and `k8s/base/deployment.yaml` pointed its `readinessProbe` at
`/health` — the only one of the two that was real.

`/health` returns `{status: "ok"}` unconditionally and touches nothing external. So
a pod with no database was reported **ready**, kept in the load balancer's rotation,
and every authenticated request it received failed. The traffic was sent to a pod
that could serve none of it, which is the specific failure a readiness probe exists
to prevent.

It pointed at `/health` because `/ready` had never been written. The documentation
described a capability; the manifest had to improvise one.

### The two are separate, and the gate is the separation

| | question | touches | PostgreSQL down | Redis down |
|---|---|---|---|---|
| `/health` | is this process alive? | nothing | **200** | **200** |
| `/ready` | can it serve a request now? | both | **503** | **200** `degraded` |

`/health` must not depend on PostgreSQL. A liveness probe that does turns a
transient database blip into three failed probes and a restart — a healthy process
killed, which is a worse outage than the one it was reacting to.

`degraded` answers 200 deliberately. Redis down means the queue is in-process and
the rate limiter is on its local fallback, so the pod can still authenticate.
Removing every pod from the rotation would take authentication offline entirely
for a recoverable degradation. The signal belongs in metrics and alerting, and
`checks.redis.ok === false` is in the body for anything polling it.

Both checks are **real commands** — `select 1` and `ping` — not `db !== undefined`
or a status read:

- A pool that exists is not a database that answers, and a pool whose connection
  has gone stale still exists.
- Redis is asked with `ping` rather than `isRedisReady()`, because the shared
  client is created with `lazyConnect`: its status is `"wait"` until some *other*
  code path issues a command, so a status guard reports "not ready" on a process
  that has simply not used Redis yet. This is the same trap the permission cache
  fell into in 3.2.0.

Each is bounded at 2s and they run in parallel, so the budget is 2s rather than 4s.

## SEC-057, medium — a Redis outage made the probe unable to report the Redis outage

Both probe endpoints sat behind the **global rate limiter**, which is an
`onRequest` hook and so runs *before* the route handler. The limiter uses Redis.

With PostgreSQL and Redis both unreachable, over a real socket:

```
handler's own verdict      2.0s   (every call)
1st HTTP response          8.1s
2nd HTTP response         20.3s
3rd HTTP response         20.4s
```

The time was spent in the limiter, not in the probe. Against
`timeoutSeconds: 5` in `k8s/base/deployment.yaml`, the kubelet would have recorded a
**timeout** rather than the 503 — during precisely the outage the probe exists to
report.

With Redis healthy the same call took **31ms**, which is what identified the
limiter rather than the probe as the cause. After the exemption: 576ms, 2.0s, 2.0s.

A probe that cannot report the outage is worse than no probe, because it looks like
one.

## Measuring this took a process of eliminations

Three things had to be ruled out before the limiter was implicated, and the
measurements are worth keeping because the obvious candidate was wrong twice:

| hypothesis | test | result |
|---|---|---|
| the probe's own timeout is too long | per-check latencies in the response | 2.0s — the handler is fine |
| `ioredis` queues the abandoned `ping` | replaced `ping()` with a status read | still 20s — not ioredis |
| `app.inject` resolves late, so the 20s is an artefact | hit a **real socket** with `fetch` | still 20s — it is real |
| the global rate limiter | dead database, **healthy** Redis | **31ms** — the limiter, confirmed |

The third row is the one that mattered most. If `inject` had been the source of the
delay, the fix would have been aimed at the test and the probe would have shipped
still taking twenty seconds during an outage.

## Two traps in the test itself

### A cache-buster does not reach the dependencies

The first attempt to build a server with no database was
`import("./index.js?dead-db=1")`. That evaluates a second copy of `index.ts` — and
`index.ts` does `import { db } from "../db/index.js"`, which resolves to the
**already-cached** module. The "broken" server got the healthy pool, reported 200,
and the first version of the test asserted nothing.

`src/tests/helpers/deadDatabaseProbe.ts` is a separate process instead: separate
module registry, separate pool, separate everything, which is also what a
deployment looks like.

### `return reply;` from an async `onRequest` hook deadlocks the request

The exemption for the probe paths was first written as `return reply;` and **every
probe request hung until its client gave up**. Fastify is being handed a value it
treats as a continuation; `undefined` is the only thing that means "carry on". The
cost of getting it wrong was a probe that could not answer at all, which is the
failure this whole change exists to remove. The bare `return;` carries a comment
saying so.

## The manifest gate (§5.4)

`scripts/verify-k8s-manifests.mjs` renders `k8s/base` and both overlays and fails
on:

- **a readiness probe not pointing at `/ready`** — verified by putting it back to
  `/health`, which is the original defect;
- a liveness probe not pointing at `/health`;
- an image tag that is `:latest` or disagrees with `package.json` — verified by
  restoring `newTag: latest`, which is what it was;
- a container with no CPU or memory limit, or no request — verified by deleting
  the limits block;
- a variable `config.ts` insists on that no ConfigMap or Secret provides;
- an `envFrom` reference to a resource no manifest defines;
- a placeholder, or an unfilled `<PLACEHOLDER>`.

It runs in the `gates` job and is now a required check on `main`.

### The image tag lives in the kustomization, not the Deployment

```yaml
images:
  - name: ghcr.io/hilbras-dev/hilbras-keystone
    newTag: 3.4.0
```

A kustomization `images` entry **overrides** the tag in `deployment.yaml`, so
`newTag: latest` made the Deployment's own tag decorative. The check compares the
*rendered* result against `package.json`, which is the only comparison that can
tell the truth about what a deployment would run.

### A hand-rolled YAML reader needed its own gate

The manifests are read by a parser in `scripts/lib/yaml.mjs` rather than a
dependency, so the check has no second failure mode. That parser had three bugs,
each of which made the gate report something false:

| bug | symptom |
|---|---|
| list items with an inline key spliced two code paths together | the **second `envFrom` entry was dropped**, so `DATABASE_URL` was reported unreachable while the manifest provided it |
| a list of plain strings (`resources:`) parsed as an object | the gate threw on `resources is not iterable` |
| `containersOf` read `spec.containers` | a Deployment has them at `spec.template.spec.containers`, so it returned nothing and **the entire Deployment block was dead code** |

The third is the one worth dwelling on. The gate printed

```
Kubernetes manifests OK.
  version: 3.4.0 (manifest image tag matches package.json)
```

while the image was `:latest`. The summary line claimed a check that had never run
— a check that could not fail, which is the failure this whole programme has been
about. It was visible only because the summary asserted something the reader could
contradict by looking at the file.

Two things came out of it that are now permanent: `scripts/lib/patch.mjs`, which
throws when a replacement matches nothing (a `str.replace` that changes nothing is a
silent no-op that looks exactly like a success — one of these migrations reported
"manifests pinned to 3.4.0" for a pattern indented two spaces off), and the habit of
checking a claim against the file it is about.

## SEC-053, high — three counts, all wrong

### `isFailedLoginAnomaly` was a predicate that mutated what it measured

```ts
export async function isFailedLoginAnomaly(identifier: string): Promise<boolean> {
  const count = await recordFailedLogin(identifier);   // asking *records*
  return count >= FAILED_LOGIN_THRESHOLD;
}
```

Every call site therefore counted the failure **twice** — once through the
`user_login_failed` subscriber, once by asking — and with a threshold of 10 the
spray signal fired after **5** real failed logins.

Measured, before the fix:

```
after 1 real failed login(s): counter = 2
after 2 real failed login(s): counter = 4
after 3 real failed login(s): counter = 6
after 4 real failed login(s): counter = 8
after 5 real failed login(s): counter = 9
after 6 real failed login(s): counter = 10
```

Measured, after: `1, 2, 3, 4, 5, 6`.

The fix splits the two operations, because a name like `is...` on a function that
writes is the kind of signature that makes the *next* call site wrong too:

```ts
export async function countFailedLogins(identifier: string): Promise<number>  // read
export async function isFailedLoginAnomaly(id: string): Promise<boolean>       // read
export async function recordFailedLogin(identifier: string): Promise<number>   // write
```

`isNewDeviceAnomaly` had the same shape and is fixed the same way.

### The route published the same event the domain service had already published

`audit()` **is** `emit()` — there is no separate audit log; the `audit_log` table
is written by a subscriber. So `request.audit("user_login_failed")` in
`routes/auth.ts` published the event a second time, for every failure, on both
login paths.

That call site was written when "a wrong password produced a 401 and nothing else,
so credential guessing was invisible except through the limiter". By the time it
was written the domain service was already emitting the event with the reason and
covering all five refusal paths — including the ones that return before the route
can audit. Two owners for one event, and the duplicate arrived second and without
a reason.

The domain service is the right owner: it covers every path, it carries the
reason, it fires for the CLI and any future transport, and the route's copy added
only a request id.

### A poison job crashed the process

```ts
setTimeout(() => this.run(job, attempt + 1), delay);   // the promise is discarded
```

`enqueue` attached `.catch()` to the *first* attempt. The retries were
unprotected, so the attempt that exhausted the budget threw into an unhandled
rejection — and Node terminates a process on an unhandled rejection. One poison
job took the server down.

`createQueue()` prefers BullMQ whenever `REDIS_URL` is set, so this affects the
in-process driver: a deployment with no Redis, which is exactly the degraded
configuration where a crash is least welcome.

The retry's promise is now caught, and the exhausted job is logged and dropped.

## What the queue suite pins

`src/tests/integration/queue.test.ts` covers what the old one-test file did not:

| | in-process | BullMQ |
|---|---|---|
| enqueue → execute | ✔ | ✔ |
| retry up to the attempt budget | ✔ | ✔ |
| stops at the budget | ✔ | ✔ |
| counted failed **once**, not once per attempt | ✔ | — |
| dead-letter retrievable afterwards | **no** | ✔ |
| stats reported | ✔ | ✔ |
| an unroutable job is not counted as work | ✔ | — |

The "no dead-letter" row is a real limitation of the in-process driver, asserted
rather than skipped so it cannot be mistaken for tested behaviour: `getFailed`
returns `[]` and `retryAll` is a no-op, so there a permanently failing job is lost
— a log line and a counter, and nothing an operator can re-run. The BullMQ driver
keeps them, which is one more reason it is the default.

## The SEC-053 regression, in the same file

One real failed login must produce exactly one anomaly entry, asserted attempt by
attempt rather than as a total, and a successful sign-in must leave the count at
zero. Alongside it, the structural case:

> **counting does not itself count** — `recordFailedLogin` once, read five times,
> assert the count did not move.

That one is what stops the predicate and the recorder collapsing back into each
other. A suite that only checks the end-to-end total would still pass if someone
merged them again and moved the double count somewhere else.

## SEC-055, high — four defects in the CLI

177 lines, eight commands, and no tests, for the interface an operator reaches for
when something has already gone wrong. Each command is now run as a real
subprocess against the real database, because the exit code is the whole of what a
CLI's caller observes, and the things that were broken are exactly the things an
in-process test cannot see.

**`user:create` never worked.** The CLI called `register`, which mints a token,
but never called `loadSigningKeys()` — the server does that during bootstrap. Every
invocation failed with `JWT signing keys not loaded`. This is the command that
creates the **platform owner**, so it is the first thing anyone runs on a new
deployment.

**Every command that opened a connection hung.** `org:create` printed
`Created organization <id>` and then sat there forever. The operator's response to
a hung command is Ctrl-C, which destroys the exit code that would have said the
work was done.

The fix took two attempts, and the first one looked complete:

```
closing only the pool:   migrate ✔   keys:list ✔   user:create ✖   org:create ✖
closing all three:       all exit 0
```

`initializeContainer()` left three Redis sockets open — one shared client, and a
second created inside the `cache` constructor. A partial fix here is worse than
none, because the commands that work make the ones that do not look like a
different bug.

**`secrets:rotate` reported success while rotating nothing.** The environment
provider has no key material to rotate: it comes from `JWT_PRIVATE_KEY`. The old
implementation nulled its cache and re-imported the same key, and the command
printed `Rotated signing key. New key id: env`. It now throws with instructions.

The decision the roadmap asked to be made explicitly: with the environment
provider, `secrets:rotate` **must fail loudly**. It cannot be idempotent, because
there is nothing to be idempotent about, and generating a fresh pair in-process
would be worse — every instance reads the same environment variable, so each
would mint a *different* key and the cluster would stop agreeing on who signed
what. With the database provider, which stores keys and can genuinely rotate, each
call is a real rotation and the key is asserted to change.

**`--version` was hardcoded to `1.9.0`** against a package at 3.3.0. Nothing
noticed, because a test asserting `"1.9.0"` passes just as long as nobody
remembers to update it — so the test compares against `package.json` instead.

### Verified by breaking all four

| restored behaviour | result |
|---|---|
| as shipped | 19 pass |
| all four reverted | **8 pass, 11 fail** |

The 11 include the hang cases, which fail by timing out at 30 seconds each. That
is the correct shape for this defect: the assertion is "did it return on its own",
and a command that never returns cannot be tested any other way.

## `/metrics` is unauthenticated, and that is deliberate — with one obligation on you

`GET /metrics` carries no authentication and is exempt from the global rate limiter. Both
are decisions, and both are recorded:

- **Exempt from rate limiting** because a scrape endpoint behind a limiter fails the way a
  dashboard failing at 3am fails: the scraper receives 429s, stops, and the metrics are
  gone exactly when something is wrong and they are the thing that would have said so.
  Prometheus has no way to back off politely.
- **Unauthenticated** because a scrape credential is a long-lived secret in every
  Prometheus configuration in the world, and a metric endpoint that needs one is a metric
  endpoint that gets deleted from the scrape config during an incident.

What it exposes: route templates (`/v1/admin/organizations/:id`, not the id), request
counts and duration histograms by method/route/status, error rates, failed-login counts,
and process metrics. **It exposes no tenant data** — no email addresses, no organization
names, no token material.

`k8s/base/service.yaml` is a `ClusterIP`, so in the shipped manifests `/metrics` is
reachable from inside the cluster and not from outside it.

### If you put an Ingress in front of Keystone, exclude `/metrics`

This is the part that is easy to get wrong by accident. The shipped Service is internal, so
a deployment that never adds an Ingress is fine. A deployment that adds one inherits every
path on the app's port, `/metrics` included, and will publish the route table and traffic
shape to the internet unless the Ingress says otherwise.

```yaml
# the exclusion, not a whole resource
nginx.ingress.kubernetes.io/server-snippet: |
  location /metrics { deny all; return 404; }
```

Verify it after deploying, rather than trusting the annotation:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://your-host/metrics   # want 404, not 200
```

**Recorded 3.5.10.** The requirement was previously implied by `ClusterIP` and stated
nowhere, which is the same shape as the tooling gap fixed in that release:
`review-api-surface.mjs` had never seen this route, so no tool had ever asked why it was
public. It is in `PUBLIC_BY_DESIGN` — including this obligation — because a decision that
carries an obligation should say so where the obligation is easy to find.
