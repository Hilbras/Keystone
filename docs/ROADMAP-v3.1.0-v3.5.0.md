# Keystone improvement plan — v3.0.1 → v3.5.0

**Baseline:** `v3.0.1` · **Target:** `v3.5.0` · **Date:** 2026-09-27

Derived from [`docs/ANALYSIS-v3.0.1.md`](ANALYSIS-v3.0.1.md). Five minor
releases, each independently shippable, each gated on a measurement rather than an
intention.

---

## The shape of this plan

The security programme is finished: 44 findings, every one with a regression
test, zero unresolved Critical. The next five versions are a different kind of
work, and saying so plainly is the point of this document.

Three of the highest-severity items in the analysis are **not** security findings.
They are things that were never measured:

- two tables on the hottest read path have no index
- OpenTelemetry is a dependency that instruments nothing
- the build has no `.dockerignore`, so a local `.env` can reach a build layer

All three were invisible because nobody looked. So the first release is about
looking, and every release after it is gated on a number that did not exist when
the work started.

**Two rules for everything below:**

1. **Measure before fixing.** Each release starts by producing the number it
   intends to change. A fix for an unmeasured problem is a guess.
2. **A gate that cannot fail is not a gate.** Every new check is verified by
   breaking it, as every check in the security programme was.

### Version summary

| Version | Theme | Risk |
| --- | --- | --- |
| **3.1.0** | Measure: query plans, spans, build hygiene | Low — no behaviour change |
| **3.2.0** | The database layer: indexes, N+1, caching | Medium — schema migration |
| **3.3.0** | The shape of the codebase: layering, errors, observability | Medium — refactor |
| **3.4.0** | Behaviour, not just security: the untested paths | Low |
| **3.5.0** | Operability and the SDK surface | Medium |

---

# v3.1.0 — Measure

*No behaviour changes. Everything here either observes or prevents a build from
carrying something it should not.*

## 1.1 `.dockerignore`, and an assertion that the image is clean

**Finding:** §2.1. `COPY . .` with no `.dockerignore` means a developer's local
`.env` reaches the builder stage, and 255 MB of context is sent for nothing.

**Do:**
- add `.dockerignore` (`node_modules`, `.git`, `.env*`, `dist`, `coverage`,
  `*.log`, `plan.md`, `tasks/`)
- extend `verify-release-metadata.mjs` with an image check: build the image, then
  assert it contains no `.env`, no `*.pem`/`*.key`, and no `.git`. The npm path
  already does this for the tarball; the container path does not, and that
  asymmetry is the finding.
- record the build-context size before and after, so the improvement is a number

**Gate:** `docker build` produces an image; the check enumerates its layers and
fails on credential material. Verified by planting a `.env` in the tree and
confirming the gate fails.

**Done when:** context size is reported in the build log and a planted `.env`
does not reach the builder layer.

## 1.2 Query plans for every table the analysis claimed was at risk

**Finding:** §2.3 claimed `permissions` and `role_permissions` were a **High**
risk because they have no index, and `requirePermission` reads them on every
organization-scoped request.

**Measured — and the finding was wrong.** At 145 and 292 rows a sequential scan
is the correct plan, at 0.13 ms and 0.32 ms. The catalogue is bounded by the
resource:action surface, not by user count. Two of the three high-severity
suspicions in the analysis survived contact with a measurement; this one did not,
and adding the indexes would have cost write throughput for nothing.

**Done:**
- `EXPLAIN (ANALYZE, BUFFERS)` for every repository query, at this repository's
  real row counts (33k users, 15k orgs, 50k audit rows) rather than a guess
- record the plans in `docs/performance/query-plans.md`
- carry the two unindexed tables into 3.2.0 as *insurance*, not as a fix, with the
  condition that triggers it written down: if the permission catalogue is ever
  allowed to grow unbounded, revisit

**Gate:** assert plan **shape**, not timing — no repository query sequential-scans
a table above 1,000 rows. Timing assertions in CI are flaky, and a flaky gate gets
disabled. Note this gate must encode the exception, or it fails on the two tables
that are *correctly* sequential.

**Done when:** every repository plan is recorded, and the two unindexed tables
have a written trigger for revisiting.

## 1.3 Four spans on the paths that matter

**Finding:** §2.2. OpenTelemetry is a dependency, `startTracing` is wired, and
there are **zero** custom spans. Every trace is HTTP-and-database auto-tracing,
which cannot distinguish a correct argon2id cost from a query in a loop.

**Do:** instrument the four chokepoints, and only these four:
- the token-issuance chokepoint (attributes: flow, `requires_mfa`, factor)
- refresh rotation (attributes: rotated, replay-detected)
- the SCIM group reconcile (§1.4 will make it one query; the span proves it)
- webhook signing and delivery (attributes: endpoint id, attempt, status)

**Gate:** a test that asserts each named span is created. Four assertions, cheap
to run, and it stops the spans being deleted by someone tidying.

**Done when:** a slow login in a trace shows the chokepoint, and the four spans
exist in a test.

## 1.4 Baseline the four known hot paths

**Finding:** §2.4. SCIM groups is N+1 on read and quadratic on member write.
Nothing has measured it, so "slow" is currently an opinion.

**Do:** a repeatable benchmark against the existing `docs/PERFORMANCE.md`
harness — SCIM group list at 50/200/1000 groups, group member reconcile at
10/100/1000 members, login, refresh, `/v1/authz/check`. Record the numbers as the
baseline the next release is measured against.

**Gate:** the benchmark runs in CI on a schedule and fails on a **regression
against the recorded baseline**, not an absolute threshold. A gate that fails on a
noisy machine is a gate that gets switched off.

**Done when:** `docs/PERFORMANCE.md` carries the baseline and a regression fails
the build.

---

# v3.1.0 — status

Both items in this release are done, and both shipped with the correction that
measurement forced.

**§1.3** — the four spans exist, in `src/services/spans.ts`, with the names as
exported constants. The gate is `src/tests/observability/chokepoints.test.ts`, and
it is verified by breaking: removing the span from the SCIM route fails exactly
one test, and reverting the span layer fails all four. A test that asserts the
source contains `startSpan` would have passed on the pre-3.1.0 codebase, which is
the whole reason the gate drives the real routes instead.

Two attributes were changed after writing them. `requires_mfa` became two
attributes, `mfa_enabled` and `mfa_satisfied`, because one flag cannot say both
whether an account has a second factor and whether this login presented one — and
a flag that is true for everyone with TOTP reports nothing. And `flow` is a
TypeScript union rather than a string, threaded through all eleven internal call
sites, so a misspelling is a compile error instead of a span attribute that says
`"unknown"` forever.

