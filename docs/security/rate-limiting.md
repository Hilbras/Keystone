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

## What is deliberately not limited (3.5.1)

CodeQL's `js/missing-rate-limiting` names 21 routes. Making the judgement per route
corrected the number in **both** directions, and the corrections matter more than
the total.

### The 9 that were already limited

`auth.ts` token-login ×2, `oauth2` authorize and token, `smsOtp` verify, `totp` ×4.

The rule looks for a `rateLimit` call in a route's own options and misses it in two
ordinary shapes: a limiter inside a `preHandler` array declared on a preceding
line, and a limiter behind a named helper — `factorRateLimit("totp-verify")` is how
this file has always done it. **Nine of 21 alerts were routes that were already
protected**, and a number that wrong in that direction trains people to dismiss the
tool.

### The 8 that were not, and now are

| route | what an attacker supplies |
|---|---|
| `GET /federation/:provider/callback` | a provider token, completing a login |
| `GET /auth/callback/:provider` | as above, the other federation route |
| `GET /sso/sso/oidc/:connectionId/callback` | an enterprise SSO authorization code |
| `GET /auth/magic-link/verify` | **a token in the query string** |
| `GET /sso/saml/:connectionId` | a connection id, starting IdP-initiated SSO |
| `POST /sso/saml/acs` | **a signed assertion**, verified for you |
| `POST /auth/webauthn/authenticate/options` | an email address, minting a challenge |
| `POST /auth/webauthn/authenticate/verify` | a challenge, completing a login |

The two in bold are the ones that were worth the most attention. The magic-link
verifier is the most brute-forceable route in the system — the token is in the URL,
so there is no body and no header, just a link. And the SAML ACS is an
unauthenticated endpoint that accepts an attacker-supplied assertion and runs
signature verification on it: a CPU cost chosen by whoever is calling, which is the
classic SAML DoS shape.

Each is keyed on its **own** prefix, so a flood against one cannot deny service to
another, and each has `emergencyLocalLimit: true`, so a Redis outage degrades to a
bounded per-process budget rather than removing the limit at the moment an attacker
would most like it gone.

`src/tests/security/rateLimit/unauthenticatedSurface.test.ts` drives each route 60
times and requires a 429 with a `Retry-After`. Verified by deleting the magic-link
verifier's limiter and watching that one test fail.

### The 3 that stay unlimited, on purpose

- **`GET /sdk/keystone-dropin.js` and `GET /sdk/keystone-dropin.js.sri`** — a
  static file and its integrity hash. A browser and a CDN fetch these; limiting
  them breaks caching and protects nothing.
- **`POST /setup/init`** — guarded by `assertSetupToken`, one-shot, and an
  operator's *first* request to a new installation. A rate limit here can lock
  somebody out of their own deploy, which is a support incident **caused by a
  security control**.

Written down because an omission nobody recorded looks exactly like an oversight,
and the next person to read `js/missing-rate-limiting` will find these three and
have no way to tell they were decided.

### One that is authenticated

`POST /auth/webauthn/register/verify` sits behind `app.authenticate`, so an attacker
already holds a credential. Bounded by the session rather than by an IP budget,
which is the right boundary for it.

## Related

A failed login is audited as `user_login_failed`, and a refresh token presented
twice is detected as `refresh_token_replayed` — see
[audit.md](./audit.md). A session surviving a password change is covered in
[trust-boundaries.md](./trust-boundaries.md).
