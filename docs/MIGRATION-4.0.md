# Migrating to Keystone 4.0.0

Keystone 4.0.0 declares the contracts that 3.x changed and never wrote down.

**This is a breaking release, and the breaking part is mostly paperwork.** The
behaviour 4.0.0 freezes is the behaviour 3.14.0 already had. What 4.0.0 adds is
the record: every contract a caller can depend on is snapshotted and gated, so
it cannot drift again without a diff appearing in a pull request.

The reason this guide is long is not that 4.0.0 changed a great deal. It is
that **3.x changed a great deal and never said so.** Between 3.0.0 and 3.14.0
there are at least a dozen client-observable breaks — a status code here, a
rate limit there, a payload that lost a field — and the changelog for that
range contains no `BREAKING:` block at all. This guide covers them
retroactively, because a consumer upgrading from 3.0.0 to 4.0.0 meets all of
them.

**If you are upgrading from 3.14.0, you have already made every change below.**
Read §1 only to confirm the frozen contract, and skip the rest.

---

## Summary

### Client-facing

| # | Change | Impact |
| --- | --- | --- |
| 1 | A schema violation answers **400**, not 500 | **Breaking** — a 500-retry loop now never fires |
| 2 | A database that cannot be reached answers **503**, not 500 | **Breaking** — retry policies keyed on 500 must change |
| 3 | Error bodies carry `code` and `requestId` | **Breaking for strict parsers** — additive otherwise |
| 4 | The global rate limiter is enforced | **Breaking** — clients that never saw a 429 will |
| 5 | The anti-spraying budget is keyed on the address alone | **Breaking** — shared egress IPs are throttled |
| 6 | Rate limits on previously unlimited routes | **Breaking** — 429 + `Retry-After` on eight routes |
| 7 | A replayed refresh token revokes the **family**, not the account | **Breaking** — other devices stay signed in |
| 8 | A replayed token is detected on the OAuth grant path too | **Breaking** — a replayed refresh now fails |
| 9 | Webhook URLs are validated; a refusal is 400 and is not retried | **Breaking** — a private target is refused |
| 10 | Webhook delivery no longer follows redirects | **Breaking** — a 3xx is a terminal failure |
| 11 | The query string is dropped from logs, audit rows and webhook events | **Breaking** — a data-shape change |
| 12 | `GET /setup/status` no longer reports `setupToken` | **Breaking** — a field is gone |
| 13 | `POST /setup/init` race losers get 409 or 403 | **Breaking** — a second caller is refused |
| 14 | Frontend authentication is cookie-only | **Breaking** — the token is not in storage |
| 15 | `revoke-all` revokes every token and session | **Breaking** — the scope is wider |
| 16 | The refresh-rotation metric label changed | **Breaking for monitoring** |
| 17 | A failed PKCE proof no longer burns the code | Improvement — a retry now works |
| 18 | An unknown `kid` is rejected before verification | **Breaking** — a different error |

### Deployment-facing

| # | Change | Impact |
| --- | --- | --- |
| 19 | Minimum Node **22 → 26** | **Breaking** — the runtime must move |
| 20 | A production-like boot refuses unsafe configuration | **Breaking** — the process will not start |
| 21 | Startup verifies the schema and refuses to start on a failed migration | **Breaking** — migrations must succeed |
| 22 | SIGTERM/SIGINT trigger an ordered, bounded shutdown | **Breaking** — the exit code can be 1 |
| 23 | The image runs non-root | **Breaking** — volume permissions |
| 24 | `KEYSTONE_ENCRYPTION_KEY` wraps the signing keypair at rest | **Breaking** — the key must be set |
| 25 | Plain-HTTP webhooks are restricted to loopback, with an opt-in | **Breaking** — staging URLs stop working |
| 26 | `AUDIT_WEBHOOK_URL` goes through the outbound URL policy | **Breaking** — a private URL is refused |
| 27 | The k8s Ingress moved to a new overlay | **Breaking** — the apply target changes |