**§1.4** — the benchmark, the baseline, and a nightly gate. It is
`src/bench/hotPaths.ts`; the reasoning is in `docs/performance/README.md` and the
numbers are in `docs/PERFORMANCE.md`.

The plan assumed a harness already existed in `docs/PERFORMANCE.md`. It did not —
that file is about memory on a developer laptop — so §1.4 built the harness as
well as running it. The measurement then corrected three things written here in
advance: the group-list target of "2 queries" (§2.1, above), the description of
the reconcile as quadratic, and the assumption that an absolute millisecond
baseline would be a usable gate. It also found that the benchmark was measuring
the login rate limiter rather than the login, which is written up at the end of
`docs/performance/README.md` because it is the kind of mistake a gate inherits
quietly.

---

# v3.2.0 — The database layer

*The three findings from the analysis, measured in 3.1.0.*

## 2.1 Fix the N+1 and the quadratic reconcile

**Finding:** §2.4. `scim.ts:729` issues one member query per group per page.
`scim.ts:809-817` re-reads the full member list inside a loop over the submitted
members — quadratic, with a full read per iteration.

### Measured in 3.1.0, and the original diagnosis was half right

§1.4's benchmark instrumented the SQL and the statements came back:

| | §1.2 before | §1.4 measured | original plan's target |
|---|---|---|---|
| group list, 50 / 200 groups | 51 / 201 statements | **5 / 5** | 2 |
| group list, 1000 groups (2 pages) | 1002 | **10** | — |
| reconcile, 10 / 100 / 1000 members | — | **70 / 610 / ~6000** | 3 |

Two corrections, both of which matter:

- **The read is already fixed, and the target was wrong.** 5 statements per page
  is constant regardless of page size, which is the property that matters. The
  plan's "2 queries" was a guess written before anything was measured. The
  extra statements are SCIM credential resolution, not the member fetch.
- **The write is not quadratic — it is linear with a 6× constant, and that is
  worse than it sounds.** `addMember` opens a `db.transaction` per member, and
  each transaction is `BEGIN`, a group lookup, a membership lookup, an insert,
  `COMMIT`. Six statements and a commit per member. A 1000-member group push
  takes **about 65 seconds**. No single query is slow; there are six thousand of
  them.

**Do:**
- read: already done in §1.2. Leave it, and keep the benchmark as the thing that
  notices if it comes back.
- write: resolve the group and the membership set **once**, outside the loop, then
  apply the whole set-difference in a single statement
  (`INSERT ... SELECT ... ON CONFLICT DO NOTHING` for the additions, one `DELETE
  ... WHERE user_id = ANY($1)` for the removals), in **one** transaction
- keep the audit trail per changed membership; the count of audit rows should be
  proportional to the change, not to the group size

**Gate:** the §1.4 benchmark shows a **constant** query count for group list
regardless of page size, asserted directly in a test (not inferred from timing).
Plus the existing 55 SCIM isolation tests unchanged — this is a performance
change, not a behaviour change.

**Done when:** group list is constant at any page size (it is, at 5), and
reconcile is under 10 statements at **any** member count — not 3, which the
measurement shows was never achievable with a per-member audit write.

---

# v3.2.0 — status

All four items are done, and the release was supposed to be a schema migration.
It did not contain one, because the migration was a pessimization (§2.2), and it
produced two security findings that have nothing to do with databases (§2.3's
cache work uncovered both).

**§2.1 — done, and the diagnosis improved.** `reconcileMembers` resolves the
group, the current members and the organization memberships once, then applies the
set-difference in two statements inside one transaction. **15 statements at 10
members, at 100, and at 1,000** — the count no longer depends on group size, which
is the property that matters. The 1,000-member push went from 48,976ms to 317ms.

The target above ("under 10 statements") was written before the work and is not
met — 15, not 3 and not 10 — because the 5 statements are the route's own
credential resolution, group load, update and audit, none of which is the
reconcile. The gate is the constant, and the constant is what shipped. A rejected
reconcile now applies nothing at all, which the per-member loop did not do.

**§2.2 — the migration was not written, deliberately.** Both tables already carry
composite unique indexes on exactly the columns the query uses. At the catalogue's
real size (150 and 302 rows) the planner picks a sequential scan at 0.291ms and 5
buffers, and forcing the indexes costs 0.415ms — the index would have been 40%
slower for the same answer, plus a write on every permission seed. The deliverable
is a gate instead: it asserts the indexes exist, asserts the catalogue is under the
size at which the scan was last measured, and names exactly what to re-measure when
it is not. Verified by dropping the constraint and by inserting 5,200 probe rows.

**§2.3 — done, and it found two live security defects.** The cache is
Redis-only with no in-process fallback, invalidated on every write, and never caches
an empty set. Eight tests, each confirmed to fail against a version with the
corresponding property removed.

Adding it meant issuing a command on the shared Redis client — and that connected
it, which switched the rate limiter from per-instance to shared and immediately
exposed that **the distributed rate limiter had never been running** (SEC-047:
`checkLimit` guarded on client readiness, and a `lazyConnect` client is not "ready"
until something issues a command, so the guard returned the local budget without
ever trying Redis). Three controls were inert, including a pre-authentication
budget on `/scim/v2/*` that failed open on every request. Fixing that exposed
**SEC-048**: `rateLimit()` appended the submitted address to every limiter's key,
so `login-per-address` — the budget that exists to stop spraying — was keyed on
address *and* account and bounded nothing. Both are fixed and both have regression
tests, including one that sprays 31 accounts from one address rather than
inspecting the key format.

The measured effect of §2.3 on its own: `/v1/authz/check` went from 7 statements
to 6, since the two permission queries are now one cache read.

**§2.4 — done.** `workflows.ts` no longer imports `db` or `drizzle-orm`, its five
hand-written membership checks are one `preHandler`, and the data access is behind
`src/repositories/workflow.ts`. Behaviour is unchanged: the same 403s, the same audit
events, a missing `orgId` on the collection is still a 400, and a delete that
matched nothing is still a 404.

Also removed: `src/services/permissions.ts`, which nothing imported. It was a
second copy of the permission catalogue, able to drift from the copy that actually
authorizes.

---

# v3.3.0 — The shape of the codebase

*Turn the two documented conventions into enforced ones.*

## 3.1 Enforce the layering rule

