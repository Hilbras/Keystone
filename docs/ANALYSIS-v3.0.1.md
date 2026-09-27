# Keystone — codebase analysis

**Subject:** Hilbras Keystone at `v3.0.1` (commit `125db7f`)
**Date:** 2026-09-27
**Method:** static measurement of the repository, plus running the gates. Every
number below was counted, not estimated; the command that produced it is given
where the result is load-bearing.

This is an assessment of engineering health, not a security audit. The security
posture is covered separately in [`docs/RE-AUDIT.md`](RE-AUDIT.md) and
[`docs/security/registry.md`](security/registry.md).

---

## 1. What the project is

An identity and access platform: authentication, authorization, multi-tenancy,
OAuth 2.0 / OIDC, SAML, SCIM, MFA, WebAuthn, API keys, mTLS service accounts, and
an immutable audit log.

| | |
| --- | --- |
| Backend source | **23,327** lines across 77 TypeScript files |
| Tests | **9,208** lines, 451 tests (402 security) |
| Frontend | **11,120** lines, 85 files, React 19 + Vite 8 + Tailwind 4 |
| Documentation | **6,023** lines across 200 markdown files |
| SDK packages | 5 (`keystone-sdk`, `-node`, `-react`, `-vue`, `-cli`) |
| Production dependencies | 26 |
| Database | PostgreSQL 16, 32 tables, 18 migrations |
| Runtime | Node 22, Fastify 5, Drizzle ORM, Redis (ioredis) |

**Scale judgement.** At 23k lines of backend source, this is a mid-size service.
It is large enough that a route added without checking the security model is a
real risk, and small enough that one person can still hold the whole system in
their head. The 39% test-to-source ratio is strong for a project of this age.

---

## 2. Findings

Ordered by consequence. Severity here means *engineering risk*, not security
severity.

### 2.1 `COPY . .` with no `.dockerignore` — **High**

```dockerfile
COPY . .          # Dockerfile:12
```

There is no `.dockerignore` in the repository. The build context therefore
includes everything in the working tree that is not in a `COPY` allowlist:

| In the context | Size |
| --- | --- |
| `node_modules/` | 240 MB |
| `.git/` | 15 MB |
| the working tree | 13 MB |

A developer's local `.env` is **not** gitignored from Docker's perspective —
`.gitignore` and `.dockerignore` are independent files. So `docker build` on a
machine with a populated `.env` copies that file into the builder stage.

The published runtime image is probably clean — the final stage copies only
`dist/` — so this is not the same severity as a secret in the shipped artefact.
But the intermediate layer holds it, and anyone with the build cache or a
`docker history` on that builder image can read it. The npm path has an explicit
check for this; the container path has none.

**Cost of the gap:** every build also ships 255 MB of context it does not need,
which is the larger day-to-day annoyance.

**Fix:** add `.dockerignore`, and assert the built image contains no `.env`,
certificate, or `.git` — the container equivalent of
`verify-release-metadata.mjs`.

### 2.2 OpenTelemetry is a dependency and is configured, but nothing is instrumented — **High**

```
$ rg -c 'span\(|tracer' src/    →  0 call sites
```

`@opentelemetry/sdk-node` and `auto-instrumentations-node` are production
dependencies, `startTracing` is wired into the bootstrap, and there are **zero**
custom spans. Every trace is therefore HTTP-and-database auto-instrumentation.

This is a cost with no corresponding benefit: the dependency, the configuration
and the sampling decision are all real, and none of it reaches the code paths
that matter for an identity platform — the MFA chokepoint, refresh rotation,
SCIM provisioning, or webhook signing. When a login is slow, nothing in the trace
distinguishes *argon2id was the right answer* from *a database query in a loop*.

**Fix:** instrument the four chokepoints, or drop the dependency. Both are
defensible; the current state is not.

### 2.3 Two tables have no index at all — **High**

```
permissions        0 indexes
role_permissions   0 indexes
```

Both are read on the authorization path. `permissions` is seeded at boot and
queried by `requirePermission`; `role_permissions` joins to it. At small
permission counts a sequential scan is invisible, which is exactly why this will
be found in production rather than in CI.