A migration runs automatically on boot. It is additive: no column is dropped
and no data is rewritten.

---

# Client-facing changes

## 1. A schema violation answers 400, not 500

```
BREAKING:
Old behavior: A request that failed schema validation answered 500, with the
  raw validation issues in the body.
New behavior: It answers 400 with code VALIDATION_ERROR, the failing fields
  under details, and no raw validation text.
Migration: Stop retrying on 500. Branch on 400 as "the request is wrong" and
  on 5xx as "the server is wrong". Read details[] for the field names; the
  free-text validation issues are no longer there.
Reason: A validation error is the caller's mistake, and answering 500 for it
  told every client with a retry-on-5xx policy to try again — with the same
  wrong request, forever. It also put the server's internal validation
  vocabulary in the response.
```

The body:

```json
{
  "error": "Invalid input",
  "code": "VALIDATION_ERROR",
  "details": [{ "path": ["email"], "message": "Invalid input: expected string, received undefined" }],
  "requestId": "…"
}
```

## 2. A database that cannot be reached answers 503, not 500

```
BREAKING:
Old behavior: A request that failed because the database was unreachable
  answered 500, and the body carried the failed query and its bound
  parameters.
New behavior: It answers 503 with code SERVICE_UNAVAILABLE and no query
  text.
Migration: Treat 503 as retryable and 500 as not. A load balancer that sheds
  traffic on 500 should shed it on 503 instead. Monitoring that scraped the
  query text out of /ready or /setup/diagnostics loses it — deliberately.
Reason: 500 says the server is broken; 503 says it is temporarily unable, and
  the difference decides whether a retry can ever work. The failed query was
  also a schema disclosure, on two unauthenticated endpoints, at exactly the
  moment the database was down.
```

## 3. Error bodies carry a stable code and the request id

```
BREAKING:
Old behavior: An error body carried error, and sometimes code. There was no
  requestId, so an error could not be joined to the log line that described
  it.
New behavior: Every Keystone JSON error body also carries requestId, and a
  code derived from the status when the handler did not supply one
  (VALIDATION_ERROR for a 400 with details, RATE_LIMITED for a 429, and so
  on). A code the handler set is never overwritten.
Migration: If you compare error bodies for equality, compare the error member
  rather than the whole body. Read code instead of parsing the message, and
  read requestId when you need to quote the failure to support.
Reason: A client that branches on English prose breaks when the prose is
  edited, and an error that cannot be joined to a log line is an error nobody
  can investigate.
```

Protocol bodies are unchanged: OAuth 2.0 errors keep their RFC 6749 shape,
SCIM keeps its RFC 7644 envelope, and an authorization decision
(`{ allowed, reason }`) is still a 200.

## 4. The global rate limiter is enforced

```
BREAKING:
Old behavior: The global onRequest limiter never applied. The Redis client is
  created lazily, so its status was "wait" on a fresh process, and the
  limiter's readiness check returned the local answer without ever issuing a
  command. Per-endpoint budgets were per-instance, and the global one was
  inert.
New behavior: Every request is counted against a global budget shared through
  Redis, and the per-endpoint budgets are shared too.
Migration: Handle 429 with Retry-After on every route, not only the
  authentication ones. Size your client for a shared budget: a fleet of N
  instances shares one budget rather than each having its own.
Reason: The control that was supposed to bound the whole server was not
  running, which is the worst kind of gap: it looked present in the code and
  in the documentation.
```

## 5. The anti-spraying budget is keyed on the address alone

```
BREAKING:
Old behavior: The per-address login budget was keyed on address AND the
  submitted account, so thirty different accounts from one address each got
  thirty attempts. It bounded nothing.
New behavior: It is keyed on the address alone. The same thirty attempts
  apply to every account from that address.
Migration: A NAT'd office, a CI runner or a shared egress IP that authenticates
  many accounts will now be throttled where it was not. Raise
  LOGIN_PER_ADDRESS_MAX for those, or give them a different path.
Reason: The budget exists to bound spraying, and a key that includes the
  sprayed value cannot.
```