**Finding:** §2.5. `AGENTS.md` says routes must not import the database.
`setup.ts` and `workflows.ts` do, and issue raw SQL; `admin/platform.ts`
imports drizzle for query builders without importing `db` directly, which is a
lighter version of the same violation. The rule is correct and
unenforced.

**Do:**
- two Semgrep rules in the existing `.semgrep.yml` (which already carries
  project-specific rules for exactly this): no `db/index.js` import from
  `src/routes/`, no `drizzle-orm` import from `src/routes/`
- move the two violating files behind repository interfaces
- the rules fail the build, so a third violation cannot land

**Gate:** the Semgrep rules, verified by introducing a violating import and
confirming CI fails. This is the discipline applied to every check in the
security programme.

**Done when:** the rules are in `.semgrep.yml` and `rg -l 'db/index' src/routes/`
returns nothing.

## 3.2 One error-handling convention

**Finding:** §2.6. 70 `Result<T>` returns against 105 `throw new` in services.
A `throw` in a `Result`-returning method bypasses `sendResultError` and produces
a 500 where a 403 was intended.

**Do:**
- choose `Result<T>` for anything a caller can act on; reserve `throw` for
  genuinely unrecoverable states
- a lint rule: no `throw` in `src/services/domain/`, where every outcome is
  expressible as a `Result`
- route `console.*` through the injected logger, so errors carry request
  context — 76 call sites currently bypass it
- the 10 raw `status(500)` routes reviewed individually; several are probably
  correct, and the ones that are not become visible

**Gate:** the lint rule passes on the tree and fails on a planted `throw`.
Reviewed: every remaining `throw` in `src/services/` has a comment saying why it
cannot be a `Result`.

**Done when:** `rg -c 'throw new' src/services/domain/` is zero, and a denied
operation can no longer surface as a 500.

## 3.2 status — done

**The lint rule was already satisfied.** `rg -c 'throw new' src/services/domain/`
is **zero**, and has been. The rule is a tripwire rather than a fix, which is the
right shape for a rule about a convention: it costs nothing now and fails the build
the first time somebody reaches for `throw` here out of habit. Verified by
planting a throw.

**`console.*` in server code: 101 call sites → 12.** The remaining twelve are the
code where stdout *is* the output rather than a diagnostic — the `console` email
and SMS providers, the audit console export, and the setup token an operator has
to read. They are listed by name in the rule's exclusion list rather than allowed
by pattern, so a fifth such file has to be added on purpose.

Route call sites now use the injected logger, and where a route helper has no
request in scope — `detectImpossibleTravel` in `auth.ts` — the logger is **passed
in** rather than reached for, so the line still carries the request id that
identifies the login that triggered it. Services, queue workers and event
subscribers get `serviceLogger("<component>")` from a new `src/lib/logger.ts`,
which reads the same `KEYSTONE_LOG_LEVEL` as Fastify's. That last part is the
point: `console` ignores the level, which is how the 3.1.0 benchmark ended up
measuring its own logging.

**The 10 raw `status(500)` sites were reviewed and none changed.** Each is a
genuine server-side failure, and six of them additionally log their cause. Two of
them — `config.ts:43` and `config.ts:48` — echo the underlying error message to
the client, which is normally a leak and here is not: all three `/config` routes
are `requirePlatformRole("owner")`, and the operator who is about to restart the
server needs to know whether the write failed on permissions or on a syntax
error. Removing it would take away a diagnostic from the one principal who can
act on it, for no security gain. Recorded here because "reviewed and left alone"
is a decision, and a decision nobody wrote down is indistinguishable from an
oversight.

## 3.3 Move the two misplaced test suites

**Finding:** §2.9. `audit-export.test.ts` and `registry.test.ts` sit at the root
of `security/` while 14 of 16 suites are in a domain directory.

**Do:** `audit-export` → `configuration/`, and give the registry check a home
under a `process/` or top-level domain.

**Gate:** the registry validator still accounts for all 18 suites — it is
path-based, so this is a real check that the move did not orphan a file.

**Done when:** 16/16 suites are in a named domain directory.

## 3.4 Make `review:api` a gate

**Finding:** §2.2 of the API review. `review:api` reports 42 routes with an open
question and is not in the release gate. It was wrong four times before it was
right, which is exactly why it should be gated — a report nobody reads protects
nothing.

**Do:** promote the parts that are mechanically decidable to assertions:
- no route without an authentication guard, unless listed with a reason
- every route guard resolvable to a name in the allowlist, so a typo in a guard
  name cannot silently disable it
- the public-by-design list must carry a non-empty reason for every entry

**Gate:** `review:api --strict` in the release gate, with the triaged exceptions
recorded in `docs/API-REVIEW.md` so each one is a written decision.

**Done when:** a route added without a guard fails the release.

## 3.4 status — done, and narrower than planned

`review:api --strict` is in the release gate. It fails on three things, and all
three are mechanically decidable from the source:

1. **A route with no authentication guard and no entry in `PUBLIC_BY_DESIGN`.**
   The count is **zero** today, so this is a tripwire rather than a fix.
2. **An entry in `PUBLIC_BY_DESIGN` with an empty reason.** An entry without a
   reason is indistinguishable from a route nobody looked at.
3. **A guard name that resolves to nothing.** This is the one that matters, and
   the one nothing else could catch. A misspelled guard is not a load-time error:
   Fastify evaluates `preHandler: [app.authentcate]` to `undefined` and skips it,
   so the route ships unauthenticated and every test that does not happen to call
   it still passes. Verified by misspelling `app.authenticate` on
   `POST /auth/api-keys`, which produces both the lost-guard finding and the
   unresolvable-name finding.

**The other two reported categories are deliberately not gated.** "Authenticated,
no authorization guard" is 27 routes and "state-changing, no rate limit" is 30,
and neither is decidable by reading the source — whether a route should require an
authorization guard, or what it is worth attacking, is a product judgement. The
roadmap said the triaged exceptions belong in `docs/API-REVIEW.md` as written
decisions. Writing 57 decisions nobody has made would have produced a document
that reads as review and is not, and a gate encoding the same guesses would be
worse than no gate. They stay in the report, which prints them every run, and this
paragraph is the record of why they are not in the gate.

Building the check took three attempts, and the two failures are the interesting
part — both produced a *plausible* number rather than an obvious error:

- Scanning the raw `preHandler` text found `api_keys` inside
  `app.requireScopes("api_keys:read")` and reported **901** problems, none real.
- Stripping string literals first, then splitting on commas, found
  `config.LOGIN_MAX_ATTEMPTS` inside an options object and reported **40**.