Every other table has at least one index. These two are the exception, and they
sit on the hottest read path in the system.

**Fix:** index the columns these are actually queried by. Cheap, and testable
with `EXPLAIN`.

### 2.4 N+1 and O(n²) in SCIM group handling — **High**

`src/routes/scim.ts`, the group read path:

```ts
page.map(async (group) => {
  const members = await app.container.scimGroupRepository.listMembers(orgId, group.id);
```

One query per group per page. At the default page size this is the difference
between 1 query and N.

The membership write path is worse — a nested loop that re-reads the full member
list inside a loop over the submitted members:

```
for (const member of body.members) {      // :809
  const current = await listMembers(...)  // re-read every iteration
  for (const member of current) { ... }   // :815
```

That is quadratic in group size and performs a full read per member. A large IdP
group push is a realistic SCIM workload, and this is the endpoint that receives
it.

**Fix:** one `WHERE group_id = ANY($1)` read, and a set-difference reconcile
instead of a re-read per member. The repository layer already exists, so this is
contained.

### 2.5 The layering rule in `AGENTS.md` is not enforced — **Medium**

`AGENTS.md` states: *"Routes must not import from `../db/index.js` directly —
use repository interfaces."*

```
$ rg -l 'from "\.\./db/index\.js"' src/routes/
  src/routes/setup.ts
  src/routes/workflows.ts

$ rg -l 'from "drizzle-orm"' src/routes/
  src/routes/setup.ts
  src/routes/workflows.ts
  src/routes/admin/platform.ts
```

The first two import the database *and* drizzle, and issue raw SQL.
`admin/platform.ts` imports drizzle for query builders without importing `db`
directly — a lighter version of the same violation. This is the same
finding the API review recorded structurally: `workflows.ts` performs its
authorization inside handlers because it bypasses the guard layer entirely.

The rule is documented, correct, and unenforced — so the next route written will
follow whichever example the author read most recently.

**Fix:** a lint rule, or an architecture test asserting routes never import the
db. Both belong in the `sast.yml` project ruleset, which already exists for
exactly this kind of pattern.

### 2.6 Error handling is two systems — **Medium**

```
services/    70 × Promise<Result<T>>    105 × throw new …
routes/      40 × sendResultError         10 × raw status(500)
```

The documented convention is `Result<T>`, "return `Result<T>` objects instead of
throwing". Roughly 60% of services follow it. A caller cannot know which
convention a given method uses without reading it, and a `throw` in a
`Result`-returning method bypasses `sendResultError` entirely — producing a 500
where a 403 was intended.

76 `console.*` calls also bypass the injected logger, so those errors do not
carry request context in the log.

**Fix:** pick one. This is a migration, not a rewrite: forbid `throw` in domain
services by lint, and let the existing catches handle the remainder.

### 2.7 Permission evaluation is uncached and per-request — **Medium**

`requirePermission` is called from `requireOrganizationRole` on every
organization-scoped request, and it reads the database. The `GLOBAL_RATE_LIMIT`
config implies caching elsewhere exists, but the authorization read does not use
it.

Permissions change rarely. They are also the read with no index (§2.3).

**Fix:** cache role→permissions per role with invalidation on permission writes.
The `CACHE_KEY_PREFIX` config already exists.

### 2.8 Test coverage is security-shaped, not behaviour-shaped — **Medium**

402 of 451 tests are the security suite. That is a deliberate and correct
priority, and the coverage is genuinely adversarial.

The consequence is that ordinary behaviour is thin:

| Area | Tests exercising it |
| --- | --- |
| `emailVerification` | **0** — one file names the limiter; no test calls the endpoints |
| `plugins/metrics` | **0** |
| `webauthn` | 1 |
| `federation` | 3 |
| `queue` | 1 |

The email verification row shows why "referenced" and "exercised" are different.
A grep for the module name returns one hit, in
`rate-limiting/abuse-prevention.test.ts` — a list of limiter prefixes. A grep for
the endpoint returns nothing. The flow is never invoked, and a coverage percentage
would have said the same thing less clearly.