## 6. Rate limits on previously unlimited routes

```
BREAKING:
Old behavior: Eight routes had no limit, and two more (the OAuth revocation
  endpoint and logout) were unbounded.
New behavior: All ten are limited, and answer 429 with Retry-After. The
  routes are the two federation callbacks, the enterprise SSO callback, the
  magic-link verifier, the SAML start and ACS, the two WebAuthn
  authentication endpoints, POST /oauth2/revoke and POST /auth/logout.
Migration: Handle 429 and Retry-After on those routes. A client that drives
  a SAML ACS or a WebAuthn ceremony in a tight loop will be limited.
Reason: An unbounded endpoint is an invitation, and the OAuth revocation
  endpoint is one the specification asks to be limited.
```

## 7. A replayed refresh token revokes the family, not the account

```
BREAKING:
Old behavior: A detected replay revoked every refresh token and session the
  user had. Every device was signed out, and one stolen token was a denial
  of service against the whole account.
New behavior: Only the credential family — the chain of tokens descended from
  the login that was compromised — is revoked. Other devices stay signed in.
Migration: A flow that treated a replay as "everything is logged out, send
  the user back to the login screen" will now find other sessions still
  valid. Re-authenticate the affected device, not the account.
Reason: The family is the smallest set that certainly includes the
  attacker's current token. Revoking more buys no security and hands the
  attacker a denial of service for the price of one stolen token.
```

The refresh exchange now reports *why* it failed — `rotated`, `rejected`,
`raced` or `replayed` — so a client can tell a lost race (two tabs
refreshing at once) from a breach.

## 8. A replayed token is detected on the OAuth grant path too

```
BREAKING:
Old behavior: POST /oauth2/token did no replay detection at all. A stolen
  refresh token replayed through the OAuth grant kept working.
New behavior: The decision is made where the rotation happens, so every path
  that rotates a token gets it.
Migration: A client that replays a refresh token through the OAuth grant is
  now refused. Do not retry a refresh with the same token.
Reason: The detection existed on one route and not the other, which is the
  shape of a control that an attacker simply routes around.
```

## 9. Webhook URLs are validated, and a refusal is not retried

```
BREAKING:
Old behavior: A webhook endpoint accepted any URL and the delivery was
  attempted five times.
New behavior: Private literals, credentialed URLs and file:// are refused at
  creation and update with 400. A name that resolves to a private address
  is refused at delivery time. A refusal is recorded as failed and is not
  retried.
Migration: A webhook pointed at an internal address now answers 400 when it
  is created. Set ALLOW_PRIVATE_WEBHOOK_TARGETS=true to permit it, and read
  the delivery row to see a refusal rather than waiting for a retry.
Reason: The server was making requests, with the server's own identity and
  egress, to a URL an API caller chose.
```

## 10. Webhook delivery no longer follows redirects

```
BREAKING:
Old behavior: A consumer answering 302 had that request made for it, with
  the payload and the HMAC signature attached, to the location it named.
New behavior: A 3xx is a terminal refusal. The delivery fails and is not
  retried.
Migration: A consumer that answers a redirect — a CDN, a "trailing slash"
  redirect — must serve the payload directly.
Reason: The outbound policy validated the stored URL, and the redirect
  performed the request the policy had just refused.
```

## 11. The query string is dropped from logs, audit rows and webhook events

```
BREAKING:
Old behavior: Access logs, audit rows and the rate-limit event carried the
  full request target, including the query string.
New behavior: The path is recorded and the query string is dropped — not
  redacted, dropped. This applies to the four credential-bearing routes
  (the magic-link verifier, the email-verification verifier, the federation
  callback and the enterprise SSO callback), where the query string carried
  the credential.
Migration: An audit-log or webhook consumer that parsed a token or a code out
  of the payload must read the path instead. The credential is no longer
  anywhere in the log.
Reason: A magic-link URL in a log line was enough to sign in as the user
  until the token was consumed, and a rate limiter is exactly the control
  that fires on requests to that route.
```