- Splitting at the top level only, but matching against the raw block, found the
  word "so" — from a `//` comment inside a preHandler list, which also truncated
  the match and swallowed the real guards after it — and reported **14**.

The final version strips comments from the file, splits the array depth-aware, and
accepts a guard that is declared in the same file. A gate that cries wolf gets
switched off, and the cost of a wrong gate here is higher than the cost of no
gate: it would have been red on day one, and the response to that is deletion.

It also did not set an exit code. The finding was printed and the build went
green, which is the exact failure §3.4 set out to end.

---

# v3.4.0 — Behaviour, not just security

*The gap the analysis found: 402 security tests, and the ordinary paths are thin.*

## 4.1 Email verification, end to end

**Finding:** §2.8. No test invokes either email-verification endpoint. The
module is named once, in a list of limiter prefixes. It is a credential-bearing
flow with a token, a TTL and a consumed marker, and nothing exercises it.

**Do:** the full lifecycle — request, token issued, verify, replay refused,
expired token refused, already-verified user not re-mailed, and the response
shape stays uniform so it does not enumerate accounts. Reuse the
`singleUse.ts` primitive from the security programme so the race is covered by the
same atomic claim the magic link uses.

**Gate:** the suite passes, and reverting the single-use claim fails it.

## 4.1 status — done, and it found a live defect

Twelve cases: the lifecycle, sequential replay, expiry, a deleted user, the
uniform response shape across unknown / unverified / verified addresses, no
re-mail to a verified account, the authenticated re-send, and that only a digest
is stored.

**SEC-049, medium. The email-verification token was not single-use under
concurrency.** `consumeVerificationToken` read the row with `usedAt IS NULL` and
then updated it — a read that hopes, not a claim. Two requests arriving together
both pass the read before either writes, both update, and both are told the token
was valid. `src/services/singleUse.ts` existed for exactly this and already served
magic links, password resets and SMS OTP codes atomically; email verification was
the fourth token type and the only one not routed through it.

Measured against the old implementation: **2 of 8** simultaneous requests through
`GET /auth/email-verification/verify` were each told the token was valid. Not 8 of
8 — the connection pool serialises some of them, which is exactly what makes a
race look intermittent and therefore unlikely.

Two things are worth recording about how it survived:

- The flow had no test at all. `emailVerification.ts` appeared once in the suite,
  in a list of rate-limit prefixes.
- **The obvious test would have passed anyway.** A sequential replay test — use
  the token, assert the second use is refused — passes against the broken
  implementation, because the second request arrives after the first has written.
  Only the concurrent case catches it. That is why the concurrency test is in the
  suite and not left to the reader's judgement.

The severity is medium rather than high, and deliberately: verifying an address is
idempotent, so a replay grants nothing new. It is a finding because the stated
property of the flow was **false**, and because this shape is the one people copy.
Full write-up in [`docs/security/tokens.md`](security/tokens.md).

## 4.2 WebAuthn, end to end

**Finding:** §2.8. One test file references it. Passkey registration and
authentication are the strongest factor Keystone offers and the least exercised.

**Do:** registration options → verify → authenticate options → verify, plus
replay of a challenge, a challenge from another session, and a signature from a
different credential.

**Gate:** the suite passes, and each rejection case fails when the check is
removed.

## 4.2 status — done, and WebAuthn did not work at all

Seventeen cases against a **software authenticator** written for the suite
(`src/tests/helpers/softwareAuthenticator.ts`): real CBOR, a real COSE ES256 key,
a real ECDSA signature over `authData + sha256(clientDataJSON)`, checked by
`@simplewebauthn/server` against the real stored public key. Nothing mocks the
verifier — "the route calls the service" is not the claim worth making about a
second factor.

**SEC-050, high. Every passkey registration and every passkey sign-in returned
400 `Invalid challenge`. The second factor could not be used at all.**

Keystone generated a challenge, stored it, and passed it to
`generateRegistrationOptions`. `@simplewebauthn/server` re-encodes a *string*
challenge — `isoBase64URL.fromBuffer(isoUint8Array.fromUTF8String(c))` — so what it
returns is the base64url encoding of the **ASCII bytes** of the string that went
in. A different string, not a different encoding of the same bytes. The cookie
carried one value and the store was keyed by the other, so the lookup missed every
time.

```
createChallenge() returns  ekxKcGV5ZG9Eabcdefghijklmnop
options.challenge is       ZWt4S2NHVjVaRzlFYWJjZGVmZ2hpamtsbW5vcA
equal?                     false
```

The fix is not "encode it back" — it is to stop keeping two values. SimpleWebAuthn
generates the challenge; `storeChallenge` is keyed on `options.challenge` verbatim.
There is no second copy left to drift.

**It survived because the only WebAuthn test asserted a refusal.**
`mfa.test.ts` has `POST /register/verify` on a TOTP account with no password, and
that refusal happens in `requireStepUp` — before the challenge is read. A test that
only checks the *rejection* of a feature never establishes that the feature works.
Same shape as SEC-049's sequential-replay test passing against a racy
implementation: the test looked reasonable and asserted the wrong thing.

**SEC-051, high. The challenge store was per-process.** A module-level `Map`, while
`docs/DEPLOYMENT.md` recommends "multiple Keystone containers behind a load
balancer" and `docs/ARCHITECTURE.md` lists "support horizontal scaling through
Redis-backed state" as a principle. A challenge minted on one container cannot be
redeemed on another, so with two containers roughly half of all ceremonies fail —
intermittently, and only in a multi-instance deployment. Development is a single
process and always agrees with itself, so this cannot be reproduced locally by any
amount of trying.

Now Redis, five-minute TTL, and `GETDEL` for redemption: one command, so two
simultaneous ceremonies cannot both win, and the answer is the same on every
container. A failed write **propagates** — handing out a challenge that provably
cannot be redeemed is worse than refusing to start the ceremony.

**Verified separately, because otherwise they look like one finding:**

| restored behaviour | result |
|---|---|
| challenge stored under the pre-transform value (SEC-050) | **12 of 17 fail**, every ceremony `Invalid challenge` |
| store moved back to a `Map`, challenge still correct (SEC-051) | **2 of 17 fail** — cross-instance and TTL; the ceremony itself works |
| as shipped | 17 pass |

The second row is what shows SEC-051 is a separate defect and not the same
symptom seen twice: a *correct* challenge store in the *wrong place* breaks only
multi-instance deployments.

