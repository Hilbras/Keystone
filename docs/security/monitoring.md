# Monitoring and background work

Covers SEC-053 and SEC-054. Both were found by §4.4 asking for job retry and
dead-letter coverage, and both are about **counts that a human reads**.

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