## 12. GET /setup/status no longer reports setupToken

```
BREAKING:
Old behavior: The unauthenticated endpoint returned needsSetup and
  setupToken: Boolean(...).
New behavior: It returns needsSetup only.
Migration: Remove the read of setupToken. The wizard only ever branched on
  needsSetup.
Reason: The endpoint is unauthenticated by necessity — the wizard calls it
  before any credential exists — so the boolean told anyone who could reach
  the port whether the port was protected.
```

## 13. POST /setup/init race losers get 409 or 403

```
BREAKING:
Old behavior: Two callers arriving together both read "no owners" and both
  wrote, so a fresh deployment answered its first simultaneous requests with
  more than one platform owner.
New behavior: The bootstrap is serialized behind a Postgres advisory lock.
  The loser receives 409 (another caller is bootstrapping) or 403 (the
  bootstrap already completed).
Migration: The setup wizard must treat 409 as "wait and retry", polling
  GET /setup/status, rather than as a failure.
Reason: A platform with two owners is not a platform with one owner; it is a
  different and worse thing, and nothing in the database prevented it.
```

## 14. Frontend authentication is cookie-only

```
BREAKING:
Old behavior: The access token was readable by the frontend as the
  keystone-access-token storage entry.
New behavior: The token is in an httpOnly cookie. The sessions endpoint
  reports the current session.
Migration: An SPA or CLI integration that read the token from storage must
  use the cookie or the sessions endpoint.
Reason: A token in storage is a token a script can take.
```

## 15. revoke-all revokes every token and session

```
BREAKING:
Old behavior: revoke-all revoked only the newest token.
New behavior: Every refresh token and session for the target user is
  invalidated.
Migration: An administrator who used revoke-all expecting a narrow effect now
  signs the user out everywhere.
Reason: A control named "revoke all" that revokes one is worse than no
  control, because it is believed.
```

## 16. The refresh-rotation metric label changed

```
BREAKING:
Old behavior: The counter reported the constant "attempted".
New behavior: It reports success, refused or error.
Migration: Dashboards and alerts selecting outcome="attempted" match nothing.
  Update them to the three values.
Reason: A constant label could not distinguish a rotation that succeeded
  from one refused because the token had already been used — the replay
  signal — from one that errored.
```

## 17. A failed PKCE proof no longer burns the authorization code

```
Old behavior: Any pre-PKCE rejection marked the code used, so a request with
  a wrong code_verifier irreversibly spent a perfectly good code.
New behavior: The endpoint peeks, verifies, and only then consumes. The
  audit outcome distinguishes pkce_verifier_missing from pkce_failed.
Migration: None required. A client that had to restart the whole
  authorization flow after a PKCE failure can now retry the same code.
Reason: The legitimate client, holding the correct verifier, found the code
  spent and received the same answer as an expired one.
```

## 18. An unknown kid is rejected before signature verification

```
BREAKING:
Old behavior: An unrecognised kid produced the same answer as a bad
  signature.
New behavior: It is rejected before any signature work, so the two produce
  different errors. A token with no kid keeps the documented legacy
  behaviour.
Migration: A client that treated "unknown key" and "bad signature" as one
  case must now distinguish them.
Reason: The two mean different things — a key this server no longer has, and
  a signature that does not verify — and a caller debugging a key rotation
  needs to be told which one it is.
```

---

# Deployment-facing changes

## 19. Minimum Node 22 → 26

```
BREAKING:
Old behavior: engines.node was ">=22" and the image was node:22-slim.
New behavior: engines.node is ">=26" and the image is node:26-slim.
Migration: Upgrade the runtime to Node 26. engine-strict is not set, so this
  is a warning at install time rather than a refusal.
Reason: The 22 base image carried CVE-2026-103111.
```

## 20. A production-like boot refuses unsafe configuration