### A regression I introduced in 3.3.0, and the gate that let it through

Chasing the two unused variables this suite's setup created surfaced a
**real regression already merged into `main`**. The §3.2 `console.*` migration
replaced a multi-line call in `src/services/secrets/environment.ts` line by line,
and produced three bare `moduleLog.warn("secrets");` statements that discarded
their messages — including the two that printed the generated JWT private and
public PEMs. A developer running locally with no keys configured could no longer
obtain them. `privatePem` and `publicPem` became unused; `npm run lint` reported
6 warnings; and I read `tail -1` of the lint output, which is the *timing* line,
not the verdict.

`npm run lint` runs in **`.github/workflows/release.yml` only, which is triggered
only on a `v*` tag push.** So it could not have stopped the merge, and would first
have run after the tag existed. Five gates were in that position:

```
npm run lint            release.yml=1  ci.yml=0
registry:check          release.yml=1  ci.yml=0
check:docs              release.yml=1  ci.yml=0
reaudit:check           release.yml=1  ci.yml=0
review-api-surface      release.yml=2  ci.yml=0
```

They now run in a new `gates` job in `ci.yml`, and `gates` is a **required status
check on `main`**. None of them need PostgreSQL or Redis, so the job has no
services. A gate's value is in what it stops; a gate that runs after the merge
annotates.

This also qualifies §3.4. `review:api --strict` was described there as "a release
gate", which is true and was misleading: in `release.yml` alone it could not
prevent a merge.

## 4.3 Federation

**Finding:** §2.8. Three test files reference it, against six connectors.

**Do:** per-connector tests for the exchange path — nonce forwarded, ID token
verified with the configured algorithm, `email_verified` respected, a connector
returning no email rejected, and account linking that will not attach a federated
identity to an existing local account without proof.

**Gate:** the suite passes. The Google nonce regression (SEC-020) is one of these
and must stay.

## 4.3 status — done, and one provider had never been fixed

Seventy cases: **all six providers**, against a real OIDC provider
(`tests/helpers/fakeOidcProvider.ts`) serving a real discovery document, a real
JWKS, and ID tokens signed with a real RSA key. `ALLOW_PRIVATE_SSO_ENDPOINTS` is
what makes it reachable — the SSO endpoint policy refuses loopback as an SSRF
control, which is the correct default and the reason the switch exists.

The provider list is itself asserted, because a per-connector suite that silently
stops covering a newly added provider is worse than none: it still reports green.

**SEC-052, high. The Zitadel connector never bound the ID token to the request,
and pinned no algorithm.** `getAuthorizeUrl` set no `nonce`, `exchangeCode`
accepted no options, `verifyToken` took one argument. An ID token minted for a
*different* Zitadel login verified correctly — issuer, audience and signature are
all still valid, and only the nonce proves the token belongs to the request that
started. `jwtVerify` was also called with no `algorithms` pin (so `alg` was
whatever the published JWKS allowed, `none` included) and no `requiredClaims` (so
a token with no `exp` was accepted forever — not hypothetical for an enterprise
IdP whose tokens are long-lived by design).

**The Google fix did not propagate to the connector next to it.** SEC-020 was the
Google connector discarding the nonce; 2.4.0 fixed `OidcConnector` and
`GoogleConnector`. Zitadel never had it, and because no test drove a Zitadel
exchange, nothing said so. That is the failure mode of fixing an *instance*
rather than a *rule*.

The rule is now in the interface, which is the part that stops it recurring:

```ts
verifyToken?(token: string, expectedNonce?: string): Promise<ExternalIdentity>;
```

It declared one argument, so a connector written from it had **no way** to accept
a nonce. The parameter's absence from the type is why this one shipped without it.

Verified by breaking it:

| | result |
|---|---|
| as shipped | 70 pass |
| Zitadel restored to its original behaviour | **59 pass, 11 fail** — all 11 Zitadel |

The other five are untouched by the break, which is what shows the eleven are
Zitadel's and not the suite's.

Also fixed while here: `attributeMapping` is keyed by internal claim names, so a
mapping of `{ username: "login" }` — the field name in `ExternalIdentity`, in every
provider's config screen, in the type itself — was **silently ignored** and the
default returned. No security impact, so it is not in the registry; it is in
[`docs/security/federation.md`](security/federation.md) because the failure mode
is a configuration that looks applied and is not.

Each rejection is matched against the claim `jose` actually names (`"aud"`,
`"iss"`, `"exp"`), not a concept word — `/audience/i` would have passed on an
unrelated failure and proved nothing.

## 4.4 The queue and metrics

**Finding:** §2.8. One test file references the queue; none references metrics.

**Do:** job enqueue → execute → retry → dead-letter, and for metrics: every
registered series increments on a real request, so a renamed label is caught
rather than silently changing a dashboard.

**Gate:** both pass; the metrics test asserts the series *exist*, which is the
part that rots.

## 4.4 status — done, and two things that counted wrong

**A counter that never moved.** `keystone_failed_logins_total` was registered in
`plugins/metrics.ts` and incremented from nowhere. It exported as a series with
value 0, forever — which on a dashboard is indistinguishable from "nobody has
failed to log in", the one reading a failed-login alert must never be able to take.

It is fed by a new `events/subscribers/metrics.ts` rather than by a call in the
route, because the event is emitted from six places and the route is one of them.
`reason` is the label rather than a constant, so a new failure mode shows up as a
new series value instead of being folded into "failed".

**The gate for the next one is static, and deliberately so.** A behavioural check
("every series moved after this traffic") is the wrong shape:
`keystone_cache_hits_total` is perfectly alive and no amount of logging in and out
of the server touches it, so the assertion would be about which subsystems a test
happens to exercise. What rots is the *pairing* between a registered name and the
code that writes to it, and that is a property of the source. So every registered
series must appear as an increment target somewhere in `src/` — rename the series
and it stops matching, delete the call site and it stops matching, and both fail.

**SEC-054, medium. Every unmatched URL was its own time series.** The `onResponse`
hook labelled requests with `request.routeOptions?.url || request.url`. For a
request that matched no route there is no template, so the fallback was the
concrete URL:

```
keystone_http_requests_total{...,route="/nope/aaaaaaaa-1111",status_code="404"} 1
keystone_http_requests_total{...,route="/nope/bbbbbbbb-2222",status_code="404"} 1
```

