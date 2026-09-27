# Rate limiting and abuse prevention

Covers SEC-033 through SEC-039.

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

## What each budget is keyed on

The key matters more than the number.

| Endpoint | Keyed on | Why |
| --- | --- | --- |
| `login` | address **and** submitted address | stops repeated guesses at one account |
| `login-per-address` | address only | bounds spraying, which the first budget cannot see |
| `mfa-verify` | address **and** challenge | the challenge is one login attempt |
| `totp-*` | user | a TOTP code is checked against one account's secret |
| `scim` | credential | one noisy IdP cannot exhaust everyone else's budget |

Two of these were wrong before v2.8.0, and both were found by a test suite that
had been passing for the wrong reason:

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