```
BREAKING:
Old behavior: The server started with an insecure cookie, a weak TOTP key,
  an in-process queue, or the insecure-webhook escape hatch.
New behavior: In production and staging the process refuses to start and
  says which setting is at fault. KEYSTONE_ALLOW_DEV_DEFAULTS=true still
  bypasses the refusal, and now logs how many unsafe settings it bypassed.
Migration: For NODE_ENV=production or staging, set
  KEYSTONE_QUEUE_PROVIDER=bullmq, set COOKIE_SECURE=true, provide a strong
  TOTP key, and unset KEYSTONE_ALLOW_INSECURE_WEBHOOK — or deliberately set
  KEYSTONE_ALLOW_DEV_DEFAULTS=true.
Reason: A configuration check that warns is a check nobody reads, and the
  settings it covers are the ones an outage is most likely to be blamed on.
```

## 21. Startup verifies the schema and refuses to start on a failed migration

```
BREAKING:
Old behavior: A failed migration was logged and the process continued to
  listen, so a container with the wrong schema answered 500s to every
  request while telling the orchestrator it was healthy.
New behavior: The schema is verified immediately after migrating, and in
  production and staging a failed migration or a missing table refuses to
  start.
Migration: Migrations must succeed before the process serves. The new
  commands are `keystone migrate --verify`, `keystone schema:verify`, and
  `scripts/migrate.sh up --verify`.
Reason: A half-applied migration is a process that is healthy and useless.
```

## 22. SIGTERM and SIGINT trigger an ordered, bounded shutdown

```
BREAKING:
Old behavior: There was no SIGTERM handler anywhere, so Node's default
  disposition terminated the process at once and every in-flight request and
  every running job was severed.
New behavior: The shutdown is ordered and bounded:
  stop accepting requests → finish active requests → stop workers → finish
  safe jobs → release locks → close PostgreSQL → close Redis → exit 0.
  KEYSTONE_SHUTDOWN_TIMEOUT_MS (default 10000) bounds it; on expiry the
  process exits 1 and names the step that was still open. A second signal
  exits immediately. The image declares STOPSIGNAL SIGTERM.
Migration: Give the orchestrator a grace period of at least ten seconds.
  Monitoring that alerts on a non-zero exit must account for the process
  now exiting 1 on a shutdown timeout, where it previously exited 0 by
  being killed.
Reason: A deploy that severs in-flight requests loses work, and a
  termination that ignores the shutdown path never gets to release its locks.
```

## 23. The image runs non-root

```
BREAKING:
Old behavior: The image ran as root.
New behavior: It runs as the node user (uid 1000), and placeholder secrets
  are refused at startup in production.
Migration: Volume mounts, file permissions and any host-path writes for the
  setup wizard must be writable by that user.
Reason: A container that runs as root turns a container escape into a host
  compromise.
```

## 24. KEYSTONE_ENCRYPTION_KEY wraps the signing keypair at rest

```
BREAKING:
Old behavior: The JWT signing keypair was stored in plaintext.
New behavior: It is wrapped with KEYSTONE_ENCRYPTION_KEY. Production boot
  warns without an encryption key and fatal-exits when COOKIE_SECURE=false
  without ALLOW_DEV_DEFAULTS.
Migration: Set KEYSTONE_ENCRYPTION_KEY (32 hex characters or 32 bytes) on
  every instance. Existing plaintext rows are re-wrapped in place on first
  read, so an existing deployment upgrades without a manual step.
Reason: A database dump was a signing key.
```

## 25. Plain-HTTP webhooks are restricted to loopback, with an opt-in

```
BREAKING:
Old behavior: The rule was "HTTPS in production, anything anywhere else",
  which made a shared staging deployment a way to send signed payloads in
  the clear.
New behavior: Plain HTTP requires KEYSTONE_ALLOW_INSECURE_WEBHOOK=localhost
  exactly, is never permitted in production, and is restricted to a loopback
  host.
Migration: A staging webhook over plain HTTP to a non-loopback host is now
  refused. Use HTTPS, or set the opt-in for the loopback case.
Reason: The staging rule was a hole in the production rule.
```