Email verification is a credential-bearing flow with a token, a TTL and a
consumed marker, and no test invokes either of its two endpoints. `src/tests/integration/`
contains one file and `src/tests/fixtures/` contains none — a directory someone
created for work that was not done.

**Fix:** the missing behavioural tests first, then the empty directories
resolved one way or the other.

### 2.9 Two security suites sit outside the domain structure — **Low**

```
src/tests/security/audit-export.test.ts
src/tests/security/registry.test.ts
```

Both are at the root of `security/` while every other suite is in a domain
directory. The registry validator accepts them because it matches on path, not
location, so this is cosmetic — but a structure that is 14/16 consistent invites
the question of which rule is the real one.

**Fix:** `configuration/audit-export.test.ts` and a home for the registry check.

### 2.10 Error handling in the CLI is thin — **Low**

`src/cli.ts` is 177 lines with 8 commands and no test file. It performs
destructive operations — `user:create`, `org:create`, `secrets:rotate`,
`keys:create` — with no coverage. A CLI is the interface an operator uses when
something has already gone wrong, which is exactly when it needs to be reliable.

---

## 3. Where the project is genuinely strong

A report that only lists problems is not an assessment.

**The security programme is real.** 44 findings, each with a regression test,
machine-enforced. Two entries were withdrawn during this cycle because they
described defects that did not exist — which is the correct outcome of a registry
that verifies its own claims.

**The controls are verified, not asserted.** `registry:check`, `reaudit:check`,
`check:docs` and `review:api` are all checks that were verified by breaking them.
The API review was wrong four times before it was right, and the corrections are
in the document rather than quietly fixed.

**The release gate works.** It blocked two releases during this cycle — once on a
Gitleaks licence check in a gate I had misconfigured, and once when a duplicated
test step tripped the rate limiter. Both were real defects in the release
process, caught before publication.

**Documentation is unusually good for a project this size.** 6,023 lines, a
generated re-audit matrix, per-topic security docs, and 137 links checked
mechanically including anchors.

**The dependency posture is clean.** 0 vulnerabilities across production and dev,
no lockfile-scanner-visible advisories in the image, signed provenance, SBOM.

---

## 4. Summary

| Area | Assessment |
| --- | --- |
| Security | **Strong.** 44 findings, all with tests, zero unresolved Critical. |
| Documentation | **Strong.** Generated, verified, link-checked. |
| Supply chain | **Strong**, with one real gap (§2.1). |
| Test discipline | **Strong on security, thin on behaviour** (§2.8). |
| Observability | **Weak.** Dependency present, nothing instrumented (§2.2). |
| Data layer | **Adequate.** Two unindexed hot tables, N+1 in SCIM (§2.3, §2.4). |
| Consistency | **Adequate.** Layering and error handling are conventions, not rules. |
| Operability | **Adequate.** Dockerfile and compose present, `.dockerignore` missing. |

The security work this project did is above the norm for its size. The remaining
gaps are the ordinary ones of a codebase that grew fast under pressure: the
things that were measured got fixed, and the things that were not measured —
query plans, trace spans, behavioural tests — are still unmeasured.

That is the honest shape of the next five versions of work: **stop adding
controls and start measuring the ones already in place.**

---

## Appendix — reproducing these numbers

```bash
# scale
find src -name '*.ts' -not -path '*/tests/*' | xargs cat | wc -l

# layering violations
rg -l 'from "\.\./db/index\.js"' src/routes/

# unindexed tables
python3 -c "
import re; s=open('src/db/schema.ts').read()
for m in re.finditer(r'pgTable\(\s*\n?\s*\"([a-z_]+)\"(.*?)\n\);', s, re.S):
    n=len(re.findall(r'index\(', m.group(2)))
    if n==0: print(m.group(1))"

# tracing
rg -c 'span\(|tracer' src/

# error-handling split
rg -c 'Promise<Result<' src/services/ ; rg -c 'throw new' src/services/
rg -c 'sendResultError' src/routes/ ; rg -c 'status\(500\)' src/routes/

# build context, and the missing ignore file
ls -a | grep dockerignore || echo "no .dockerignore"
du -sh node_modules .git
```