Two requests, two series, no upper bound on how many follow. A scanner, a crawler
or a client with a URL bug grows the count without limit, and unbounded label
cardinality is the standard way a metrics endpoint takes Prometheus down. The
failure is silent: the endpoint keeps answering and the only symptom is a
Prometheus out of memory hours later. Unmatched requests are labelled `unmatched`
now, so the series count is bounded by the number of routes.

**SEC-053, high. Three counts, all wrong.**

1. **`isFailedLoginAnomaly` was a predicate that mutated what it measured** — it
   called `recordFailedLogin` to get its answer, so asking the question was itself
   evidence. Every call site therefore recorded twice, and the threshold of 10
   fired after **5** real failed logins. Measured before: `2, 4, 6, 8, 9, 10`
   across six real attempts. After: `1, 2, 3, 4, 5, 6`.
2. **The route published an event the domain service had already published.**
   `audit()` *is* `emit()` — there is no separate audit log, the table is written
   by a subscriber — so `request.audit("user_login_failed")` in both login paths
   published the same failure a second time. It was written when "a wrong password
   produced a 401 and nothing else"; by then the domain service was already
   emitting with the reason and covering all five refusal paths.
3. **A poison job crashed the process.** `setTimeout(() => this.run(...), delay)`
   discarded the promise, so the attempt that exhausted the budget threw into an
   unhandled rejection, and Node terminates a process on one. One poison job took
   the server down — on the in-process driver, which is what a deployment without
   `REDIS_URL` gets.

Removing the duplicate emit exposed a fourth thing, which is the more interesting
one: **the audit subscriber discarded every payload field that was not a column.**
So the domain service's `reason` and the submitted address were being thrown away
on the way to the table, and the route's duplicate event was the only reason they
were ever recorded. Non-column payload keys are now nested under `metadata.event`.

That required restating one SEC-037 assertion honestly. It asserted
`row.userId === null` for a wrong password, which was true only because the *route's*
row was the one the test found — the route deliberately recorded no user id
because "at that point no credential has been proven". The single remaining event
names the targeted account, which is a *better* audit record and is what makes the
per-account anomaly keying work. The test now asserts what SEC-037 actually
claimed — that the attempt is identifiable by the submitted address, that an
unknown address is still recorded, and that `reason` distinguishes
`unknown_user` from `invalid_password`.

### The queue, which is the other half of §4.4

| | in-process | BullMQ |
|---|---|---|
| enqueue → execute | ✔ | ✔ |
| retry up to the attempt budget | ✔ | ✔ |
| stops at the budget | ✔ | ✔ |
| counted failed **once**, not per attempt | ✔ | — |
| dead-letter retrievable afterwards | **no** | ✔ |
| an unroutable job is not counted as work | ✔ | — |

The "no dead-letter" row is asserted rather than skipped, so it cannot be mistaken
for tested behaviour: `getFailed` returns `[]` and `retryAll` is a no-op, so on
that driver a permanently failing job is lost — a log line and a counter, and
nothing an operator can re-run. The BullMQ driver keeps them, which is one more
reason it is the default.

The SEC-053 regression sits in the same file, including the structural case:
**counting does not itself count** — record once, read five times, assert the count
did not move. A suite that only checked the end-to-end total would still pass if
someone merged the predicate and the recorder back together and moved the double
count somewhere else.

## 4.5 The CLI

**Finding:** §2.10. 177 lines, 8 commands, no tests — for the interface an
operator reaches for when something has already gone wrong.

**Do:** a test per command against a scratch database, asserting the exit code
and the database effect. `secrets:rotate` and `keys:create` get the most
attention, since both are destructive and both handle secrets.

**Gate:** the suite passes; `secrets:rotate` twice on the same secret is asserted
to be idempotent or to fail loudly, whichever is intended — decided explicitly
rather than left unspecified.

## 4.5 status — done, and the CLI could not create a user

Nineteen cases, one per command, each run as a **real subprocess against the real
database**. The exit code is the whole of what a CLI's caller observes, and the
defects below are exactly the ones an in-process test cannot see.

**SEC-055, high. Four defects in a 177-line CLI with eight commands and no tests.**

1. **`user:create` never worked.** It called `register`, which mints a token, but
   never called `loadSigningKeys()` — the server does that during bootstrap. Every
   invocation failed with `JWT signing keys not loaded`. This is the command that
   creates the **platform owner**, so it is the first thing anyone runs on a new
   deployment.
2. **Every command that opened a connection hung.** `org:create` printed
   `Created organization <id>` and then sat there forever. The operator's response
   to a hung command is Ctrl-C, which destroys the exit code that would have said
   the work was done.
3. **`secrets:rotate` reported success while rotating nothing.** The environment
   provider nulled its cache and re-imported the same `JWT_PRIVATE_KEY` and the
   command printed `Rotated signing key. New key id: env`. An operator rotating
   keys after a suspected compromise was told it had worked. The failure was also
   invisible to anything wrapping the command, because an exception out of an async
   commander action is an unhandled rejection and the process still exits 0.
4. **`--version` was hardcoded to `1.9.0`** against a package at 3.3.0.

The connection fix took two attempts and the first looked complete:

```
closing only the pool:   migrate ok   keys:list ok   user:create HUNG   org:create HUNG
closing all three:       all exit 0
```

`initializeContainer()` leaves three Redis sockets open — the shared client and a
second created inside the `cache` constructor. A partial fix is worse than none
here, because the commands that *do* work make the ones that do not look like a
different bug.

**The roadmap's explicit decision: `secrets:rotate` must fail loudly.** It cannot
be idempotent, because there is nothing to be idempotent about — the key comes
from `JWT_PRIVATE_KEY`. Generating a fresh pair in-process would be worse: every
instance reads the same environment variable, so each would mint a *different* key
and the cluster would stop agreeing on who signed what. With the database provider,
which stores keys and can genuinely rotate, each call is a real rotation and the
test asserts the key *changes* — so a change that starts reporting success without
rotating anything still fails.

Verified by breaking all four at once: **8 pass, 11 fail**, including the hang
cases, which fail by timing out. That is the correct shape for this defect — the
assertion is "did it return on its own", and a command that never returns cannot
be tested any other way.

## 4.6 Resolve the empty directories

**Finding:** §2.8. `src/tests/fixtures/` is empty; `src/tests/integration/` has
one file.

**Do:** either populate them or delete them. An empty directory named `fixtures`
or `integration` reads as coverage that does not exist.

**Gate:** no empty test directories remain.

### 4.6 status — already resolved, and the finding was stale

Both directories have real content and the roadmap's claim is out of date:

```
src/tests/fixtures/     saml-idp-test-cert.pem
src/tests/integration/  queue.test.ts   (now 3 files, after §4.4)
```

