# Rate limiting and abuse prevention

Covers SEC-033 through SEC-039, and SEC-047.

## Redis is the primary limiter, and there is a fallback

`isAllowed()` returned `true` whenever Redis was unavailable. During an outage,
`login`, `mfa/verify`, `sms-otp/verify` and the OAuth token exchange had **no
limit at all**.

That is backwards. An outage is exactly when unlimited attempts are worth
having — it is the moment a burst of guessing no longer looks like a burst,
because there is no single event stream showing the ramp.

Sensitive endpoints now set `emergencyLocalLimit: true`, which falls back to
`src/services/localRateLimit.ts` when Redis is down or errors mid-request.

The fallback is strictly weaker than the distributed limiter: a client gets one
budget **per instance**, so a fleet multiplies the allowance. That is a
degradation worth having. Unbounded is not.

The store is capped at 10,000 keys. An unbounded map keyed by client address is
itself a denial-of-service vector — rotating addresses would grow it without
limit — so expired windows are swept and the oldest are evicted at the cap.
Eviction only ever forgets an already-expired window, so it grants no extra
budget; there is a test for that specifically.

Endpoints that limit without `emergencyLocalLimit` still fail open. That is
deliberate: the fallback is per-instance, and applying it to high-volume
low-value endpoints would trade a real availability problem for a small
reduction in abuse resistance.

## The primary limiter was not running (SEC-047, 3.2.0)

Everything above describes a design in which Redis is the limiter and the
in-process window is the fallback. In practice the fallback was the *only* path,
because of the same mistake twice over.

`checkLimit` opened with:

```ts
if (!isRedisReady()) return <the local decision>;
```

The shared client is created with `lazyConnect`, so on a fresh process its status
is `"wait"` and `isRedisReady()` is false. The guard returned the local budget
**without ever issuing a command** — so the client stayed lazy, so the next
request reached the same verdict, and Redis was never reached on any request.

Whether rate limiting was shared across a fleet depended on whether some
unrelated code path happened to touch Redis first: the queue, anomaly detection,
or — as of 3.2.0 — the new permission cache. A deployment where nothing did had
one budget per instance, which is exactly what the distributed limiter exists to
prevent.

Three controls were inert as a result:

| Control | What it was doing instead |
|---|---|
| `login` / `mfa/verify` emergency local limit | limiting per instance, so a client could multiply a brute-force budget by the instance count |
| `scim-auth:<address>` — the pre-authentication budget on `/scim/v2/*` | **nothing**. It is called with `useEmergencyLocal: false`, so it failed open on every request: an unauthenticated surface with no budget at all. |
| the global `onRequest` limiter | the same, failing open |

The fix is to attempt the command and let a real failure select the local path.
A lazily-connecting client connects on its first command, so there is nothing to
poll:

```ts
try {
  const count = await redis.eval(slidingWindowLua, /* ... */);
  return { allowed: count < maxAttempts, limiter: "redis", /* ... */ };
} catch {
  return localDecision(key, maxAttempts, windowSeconds, useEmergencyLocal);
}
```

Regression tests: `src/tests/security/rate-limiting/backend-choice.test.ts`.

It was found by accident, which is worth recording. Adding the permission cache
made it issue a command on the same client, which connected it, which switched the
limiter from per-instance to shared — and the security suites' aggregate request
count immediately exceeded a budget that had never applied to them. A control
that was quietly off is invisible until something turns it on.

The test scripts raise `GLOBAL_RATE_LIMIT_MAX`, `SCIM_AUTH_FAILURE_MAX` and
`SCIM_RATE_LIMIT_MAX`. That is the values, not the limiter: a suite fires
hundreds of requests from one loopback address in under a minute, which is not an
attack, and throttling it produces failures that say nothing about the code.
`abuse-prevention.test.ts` and `backend-choice.test.ts` exercise the real limits
and are unaffected.

## What each budget is keyed on

The key matters more than the number.

| Endpoint | Keyed on | Why |
| --- | --- | --- |
| `login` | address **and** submitted address | stops repeated guesses at one account |
| `login-per-address` | address only | bounds spraying, which the first budget cannot see |
| `mfa-verify` | address **and** challenge | the challenge is one login attempt |
| `totp-*` | user | a TOTP code is checked against one account's secret |
| `scim` | credential | one noisy IdP cannot exhaust everyone else's budget |

`login-per-address` only became address-only in 3.2.0. The key was
`prefix:identifier:submittedAddress` for every limiter, so it was keyed on address
**and** account — the same shape as the budget beside it, and no control on
spraying at all. The key composition is now the explicit option
`includeSubmittedAddress`, which defaults to the old behaviour so that no other
limiter moved, and both `login-per-address` budgets set it to false. The table
above described the intent the code did not implement; see SEC-048.

Four of these were wrong before 3.2.0, and all of them were found by a test suite
that had been passing for the wrong reason:

- `mfa-verify` included `body.email`, which that endpoint does not carry. So
  every second-factor verification from one address shared a budget of 20. An
  attacker got 20 guesses; so did an office behind a single NAT, where ordinary
  traffic could lock out every legitimate second-factor login.
- `totp-*` allowed 10 attempts keyed on the address alone, on **authenticated**
  routes, with the same consequence.

## Credential spraying

The login budget is keyed on address *and* submitted address, so it stops
repeated guesses at one account and does nothing about an attacker who varies
the address on every request and guesses across a thousand accounts from one
host. A second, address-keyed budget bounds that independently.

## A refused request is recorded

A rate-limit trip produced a `429` and nothing else. Sustained guessing at
`login` or `mfa/verify` was invisible except in aggregate — the requests that
most warranted attention were the only ones absent from the log.

`rate_limit_triggered` now records the endpoint, the client address, and
**which limiter decided**. `redis`, `local` and `none` are three distinct
operational situations, and a degraded in-process control is a reason to go and
look at Redis. Recording it as if it were the healthy path would hide exactly
the thing worth knowing.

## Related

A failed login is audited as `user_login_failed`, and a refresh token presented
twice is detected as `refresh_token_replayed` — see
[audit.md](./audit.md). A session surviving a password change is covered in
[trust-boundaries.md](./trust-boundaries.md).