## 26. AUDIT_WEBHOOK_URL goes through the outbound URL policy

```
BREAKING:
Old behavior: The audit export was fetched with a bare fetch() and no
  outbound policy, so it could reach a private address.
New behavior: It goes through the same assertSafeWebhookUrl as every other
  outbound request.
Migration: A private or loopback AUDIT_WEBHOOK_URL is now refused. Set
  ALLOW_PRIVATE_WEBHOOK_TARGETS=true to permit it.
Reason: The audit export was the one outbound request with no policy on it.
```

## 27. The k8s Ingress moved to a new overlay

```
BREAKING:
Old behavior: The Ingress was in the base and in overlays/production.
New behavior: The base is ClusterIP-only, and the Ingress is
  k8s/overlays/ingress, which builds on overlays/production.
Migration: Operators who applied overlays/production to get an Ingress must
  now apply overlays/ingress. The base no longer contains an Ingress, so
  /metrics is not published by the default overlays.
Reason: The base being ClusterIP-only is what makes the safety claim true
  rather than merely stated.
```

---

# Security-driven behaviour changes

These were made for security reasons and a client can observe them. They are
listed separately because "this broke" is the wrong reaction to them: the old
behaviour was the defect.

- **The query string is dropped** rather than masked, in the access log, the
  request logger, the machine-principal log and the rate-limit event.
- **The database parameter values no longer reach the logs or the responses**,
  and the driver's parameter list is stripped at the logger boundary.
- **IP allow/block is enforced before the password check**, so a login from a
  blocked address is refused earlier than a wrong password would be.
- **Login no longer short-circuits on an unknown user.** An identical dummy
  argon2 hash removes the timing oracle between an existing and a missing
  account. **A login is now roughly two seconds of argon2id by design**, and a
  timeout shorter than that will fail logins.
- **Plain-HTTP webhooks and the audit export** are refused rather than
  downgraded.
- **A replayed refresh token** revokes the family rather than the account, and
  is detected on the OAuth grant path.

---

# What is frozen from 4.0.0

Seven contracts are snapshotted in `docs/contract-freeze.json` and gated by
`npm run verify:contract`. A change to any of them fails the gate with the
exact difference, and the only way past it is to update the snapshot on
purpose, in the same commit.

| Contract | What is frozen |
| --- | --- |
| REST API | Every path, method and tag |
| OAuth behaviour | The discovery metadata and the error codes |
| Token format | The claims, the algorithm, the audience, the issuer |
| Database contracts | The tables, their columns, their nullability and defaults, the migration set |
| Webhook format | The headers a delivery carries, the shape of its body |
| SDK interfaces | What each published package exports, and where it points |
| Configuration | The environment variables the server reads |

See [The frozen contracts](CONTRACTS.md) for how the snapshot is read and how
a change to one is made visible.

---

# Migration steps

1. Read the summaries above and find the changes you actually depend on. Most
   consumers of 3.14.0 depend on none of them.
2. Upgrade the runtime to Node 26.
3. For `NODE_ENV=production` or `staging`: set `KEYSTONE_QUEUE_PROVIDER=bullmq`,
   `COOKIE_SECURE=true`, and a strong TOTP key, and set
   `KEYSTONE_ENCRYPTION_KEY`.
4. Run `scripts/migrate.sh up --verify` (or `keystone migrate --verify`) as part
   of the deploy, before the new instances take traffic. The migration is
   additive and can be run ahead of the rollout.
5. Give the orchestrator a termination grace period of at least ten seconds.
6. Make sure the client handles `429` with `Retry-After` on every route, and
   distinguishes `400` from `5xx`.
7. If you read the access token from browser storage, move to the cookie or
   the sessions endpoint.
8. If you parse the query string out of an audit row or a webhook payload,
   stop — it is not there any more, and the credential it carried is not in
   the log either.