`fixtures/` holds the self-signed IdP certificate the SAML suites use, so it was
populated after the analysis was taken. Recorded rather than left to be
rediscovered, because "resolve the empty directories" reading as outstanding work
is what would prompt somebody to delete a certificate the SAML tests need.

---

# v3.5.0 — Operability and the SDK

## 5.0 status — the audit's own scope, measured

Found while reconciling CodeQL after §4.3–§4.5, and recorded before the rest of
this phase because it changes what the other items are worth.

**There are five published npm packages that no test, no Semgrep rule and no
registry entry covers.**

```
packages/keystone-cli     342 lines   1 file   handles credentials
packages/keystone-sdk     462 lines   1 file   handles credentials
packages/keystone-vue     144 lines   1 file   handles credentials
packages/keystone-node    102 lines   1 file   handles credentials
packages/keystone-react   (no src/)   —        built artefact only
```

All five are named `@hilbras/keystone-*` and documented as part of the product in
`docs/HOW-KEYSTONE-WORKS.md`. `release.yml` builds and packages
`packages/keystone-sdk`. **Zero of the 634 tests reference `packages/`.** The
Semgrep ruleset's `paths` cover `/src/routes/**` and `/src/services/**` and
nothing else. The registry has 53 findings and does not mention CodeQL, or these
packages, or `examples/`.

So the registry is a complete record of what was audited, and what was audited was
`src/`. Anything published under the same name that lives outside `src/` has never
been looked at. That is a defensible scope decision — but it was never *made*, and
the registry reads as the source of truth for all security claims, which is the
part that is wrong.

**CodeQL carries 25 open alerts across 10 rules, none of them in the registry:**

```
9  js/insufficient-password-hash         2  js/file-system-race
7  js/unused-local-variable              1  js/incomplete-sanitization
1  js/log-injection                      1  js/http-to-file-access
1  js/file-access-to-http                1  js/remote-property-injection
1  js/trivial-conditional
1  javascript.express.security.injection.raw-html-format...
```

Spread over `scripts/`, `packages/`, `src/plugins/rateLimit.ts`,
`src/services/workflows/engine.ts`, `src/services/email.ts`,
`src/services/setup/configWriter.ts` and two test files. Most are likely
false positives — `js/insufficient-password-hash` will fire on any call that
passes a hash to a comparison — but "likely" is not a decision, and nobody has
made one. A SAST surface that produces 25 unexamined alerts is a surface nobody
reads, and a scanner whose output is never trialled is worse than no scanner
because it looks like coverage.

The one alert this phase's own work created was a false positive:
`js/incomplete-sanitization` on `email.replace(/\./g, "\\.")` in
`src/tests/integration/cli.test.ts`, because the value was being escaped for a
regex. Replaced with `includes`, which the assertion wanted anyway — the address
is test data and needed no pattern matching.

**What 5.1–5.4 should therefore start with**, before the alerting metrics:

1. Decide the scope of the registry explicitly — `src/` only, or everything
   published — and say so in `docs/security/registry.md`. Whichever it is, the
   other is a named exclusion with a reason.
2. Triage the 25 CodeQL alerts into the registry, or dismiss them with a reason.
   Either is a decision; leaving them open is not.
3. Extend the Semgrep `paths` to cover `packages/` and `scripts/`, or record why
   not.

None of the three is urgent in the way a live defect is. All three are the
difference between a security registry that means something and one that means
"we looked here".

---

# v3.5.0 — Operability and the SDK

## 5.1 Instrumentation you can actually alert on

**Builds on §1.3.** Four spans exist; nothing alerts.

**Do:** the metrics an operator needs at 3am, which are not the ones currently
registered:
- authentication outcome by reason — success, invalid credentials, MFA required,
  MFA failed, rate limited
- token issuance and rotation counts, and replay detections
- SCIM and webhook delivery success/failure/latency
- the emergency local limiter engaging, meaning Redis is unavailable — this is
  the single most important operational signal in the system, since it means abuse
  protection is degraded

**Gate:** each series has a test asserting it increments, so a rename cannot
silently break a dashboard or an alert.

**Done when:** a dashboard answers "is authentication healthy" without a log
search.

## 5.2 Health and readiness that check what they claim

**Finding:** `GET /health` and `GET /ready` exist. Readiness is what a load
balancer uses to decide whether to send traffic, and a readiness probe that
returns 200 while the database is unreachable moves the problem rather than
solving it.

**Do:** `/ready` verifies the database and Redis are reachable; `/health` stays a
liveness check that does not depend on them, so a transient database outage does
not trigger a restart loop.

**Gate:** a test that `/ready` fails with the database unreachable, and a test
that `/health` still succeeds.

## 5.2 status — done, and the deployment had no readiness probe at all

**`/ready` did not exist.** The roadmap's claim that "`/health` and `/ready`
exist" was itself stale, and what the manifests did about it was the finding.

**SEC-056, high. `k8s/base/deployment.yaml` pointed its `readinessProbe` at
`/health`** — the only one of the two endpoints that was real. `/health` returns
`{status: "ok"}` unconditionally and touches nothing external, so a pod with no
database was reported **ready**, kept in the load balancer's rotation, and every
authenticated request it received failed. It pointed there because `/ready` had
never been written, while `README.md` documented it.

| | question | PostgreSQL down | Redis down |
|---|---|---|---|
| `/health` | is this process alive? | **200** | **200** |
| `/ready` | can it serve a request now? | **503** | **200** `degraded` |

`/health` must not depend on PostgreSQL either: a liveness probe that does turns a
transient blip into a restart loop, which is a worse outage than the one it was
reacting to. Redis alone is `degraded` and answers 200 — a pod with no Redis falls
back to the in-process queue and can still authenticate, so removing it from the
rotation would take authentication offline for a recoverable degradation.

Both checks are real commands — `select 1` and `ping` — each bounded at 2s, run in
parallel. A status read is not enough: a pool that exists is not a database that
answers, and the shared Redis client is `lazyConnect`, so its status is `"wait"`
until some *other* code path issues a command.

The §3.1 layering rule fired on the first version of the route, correctly, because
it ran `select 1` in a route. The checking moved to `services/health.ts`.

**SEC-057, medium. A Redis outage made the probe unable to report the Redis
outage.** Both probes sat behind the global rate limiter — an `onRequest` hook, so
before the handler — and the limiter uses Redis. With both dependencies down, over a
real socket:

```
handler's own verdict    2.0s   every call
1st HTTP response        8.1s
2nd HTTP response       20.3s
3rd HTTP response       20.4s
```

Against the manifest's `timeoutSeconds: 5`, the kubelet would have recorded a
**timeout** rather than the 503, during precisely the outage the probe exists to
report. With Redis healthy the same call took **31ms**, which is what identified the
limiter. After the exemption: 576ms, 2.0s, 2.0s.

Getting there took ruling out three candidates, and the wrong one is the lesson:

| hypothesis | test | result |
|---|---|---|
| the probe's own timeout is too long | per-check latencies in the body | 2.0s — handler is fine |
| `ioredis` queues the abandoned `ping` | replaced `ping()` with a status read | still 20s — not ioredis |
| `app.inject` resolves late, so this is a test artefact | hit a **real socket** | still 20s — it is real |
| the global rate limiter | dead database, healthy Redis | **31ms** — confirmed |

If `inject` had been the source, the fix would have been aimed at the test and the
probe would still ship taking twenty seconds during an outage.

Two traps worth keeping, both in [`docs/security/monitoring.md`](security/monitoring.md):
a cache-busting query string on an entry module does **not** reach its dependencies,
so `import("./index.js?dead=1")` got the healthy pool and the first version of the
test asserted nothing — the outage is now produced in a separate process. And
`return reply;` from an async `onRequest` hook **deadlocks the request**; the
exemption is a bare `return;` with a comment saying why.

Thirteen cases, each against a real server: the probes answer unauthenticated,
report both dependencies with a latency, stay inside the manifest's timeout on
repeat calls, distinguish degraded from unavailable, and the same process serves
real traffic again once the database is back.

## 5.4 status — the manifest gate exists, and it caught a dead check of its own

`scripts/verify-k8s-manifests.mjs` renders `k8s/base` and both overlays and fails
on a readiness probe not at `/ready`, a liveness probe not at `/health`, an image
tag that is `:latest` or disagrees with `package.json`, a container with no resource
limit or request, a variable `config.ts` insists on that nothing provides, an
`envFrom` pointing at nothing, and a placeholder. It runs in the `gates` job and is
a required check on `main`. Each was verified by planting it.

**`newTag: latest` was the placeholder**, and the tag in `deployment.yaml` was
decorative: a kustomization `images` entry overrides it. Both are pinned to the
version now, and the check compares the *rendered* result, which is the only
comparison that can tell the truth about what a deployment would run.

The YAML reader is hand-written (`scripts/lib/yaml.mjs`) so the gate has no second
failure mode. It had three bugs, each making the gate report something false — and
the third is the one worth naming:

> `containersOf` read `spec.containers`, but a Deployment has them at
> `spec.template.spec.containers`. It returned nothing, so **the entire Deployment
> block was dead code** and the gate printed `version: 3.4.0 (manifest image tag
> matches package.json)` while the image was `:latest`.

A summary line claiming a check that had never run — a check that could not fail,
which is the failure this programme has been about all along. It was visible only
because the summary asserted something a reader could contradict by opening the
file.

Two things came out of it. `scripts/lib/patch.mjs` throws when a replacement
matches nothing, because a `str.replace` that changes nothing is a silent no-op
that looks exactly like a success — one of these migrations reported "manifests
pinned to 3.4.0" for a pattern indented two spaces off, and I believed it. And every
claim now gets checked against the file it is about.

## 5.3 The SDK packages

**Finding:** five packages, no release discipline of their own. The
`@hilbras/keystone-react` and `-vue` packages are thin wrappers over
`INTEGRATION.md`, and the guide's code samples have no test.

**Do:**
- extract the code samples from `HOW-KEYSTONE-WORKS.md` and
  `INTEGRATION.md` into runnable examples that are compiled in CI, so a sample
  cannot rot into something that does not work
- one version across the five packages, released together, matching the server
- state the supported range explicitly: which server versions each supports

**Gate:** every code sample in the documentation compiles or runs. This is the
documentation equivalent of a regression test, and it is the only thing that stops
example code decaying into fiction.

## 5.4 Kubernetes manifests that are current

**Finding:** `k8s/` exists with a base; there are no Helm charts, and the
manifests are not covered by any check.

**Do:** verify the manifests against the current configuration surface — every
required environment variable present, the readiness probe pointing at `/ready`,
resource limits set, and the `COOKIE_SECURE`/proxy settings consistent with a
production deployment. Then have CI render them and assert the image tag matches
`package.json`.

**Gate:** `kustomize build k8s/base` succeeds and the rendered manifest contains
no placeholder and references the current version.

---

# Cross-cutting

## Gates added across these releases

| Gate | Fails when |
| --- | --- |
| image hygiene | the built image contains credential material |
| query plans | a repository query sequential-scans a table over 1,000 rows |
| trace spans | any of the four chokepoint spans is missing |
| benchmark | a hot path regresses against the recorded baseline |
| layering | a route imports the database or drizzle |
| route guards | a route has no authentication guard without a written reason |
| behaviour suites | email verification, WebAuthn, federation, queue, metrics, CLI |
| doc samples | a code sample in the documentation fails to compile |
| manifests | a rendered manifest is stale or missing configuration |

**Every one of them must be verified by breaking it.** That is the practice the
security programme established, and it is the only reason any of the existing
gates are trustworthy.

## What this plan deliberately does not do

- **No new security controls.** The programme is complete and adding more would
  be motion. If something genuinely new is found it gets fixed immediately,
  outside this plan, with a registry entry as always.
- **No framework or language change.** Fastify, Drizzle and React are fine. The
  problems measured are not caused by them.
- **No feature work.** Five versions of measurement, correction and operability.
  Features belong in a plan that starts from a codebase whose existing behaviour is
  understood — which is what 3.1.0 through 3.4.0 deliver.

## Sequencing and risk

```
3.1.0  Measure ──────────────►  no behaviour change      low risk
3.2.0  Database layer ──────►  schema migration          medium
3.3.0  Codebase shape ─────►  refactor, no behaviour     medium
3.4.0  Behaviour tests ────►  tests only                low
3.5.0  Operability + SDK ──►  manifests, packaging       medium
```

Each is independently shippable and independently revertable. 3.2.0 carries the
only schema migration; if it needs reverting, 3.1.0's measurements keep their
value and 3.3.0 can proceed.

The plan does not assume 3.1.0's measurements come out as expected. If the query
plans show a problem nobody predicted, the fix belongs in 3.2.0 and the plan is
adjusted — which is why 3.1.0 is a release at all.
