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

## 4.2 WebAuthn, end to end

**Finding:** §2.8. One test file references it. Passkey registration and
authentication are the strongest factor Keystone offers and the least exercised.

**Do:** registration options → verify → authenticate options → verify, plus
replay of a challenge, a challenge from another session, and a signature from a
different credential.

**Gate:** the suite passes, and each rejection case fails when the check is
removed.

## 4.3 Federation

**Finding:** §2.8. Three test files reference it, against six connectors.

**Do:** per-connector tests for the exchange path — nonce forwarded, ID token
verified with the configured algorithm, `email_verified` respected, a connector
returning no email rejected, and account linking that will not attach a federated
identity to an existing local account without proof.

**Gate:** the suite passes. The Google nonce regression (SEC-020) is one of these
and must stay.

## 4.4 The queue and metrics

**Finding:** §2.8. One test file references the queue; none references metrics.

**Do:** job enqueue → execute → retry → dead-letter, and for metrics: every
registered series increments on a real request, so a renamed label is caught
rather than silently changing a dashboard.

**Gate:** both pass; the metrics test asserts the series *exist*, which is the
part that rots.

## 4.5 The CLI

**Finding:** §2.10. 177 lines, 8 commands, no tests — for the interface an
operator reaches for when something has already gone wrong.

**Do:** a test per command against a scratch database, asserting the exit code
and the database effect. `secrets:rotate` and `keys:create` get the most
attention, since both are destructive and both handle secrets.

**Gate:** the suite passes; `secrets:rotate` twice on the same secret is asserted
to be idempotent or to fail loudly, whichever is intended — decided explicitly
rather than left unspecified.

## 4.6 Resolve the empty directories

**Finding:** §2.8. `src/tests/fixtures/` is empty; `src/tests/integration/` has
one file.

**Do:** either populate them or delete them. An empty directory named `fixtures`
or `integration` reads as coverage that does not exist.

**Gate:** no empty test directories remain.

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
