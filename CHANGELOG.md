# Changelog

All notable changes to Hilbras Keystone are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.5.13] - 2026-09-30

*Sixteen gate steps report a verdict. Nothing had established that any of them could report the wrong one.*

### SEC-074, low — the gates were never measured

The `gates` job runs 16 mechanical checks. Each prints a verdict and exits with a
code, and each has caught a real defect at some point. **Nothing in the repository
had ever asked whether any of those verdicts could be wrong.**

This is the project's own defect class — ~45 instances now, every one a control
reporting success for something other than what it measures — turned on the
apparatus that exists to hunt for it. SEC-073, last release, was a gate that
could not see an entire Kubernetes resource kind, and it was found by reading the
file rather than by any signal the tooling produced. That is the expected way to
find these, and it is also the only way, which makes "we read it" the whole of
the assurance.

The gates are not broken. Probing twelve of them against the defects each is
*named* for shows all twelve fail correctly. That is a real result. The defect is
that it was unknowable without writing the probe — and the probe is one file that
runs in 35 seconds.

Low, and deliberately not overstated: no gate is passing on something it should
catch today, and no vulnerability follows from the gap. What follows is that a
gate could stop working — rewritten to read the wrong key, lose a branch, match a
path that no longer exists — and the build would stay green.

### The probe

`scripts/probe-gates.mjs`, wired into `ci.yml` as a 17th gate step. For each of
twelve named gates, a mutation that gate is documented to catch is applied to a
**scratch copy** of the tree, and the gate must exit non-zero. No database, no
Redis, no network, and nothing written to the working directory.

The twelve mutations are defects this project has actually hit: the Dockerfile
drifting from `.nvmrc`, a readinessProbe at `/health`, a container with no memory
limit, the SEC-073 base Ingress, a missing changelog entry, the 3.5.11
duplicate-heading defect, `engines.node` disagreeing with `.nvmrc`, a registry
entry naming a test that does not exist, a withdrawn id with no reason,
documentation naming an npm script that does not exist, an SDK package drifting
from the server, an action pinned to a tag.

In `ci.yml` rather than a document, because a probe nobody runs rots — and a
rotting probe is the same failure at a third level, keeping its 12/12 green about
gates that had moved on.

### The probe caught its author within the hour

The first version reported the readiness check as **NOT CAUGHT** — a false
accusation against a gate that was working perfectly. The cause was mine: it
mutated the string `/ready` in `deployment.yaml`, and the first occurrence is
eight lines above the `path:` field, inside a comment reading "`/ready`, not
`/health`". It rewrote a sentence, left the manifest byte-identical, and the gate
correctly reported success.

So the probe now snapshots every file it might touch and **refuses to report a
result for a mutation that changed nothing** — reporting "the probe is lying,
not the gate" instead. A control that cannot distinguish its own failure from the
thing it audits is not a control.

```text
before the guard:   NOT CAUGHT  verify-k8s-manifests.mjs  readinessProbe → /health
after:              caught     verify-k8s-manifests.mjs  readinessProbe → /health
```

### Verified by breaking the thing it audits

Deleting the `readinessProbe !== "/ready"` branch from
`verify-k8s-manifests.mjs` — the check that script exists for — drops the probe
to 11/12 and names the right gate. Restored: 12/12.

| | result |
|---|---|
| as written | **12/12 caught** |
| readiness check deleted from the k8s gate | **11/12, names `verify-k8s-manifests.mjs`** |
| restored | 12/12 |

### What it does not cover

Four of the sixteen steps, printed by the gate itself on every run rather than
left as a silent omission: the two that read `dist/`
(`generate-auth-dashboard.mjs`, `verify-doc-samples.mjs`), lint, and
`review-api-surface.mjs --strict` — the last two already covered by
`--deny-warnings` failing CI and by `reviewApiSurface.test.ts` respectively.

"Twelve of sixteen" is the honest claim. The gate says so on every run.

### Also

- `oxlint --deny-warnings` caught a dead `const before` in the probe, left by an
  earlier edit. The lint gate doing its job on the thing that audits the gates.

## [3.5.12] - 2026-09-30

*The Ingress was in the base. A document said the shipped manifests kept /metrics internal, and a gate that could not see an Ingress agreed.*

### SEC-073, medium — three controls, none of which measured the thing

`/metrics` is unauthenticated by decision, and 3.5.10 wrote that decision down
properly. It then added a sentence about the deployment:

> `k8s/base/service.yaml` is a `ClusterIP`, so in the shipped manifests `/metrics`
> is reachable from inside the cluster and not from outside it.

**False, for the manifests this repository ships.** `k8s/base/ingress.yaml`
declared an Ingress at `path: /` with `pathType: Prefix` — which matches
`/metrics` like any other path — and `k8s/base/kustomization.yaml` listed it as a
base resource, so `overlays/dev` and `overlays/production` both inherited it. A
ClusterIP keeps a Service internal *from the Service*. The Ingress was sitting in
front of the Service.

The sentence was written in the same release that first asked why this route was
public, and it was checked against the Service. Nobody looked at the Ingress.

### The gate could not see it

`verify-k8s-manifests.mjs` rendered every resource in `k8s/` and then branched on
`doc.kind === "Deployment"` for every check it performed. The Ingress was in the
rendered set — counted, on screen, in `base: 9 resources` — and never examined:

```
Kubernetes manifests OK.
  version: 3.5.11 (manifest image tag matches package.json)
  probes:  liveness /health, readiness /ready
```

This is the same defect as the `containersOf` bug already documented in §5.4 of
that file, reached by a different route: that one read `spec.containers` where a
Deployment keeps them at `spec.template.spec.containers`; this one never matched
on `kind` at all. Both are a check that cannot fail. Both were found by reading
the file the check is about, not by reading the check's output — which is the
whole of the argument for doing that.

The gate now reads Ingress rules. A path that is exactly `/metrics`, or a `Prefix`
path that is `/` or starts with `/metrics`, is a publication; an annotation whose
key matches `/snippet/i` and whose value names the path is an exclusion. A
published path with no exclusion fails, naming the file — once, not once per
overlay that inherits it, because four identical lines read as a stuck gate.

### The Ingress is now opt-in

The base is ClusterIP-only, which is what makes the safety claim true rather than
merely stated. The Ingress is `k8s/overlays/ingress`, which builds on
`overlays/production` and carries the host, the TLS secret and the exclusion
together; the Ingress patches that used to live in the two overlays are gone,
because they patched a resource that is no longer in the base.

`kubectl apply -k overlays/ingress` instead of `overlays/production`. A deployment
that never wanted a public hostname applies `overlays/dev` or
`overlays/production` and is internal by default — which is the usual case for a
scrape endpoint, since Prometheus normally runs in the cluster.

### The prescribed remedy was itself inert

The 3.5.10 text told an operator to exclude the path with
`nginx.ingress.kubernetes.io/server-snippet`. That annotation **is ignored unless
the cluster sets `allow-snippet-annotations: "true"` on the ingress-nginx
ConfigMap, and `false` is the default** — it became the default in the fix for
CVE-2021-25742, where a user with permission to create an Ingress could read every
Secret in the cluster through a snippet.

So on a current cluster the annotation is dropped *silently*. The Ingress applies
cleanly, `kubectl apply` succeeds, `/metrics` is still public, and there is no
error to notice. An operator following the documented remedy to the letter would
have believed they were protected and been wrong. The documented way to make the
annotation work is to set the flag that re-opens the CVE.

The exclusion is kept in the overlay, with the caveat in the file, because a
cluster that has already decided about snippets is entitled to use one — and
because deleting a working option to make a point is its own kind of inaccuracy.
The gate's own output repeats the warning, so the caveat travels with the verdict.
The two approaches that need nothing from the controller are documented instead.

### The registry's own checker rejected the house style

Writing the entry failed the registry check twice, both times on a path that
exists. `resolveFixPath` strips backticks implicitly only in its `src/….ts`
branch, where the regex stops at the closing tick; a `scripts/….mjs` path has no
such branch, so `existsSync` was asked about `` `scripts/….mjs` `` — a filename
with backticks in it, which has never existed. The file's prose convention is to
write paths in backticks, so the checker rejected the house style for every
non-`.ts` path. Backticks are now stripped explicitly.

### Regression

`src/tests/security/infrastructure/ingressDoesNotPublishMetrics.test.ts`, four
cases. The load-bearing one rebuilds the original Ingress in a scratch tree and
requires the gate to exit non-zero, so the check is exercised rather than
trusted. Verified both ways:

| restored | result |
|---|---|
| as shipped in 3.5.11 | **1 pass, 3 fail** — gate exits 0 on a publishing Ingress |
| the Ingress block deleted from the script | **3 pass, 1 fail** — the blind-gate case |
| this release | 4 pass |

### Also

- `review-api-surface.mjs`: the `/metrics` `PUBLIC_BY_DESIGN` reason repeated the
  same false ClusterIP claim, and that is the text a reader of the API review
  would have believed. It now states the exposure and points at the overlay.
- `k8s/README.md`: documents the third overlay, which command to apply, and why
  the base has no Ingress.

## [3.5.11] - 2026-09-30

*Two releases shipped with two changelog sections each, and the gate that checks the changelog could not see it.*

### SEC-072, low — a duplicate the ordering rule cannot see

`CHANGELOG.md` shipped **two `## [3.5.8]` sections and two `## [3.5.10]` sections**, in 3.5.9
and 3.5.10. 143 lines of superseded prose, and a reader of the published changelog cannot
tell which of the two sections is the release notes.

Both duplicates were mine and both came from the same mistake: writing a release entry, then
writing a second, *expanded* entry for the same version and inserting it above the first
instead of replacing it.

**`verify-changelog.mjs` passed both times**, reporting `38 headings, newest first` — true of
the file it was reading, and useless as a statement about whether the changelog is well formed.

It could not have caught them. The ordering rule is `compare(previous, current) < 0`, and
`compare(a, a) === 0`, which is not `< 0`. So:

```
## [3.5.8]   ## [3.5.10]   ## [3.5.8]
```

is **in order** by the only rule the file had. A duplicate sitting directly above an older
version is invisible to an ordering check, by construction.

This is the failure this project keeps finding — a control reporting success for the thing it
exists to catch — in the shape it is least expected in. A release-notes file is the one
artefact nobody reads as code and everybody reads as documentation, so "two entries for 3.5.8"
survives review and is nonsense to a reader.

### Fixed, and checked before deleting rather than after

The gate now asserts each version appears **exactly once**, reporting both line numbers. The
check is about *count*, not content: two sections for one version are wrong whether the second
is a superset, a subset, or a contradiction, and judging which to keep would be a heuristic
where a fact will do.

**Verified by reintroducing a duplicate exactly as it shipped** — a second `[3.5.10]` directly
above `[3.5.9]`, which is in order and therefore invisible to the old rule. The gate fails,
exits 1, and names lines 8 and 168. Restored: exit 0.

The superseded sections were deleted only after confirming, line by line in the file, that
every identifier and finding reference in the older draft was present in the newer one. A
line-level diff on re-wrapped prose reports 54 "missing" lines that are only re-wrapped
sentences — **and a first pass at that comparison was itself misleading**, and would have been
the wrong basis for deleting 143 lines of release notes. A second, sharper check (locating each
string and asking which section it falls in) showed every one of them present in both drafts.
## [3.5.10] - 2026-09-30

*The number was right about the wrong thing: 178 routes, when the server serves 181.*

### SEC-070, medium — three routes the review tool had never seen

`review-api-surface.mjs` built its file list by walking `src/routes`. Three routes this
server serves are declared outside that directory, so **none of them was ever analysed**:

| route | declared in |
|---|---|
| `GET /.well-known/openid-configuration` | `src/index.ts` |
| `GET /.well-known/jwks.json` | `src/index.ts` |
| `GET /metrics` | `src/plugins/metrics.ts` |

No authentication-guard check, no rate-limit check, no reason recorded for being public,
and no contribution to the total. The report said **178 routes** as though that were the
surface. It was 181.

The tool's own prefix walk *starts* at `src/index.ts` — every mount prefix in it is derived
from a `register` call in that file — so two of the three were read constantly and never
counted. `src/plugins/metrics.ts` was in the mount table too, reached through
`app.register(metricsPlugin)`, and appeared in no report.

**This is SEC-064's failure one level out.** There, seven route files were unplaced and the
tool reported a clean surface over a surface it had never looked at. Here the walker was
pointed at a *directory*, and the effect is a number simply lower than reality — the easier
version of the same mistake to miss, because an undercount reads as tidiness rather than
omission.

Severity is medium, not high: all three are genuinely public by design and nothing was
exposed. The cost was that the tool's stated coverage of the authentication surface was
overstated by three routes, and its total was wrong in the direction that looks clean.

#### The measure of the gap

`--strict` failed the instant the walker was widened, demanding a recorded reason for each
route. That is the check that had never been applied to them. Three reasons were written —
and the `/metrics` one is the longest, because it is the only decision here that carries an
obligation on the operator.

**`/metrics` is unauthenticated by design, and that was stated nowhere.** It is exempt from
the global rate limiter for a good reason already on record (a scrape behind a limiter gets
429s at 3am, and the metrics are gone exactly when something is wrong). It exposes route
templates, request rates and error rates — no tenant data. `k8s/base/service.yaml` is a
`ClusterIP`, so it is cluster-internal by default.

The part that was missing: **an operator who fronts Keystone with an Ingress inherits
`/metrics` and publishes the route table to the internet.** That obligation is now in
`docs/security/monitoring.md` with the annotation and a `curl` to verify it after deploying.

#### A hand-kept list is what failed here three times over

The walker now covers `src/`, skips `src/tests`, and keeps only files that actually declare
a route — so a new route file anywhere under `src/` is found without anyone adding it to a
list. `EXCLUDED_FROM_REVIEW` names the one deliberate exclusion, `src/setup-server.ts`, with
its reason: it is a standalone Fastify instance behind `npm run start:setup`, and its
`/health` would otherwise collide with the main app's own. Recorded rather than skipped in
the walker, because a silent exclusion is the same failure one level down.

#### Narrowing the walker exposed that a check was wrong

`--strict`'s "unplaced route file" check now applies only to files that declare routes,
because a route-less file *has* been checked — read, and found empty. Demanding a mount
prefix for a helpers module is what `NO_ROUTE_FILES` used to exist to excuse. **The rule was
wrong, and the test fixture that depended on it was not testing the check**: it planted a
file exporting a bare constant. It now plants a real route that nothing registers, which is
the condition the check exists to catch.

#### The test now decides "route-shaped" independently of the tool

The coverage test compares the report against its own file scan — and that scan uses a
deliberately cruder rule than the tool's parser: any `.get(`/`.post(`/`.put(`/`.patch`/
`.delete(` call whose first argument is a string. Using the tool's own `findRoutes` would
have meant checking the tool against itself, and a bug in it would make a file look route-less
to both.

It matched 32 files across `src/`: the 31 the tool analyses, plus the recorded exclusion, and
**nothing else**. The bias is toward over-inclusion on purpose — a false positive shows up as
a file that has to be justified, while a pattern that missed a form the tool accepts would
fail the other way and silently. Verified by excluding `src/plugins/metrics.ts` again: the
test fails and names it.

#### `--explain` was showing less than it had

Filtering the explanation to the analysed files dropped the barrels, and with them the one
hop a reader cannot infer — `src/routes/admin.ts` is a single `export { default }` line, so
the step through it is invisible in the file itself. **The derivation data still held the
hop; no output showed it.** A gate asserting the word `re-exports default from` appeared
somewhere passed while the diagnostic a person reads no longer contained it. `--explain` now
iterates the mount table.

Its summary said `41/31 route files placed` for a while — a count above the total, which is
the same impossible ratio that was the tell for the SEC-064 walker bug. It now states two
populations: `41 file(s) with a resolved prefix, of which 31 declare routes.`

### A general invariant, added because the hand check will not happen twice

`GET /.well-known/openid-configuration` is **a list of URLs this server asserts exist.** Every
conforming OIDC client fetches it and then calls what it names, and nothing in the build
cross-checked the two lists.

This is the SEC-062 shape generalised. That one was found by asking the same question of a
hand-built string: the `redirect_uri` named `/sso/oidc/:connectionId/callback` while the route
was served at `/sso/sso/oidc/:connectionId/callback`, and enterprise login could not
complete. This one is mechanically checkable, so it is a test rather than a review someone has
to remember to do.

Each advertised path is **requested**, and the assertion is only that the request is not a
router miss — a handler may answer 400 or 401, because a route existing and refusing is the
entire point. Asserting against a hand-kept list of paths would test the list rather than the
server, and would pass against a document advertising a route that had since been renamed.

**All five endpoints are served today** (`userinfo_endpoint` is GET, per RFC 7662), so this is
a verified absence of a defect rather than a fix. Recorded so nobody has to rediscover it, and
so a rename cannot reintroduce it silently. A guard refuses any absolute-URL field the test
does not check; `issuer` is excluded **by name, with its reason**.

### SEC-071, low — a test that failed intermittently, naming a defect that did not exist

`operationalMetrics.test.ts` has a `before` hook that boots a whole Keystone application
against a Redis URL on a port nothing listens on, to observe the emergency fallback. It gave
its child process **300 seconds**. Everything around it had only the harness's global **60**.

**Measured idle cost of that hook: 37.8 seconds.** So it was running 38 seconds of work
under a 60-second budget — 1.6x, which is not a margin. The full suite runs this file with
PostgreSQL, Redis and a dozen other suites already loaded, and under that load it tipped:

```
the emergency fallback, with Redis unreachable (60009.01619ms)
  'test timed out after 60000ms'
```

followed by two siblings cancelled with *"test did not finish before its parent"*.

Read plainly, that names a defect that does not exist. **The emergency fallback is fine;
the clock ran out.** This is the mirror image of the failure this project keeps finding — a
control reporting success for the thing it exists to catch — and the same mistake underneath:
the harness is measuring elapsed time where the test is measuring behaviour. An intermittent
failure here trains people to re-run the suite, which is the outcome a gate exists to
prevent.

The hook now declares `{ timeout: 180_000 }`, and Node's runner lets a per-hook timeout
override the global one, so the budget the work is given is stated where the work is. 180s
is 5x the measured cost and stays inside the 300s the child process already has.

**Verified by running the file with `--test-timeout=20000`** — a global limit far below the
hook's own cost. It ran 37.2 seconds and passed, which is only possible if the per-hook
declaration wins. Before the change, any global limit under 38 seconds killed it and
reported the fallback as broken.

The 11 tests in that file pass at 60s too, and that is the point: the defect was not
reproducible on an idle machine, which is exactly why it survived as long as it did.

### Also

- The router-miss discriminator is now `src/tests/helpers/routerMiss.ts`, shared by both suites
  that need it. Two copies of a subtle invariant is one more thing to keep in step. It is
  deliberately loose rather than an exact match: an exact match fails *open*, and a changed
  body would stop being recognised as a miss, quietly turning dead routes into served ones.
## [3.5.9] - 2026-09-30

*The runtime moves to Node 26, and a rule about file writes turns out to have been about a folder.*

### Node 22 → 26

`.nvmrc` holds the version, all nine `setup-node` steps across six workflows read it, and
`scripts/verify-node-version.mjs` fails if the Dockerfile, `engines.node` and `.nvmrc`
disagree. So the runtime version has one home and this is a change to that one file plus
the Dockerfile the gate then holds together.

| | before | after |
|---|---|---|
| `.nvmrc` | 22 | **26** |
| `Dockerfile` | `node:22-slim` ×2 | `node:26-slim` ×2 |
| `engines.node` | `>=22` | **`>=26`** |
| `@types/node` | `^20.14.0` | `^26.6.3` |

**`engines.node` is narrowed to `>=26`, and that is a deliberate claim rather than a
side effect.** The only versions this project has run the suite against are 24 — which
3.5.8 passed 717/717 on — and 26, which this release passes 717/717 on. Node 22 was
tried: no failures, but four tests cancelled and about thirty never reached, which is not
a pass and not a basis for claiming support. Claiming `>=22` while compiling against
`@types/node@26` is the exact mismatch that made Dependabot #39 worth closing by hand —
`typecheck` would accept code that fails on the runtime we claim to support.

`engine-strict` is not set, so this is a warning at install time rather than a refusal.
The server ships in a container pinned to Node 26, so the claim and the artifact agree.

Verified by breaking each pin in turn — Dockerfile back to 22, `engines.node` to `>=27`,
and a hardcoded `node-version: 22` back into `ci.yml` — all three caught with the right
message.

#### Three type errors, and one of them was not a cast

`@types/node` 26 adds `"decapsulateBits"` and `"encapsulateBits"` to `webcrypto.KeyUsage`
for ML-KEM. The DOM `KeyUsage` — which `lib.dom.d.ts` supplies, pulled in transitively
rather than requested by `tsconfig` — does not have them, so TypeScript reports Node's
own `CryptoKeyPair` as unassignable to the ambient `CryptoKeyPair` that `@peculiar/x509`
declares. The unions differ *only* by those two members, and the test keys use
`["sign", "verify"]`, present in both, so the cast cannot change what is passed. Both
casts were reverted to confirm they are load-bearing rather than convenient.

The third error was a genuine tightening: `assert.equal`'s message is now `string`, so a
`string | undefined` body needed `?? "no /health response"` rather than `?? ""` — a
missing body is exactly the case where the message has to say something.

### SEC-069, low — the setup marker, and a rule scoped to the wrong directory

`src/routes/setup.ts` wrote the setup completion marker with
`fs.writeFile(SETUP_MARKER_PATH, …)`. `writeFile` takes a name and follows a symlink
planted at it, in the steady state, with no race involved.

It survived SEC-065 because `keystone-config-writes-by-descriptor` was scoped to
`src/services/setup/**` — **the directory that happened to hold the code being fixed.**
This call sat one file over, in `src/routes/`. A rule scoped to the folder that held the
last fix stops being about the defect and starts being about the folder, so the scope now
includes `src/routes/**`, recorded as a starting point to widen from rather than a
boundary that is correct.

**The write was extracted into `setupMarker.ts` rather than fixed in place, and that is
the part that matters.** It was three inline lines behind a route needing a database, a
Redis and a bootstrapped owner, so no test could reach it.

#### The first version of the fix worked and was still wrong

`writeSetupMarker` opened a descriptor and never closed it. All four tests passed. The
only evidence was one line on stderr between two green tests:

```
DeprecationWarning: Closing a FileHandle object on garbage collection is deprecated.
```

The marker was written correctly and the process kept a file open for every setup it
completed. That is the shape of a fix that passes — so the handle now closes in a
`finally`, and a test reads the open descriptor count from `/proc/self/fd` across 25
writes and across 25 refusals. Reverting the close makes it report
*25 marker writes grew the open descriptor count by 25*.

Also fixed while in the file: the test cleanup deleted memberships by a hardcoded nil user
id — a row that cannot exist, so a line that looked like cleanup and removed nothing while
leaning on an unverified cascade. Memberships are now deleted by organization.
## [3.5.8] - 2026-09-30

*Two findings, one shape: a control that reported something other than what it measured.*

### SEC-062, high — enterprise OIDC login could not complete

`oidcEnterpriseRoutes` is mounted at `/sso` in `src/index.ts`, and its routes also
declared `/sso/…`. So the server answered at:

```
/sso/sso/oidc/:connectionId/callback
```

while the `redirect_uri` it handed the identity provider — and the identical one the
token exchange re-sends, as RFC 6749 §4.1.3 requires — was built from a hardcoded
`${publicUrl()}/sso/oidc/${connectionId}/callback`.

Keystone asked the IdP to call back a path it did not serve. A standards-compliant IdP
redirects to exactly the `redirect_uri` it was given, so the browser landed on a
route-not-found. Whichever URL an operator had registered in their IdP — the doubled
path, because `docs/API.md` documented it, or the clean path, because that is what
`redirect_uri` carried — one leg or the other failed.

**SEC-062 was recorded as `low`, as "a doubled path". That was wrong.** It was an
availability defect in a shipped feature. The reason nobody noticed is that every
existing test drives a *piece* — userinfo endpoint resolution, nonce forwarding,
membership scoping — and none drives the flow. The parts all work; the composition did
not.

#### Fixed, with the old path kept working

Routes are now declared relative to their mount, so the served path is the one
`redirect_uri` already named. The doubled paths stay as aliases, because they are what
`docs/API.md` documented and what an operator configured in an IdP this repository
cannot see.

**The two registrations share one `callbackOptions`, and that is the part that matters.**
An alias with its own `keyPrefix` is a *second* allowance for the same endpoint — an
attacker could alternate between the two paths to double the authorization-code guesses.
Every assertion that checks each path is limited still passes with two prefixes. Only an
assertion that they are limited **together** catches it, which is why the test spends the
whole budget on the canonical path and then requires the legacy path to already be
closed.

Verified by giving the alias a second `keyPrefix`: the two other tests still pass, and
the budget test fails naming the 400 it got instead of a 429.

#### The tool stopped seeing the limiter, and nothing said so

Sharing the options object made the `rateLimit(` call invisible to
`review-api-surface.mjs`. The reported rate-limited count fell from **28 to 27** and no
gate failed — a rate limit that is present, reported as absent.

`findRoutes` captured an options object only when the argument after the path began with
`{`; a bare name yielded an empty string. A named options object is now resolved before
the guards are read, and the count is pinned by a test: **29**.

### SEC-068, low — 43 routes reported as unauthorized when the tool could not see the guard

`review-api-surface.mjs` reported **43 routes** as "authenticated, no authorization
guard", on every run. That reads as 43 unresolved problems. It is not 43 problems, and
the wording was making a statement about the tool look like a statement about the routes.

The repository authorizes in three places and the tool can see one:

| where | example | visible |
|---|---|---|
| a named preHandler | `requireOrganizationRole(["owner","admin"], …)` | yes |
| the handler body | `if (!assertSetupToken(request, reply)) return;` | yes (3.5.6) |
| **the application service** | `sdk.organization.getOrganization(userId, orgId)` → `requireOrganizationPermission(…)`, auditing the denial | **no** |

A static check cannot resolve the third case — the code performing the authorization is
the code under test.

#### Settled by trying it

`tenantIsolation.test.ts` builds two organizations with two owners plus a user belonging
to neither, and reads every organization-scoped collection route as the wrong tenant:
once as the owner of a *different* organization, once as a non-member. **12 routes**,
derived from the tool's own `--json` output so a new one cannot be added without
appearing. Every route answers 403 or 404. A fourth test asserts the owner **can** still
read their own organization, or the suite would pass just as well if every route 404'd
for everyone.

Verified by removing the permission check from `getOrganization`: 2 of 4 fail, naming
the route, the 200, and who asked. **All 12 are correctly guarded.** The 43 figure was
never a count of defects.

The category is now worded `no NAMED authorization guard found`, and the report separates
`with a NAMED guard: 104` from `authorized elsewhere: 43`. The wording itself is pinned by
a test, because no other check reads wording and a revert would have passed every gate.

### Also in this release

- `GET /v1/admin/billing/plans` carries only `app.authenticate` while its sibling
  `/organizations/:id/billing` requires an org role. Left as is, deliberately: the catalog
  is a hardcoded literal in `src/services/billing.ts`, with no tenant data, and adding a
  role check would break a pricing page for no security gain. Recorded so nobody later
  "fixes" it.
- `docs/API.md` names the canonical OIDC callback and marks the doubled paths as aliases.
## [3.5.7] - 2026-09-30

*Two alerts in the code 3.5.6 added, both found by the scanner in the same release.*

### A check-then-write in the new test, which CodeQL called `js/file-system-race`

The test that plants an unplaceable route file asked `existsSync(planted)` and then
wrote. That is a check-then-write, and CodeQL reported it on
`src/tests/security/reviewApiSurface.test.ts` — correctly, and two hours after I wrote
it.

**Fixed rather than dismissed, and the fix is smaller than the problem.** The exclusive
create *is* the assertion:

```ts
handle = openSync(planted, "wx");   // fails if a previous run left one behind
```

There is no window, and no separate statement that can disagree with the create. The
message on `EEXIST` says what to do and why it matters — a leftover means a run was
interrupted between planting and cleanup.

### A dynamic `RegExp` built from a captured name

`localGuardAliases` compiled ``new RegExp(`\\b${name}\\b`)`` per alias, and
`detect-non-literal-regexp` is right that a name taken from the source is an untrusted
pattern. The practical exposure here is nil — the name comes from this repository's own
route files, and the identifier charset cannot express a ReDoS pattern — but a rule
that fires on every run trains people to dismiss the tool, and the alternative is four
lines.

The subtle part is what *not* to write instead. `block.includes(name)` is the obvious
replacement and it is **wrong**: `requireSso` is a prefix of `requireSsoOwner`, so a
substring test would report a route as guarded by an alias it does not use. That errs
toward *fewer* findings, which is the dangerous direction — it retires a real concern
rather than adding a false one.

So the replacement checks identifier boundaries explicitly:

```ts
function containsIdentifier(text, name) {
  const isWord = (c) => /[A-Za-z0-9_$]/.test(c);
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + name.length] ?? "";
    if (!isWord(before) && !isWord(after)) return true;
  }
  return false;
}
```

This is the third time in two releases that a dynamic regex has come up in this
repository — `bump-version.mjs` in 3.5.3, `verify-action-pin-versions.mjs` in 3.5.4, and
now here — and the pattern holds each time: the regex was not solving a problem, and
the string operation is both clearer and safer.

### The break harness, reporting itself honestly

Retargeting the alias break made its pattern absent, and the harness printed
`SKIPPED (pattern absent)` rather than counting it as a pass. That is the behaviour
worth having: a break that cannot be applied is a failed experiment, and the only way
to tell it from a successful one is to check. All six apply and all six are caught:

```
the file walker mislabels nested directories     ->  5 of 10 fail
the route pattern requires two commas again      ->  3 of 10 fail
the prefix walk stops at one hop                 ->  4 of 10 fail
local guard aliases are no longer resolved       ->  3 of 10 fail
a guard in the handler body is not seen          ->  4 of 10 fail
strict mode no longer fails on an unplaced file ->  1 of 10 fail
```
## [3.5.6] - 2026-09-30

*A quarter of the API surface had never been reviewed. Fixing that found a real one.*

### SEC-064, medium, now fixed — 97 routes had never been checked

`review-api-surface.mjs` is the gate on the API surface. It reported **"79 routes across
22 files"** while the repository declares far more, and it was three separate bugs
stacked, each of which independently produced that number.

1. **The file walker mislabelled nested directories.** It recursed into `admin/` but
   built each label from the *top-level* name, so `src/routes/admin/platform.ts` was read
   as `src/routes/platform.ts` — a path that does not exist. `read()` returns `""` for a
   missing file rather than throwing, so all seven admin files reported zero routes, and
   nothing said they could not be read.
2. **The route pattern required two commas.** It matched
   `app.get(path, {opts}, handler)` and not `app.get(path, handler)` — the other
   ordinary way to write a route, and the one `admin/*.ts` uses.
3. **The prefix walk was one hop.** The admin files are reached through `routes/admin.ts`
   (a one-line barrel) and then `routes/admin/index.ts`, and `health.ts` is registered as
   `app.register(healthRoutes)` with *no options object at all*, which a pattern
   requiring `prefix:` could not match.

**The tell was a ratio above one.** "prefixes resolved: **40/31** route files" was
printed on every run and read as a quirk rather than as a contradiction. You cannot
resolve more files than exist.

**79 → 176 routes, 31/31 files placed.** The 97 that appeared have never been checked
for an authentication guard, a rate limit, or audit logging — and they include the
entire platform-owner administration surface.

Two false-positive classes surfaced with them, and both are now *derived* rather than
tabulated:

- **Local guard aliases.** `admin/sso.ts` builds
  `const requireSsoReader = requireOrganizationRole(…)` and uses the alias in every
  `preHandler`. The tool knew the defining call and not the name, and reported ten SSO
  and SCIM administration routes as unauthenticated. Tabulating three names would have
  needed editing on every rename and left a list a reader would assume was verified.
- **Guards called in the handler body.** Every `/setup` route guards with
  `if (!assertSetupToken(request, reply)) return;`, which is the right shape for a guard
  that has to answer with a body. Testing only the options object reported eleven open,
  including `/setup/init`, which creates the first owner.

A guard now counts anywhere in the route's own declaration — options or handler — which
is the same unit a reader uses.

### `--strict` could not tell a reviewed surface from an unreviewed one

Putting the walker's label back left `--strict` **passing** with seven files unplaced
and 74 routes unexamined. A strict mode that reports a clean surface over one it never
looked at is the failure this whole tool exists to prevent, one level up. It now fails
when any route file has no resolved prefix, and `--explain` prints each file's
derivation chain, because a prefix with no recorded derivation is a claim with nothing
behind it.

### SEC-067, medium — the token revocation endpoint was unauthenticated and unbounded

`POST /oauth2/revoke` had no `preHandler`, no plugin hook and no rate limit. It takes a
token from the body and revokes it by hash with no owner check, so anyone who can name a
token can invalidate it.

RFC 7009 asks for two different things here:

- **§5 — a countermeasure MUST be applied.** "Appropriate countermeasures, which should
  be in place for the token endpoint as well, MUST be applied to the revocation
  endpoint." That is a rate limit, it is cheap, and it cannot break a conforming client.
  **Done.**
- **§2.1 — client authentication.** "The client also includes its authentication
  credentials … The authorization server first validates the client credentials and then
  verifies whether the token was issued to the client making the revocation request."
  Neither is present, and the second **cannot be implemented without the first** — there
  is no client to check the token against. **Recorded, not fixed**: requiring credentials
  on a live public endpoint breaks any client not already sending them.

Severity is medium, and the harm is **denial, not disclosure**. The RFC's own analysis
says an attacker who guesses a token "could do much worse damage by using the token
elsewhere than by revoking it … No further damage is done and the guessed token is now
worthless." What stays true is that a token which *leaks* can be invalidated by anyone
who reads it. It is also not a validity oracle — §2.2 requires 200 for an invalid token.

`POST /auth/logout` was unbounded too, and is unauthenticated by design, since the caller
proves themselves by presenting the token being revoked. Limited.

### A break that did not happen, and read as a result

Verifying the new test took six cases. Five were caught on the first pass; the sixth —
restoring the two-comma route pattern — reported **"0 of 9 fail"**, which reads exactly
like a test that does not work. The substitution had silently matched nothing, and the
only reason I checked was that the number was implausible.

The honest conclusion would have been to weaken the test. Instead the harness now
asserts that each substitution **changed the file** before running anything, and the
count in its output is read from the run rather than hardcoded. All six now apply and
all six are caught:

```
the file walker mislabels nested directories   ->  5 of 10 fail
the route pattern requires two commas again    ->  3 of 10 fail
the prefix walk stops at one hop               ->  4 of 10 fail
local guard aliases are no longer resolved     ->  3 of 10 fail
a guard in the handler body is not seen        ->  4 of 10 fail
strict mode no longer fails on an unplaced file ->  1 of 10 fail
```

That last one needed a test that **plants** the condition: asserting `strictFailures` is
empty cannot show the check exists, because an empty array is what a tool with no such
check also returns on a clean tree. So the test writes a route file nothing registers,
requires strict mode to fail, and removes it in a `finally`.
## [3.5.5] - 2026-09-30

*The new pin gate had a bug in it, and the scanner found it in the same release.*

### `js/incomplete-sanitization` in the gate I wrote in 3.5.4

`verify-action-pin-versions.mjs` builds a `RegExp` from a repository name so
`--fix-annotations` can rewrite a stale annotation. The escape handled `.` and `/` and
**did not handle a backslash**, and CodeQL was right.

Not exploitable as written: a GitHub repository name is `[A-Za-z0-9._-]` and cannot
contain one. But an escape that covers the metacharacters you happen to have met is a
habit, and a habit is what turns into a real bug when the input source changes.

Fixed by escaping the full set — and by asserting the charset first, which is the
actual control and the escaping only the belt. **The first version of that assertion
was wrong in the opposite direction**: it allowed no `/` at all, so it rejected
`actions/checkout` and every other real repository.

Nothing noticed, because `--fix-annotations` only reaches the check for a pin whose
annotation is a bare major, and when this was written all fourteen were exact. The
guard was unreachable until it was needed, at which point it would have failed on
every input. Found by testing the function directly against eight names — four that
must be accepted, four that must be refused — because the end-to-end runs were all
green and all irrelevant.

```
ok       actions/checkout          refused   a\b+/b
ok       anchore/sbom-action       refused   a/b(c)
ok       a.b-c_d/e                 refused   a b/c
ok       github/codeql-action      refused   a/b|c
                                  refused   no-slash
                                  refused   a/b/c
```

A guard that cannot reject a real value is not a guard, and a guard that is never
reached proves nothing about the values it would have rejected.
## [3.5.4] - 2026-09-30

*The Dependabot queue, and the fact that most of our action pins said nothing about which release they were.*

### The dependency queue, closed

Four Dependabot PRs were open and stale, and merging them one at a time was not going
to work: this repository has no merge queue and no auto-merge, and each merge makes
the rest `BEHIND`, which invalidates their required checks. They are applied here
together, with each superseded PR listed.

| from | what | to |
|---|---|---|
| #60 | `actions/checkout` | `v4.4.0` → `v7.0.1` |
| #61 | `actions/setup-node` | `v4.4.0` → `v7.0.0` |
| #62 | `softprops/action-gh-release` | `v2.6.2` → `v3.0.3` |
| #58 | frontend patch group | `lucide-react` 1.47→1.48, `vite` 8.0→8.3, `@types/node` 26.1→26.6 |

`setup-node` v4 → v7 is three majors, so the thing to check was whether the workflows
that read `.nvmrc` still do. `verify:node` holds all nine `setup-node` steps to the
single version file and passed unchanged, and the frontend builds clean on vite 8.3.

### SEC-066, medium — nine of fourteen action pins said which *major*, not which release

`verify:action-pins` checks the **form** of a pin: a 40-character commit SHA rather
than a tag, with a version in a trailing comment. It does not check that the SHA is the
commit that version names.

So `# v4.2.2` was documentation, not a control — and worse, **nine of the fourteen
distinct pins were annotated `# v4`**, which is a *moving* major reference. Pinning
the commit while annotating `v4` gives a reader the one thing the annotation exists to
provide and then takes it away: "which release is this?" has no answer, because `v4`
is whatever `v4` points at today.

### The gate caught a wrong annotation in an already-merged change

Written, wired, and then it immediately found a real defect — **on `main`, from a PR
merged minutes earlier.**

`#71` bumped `osv-scanner-action` from `40a8940a` to `a345acff` and left the comment
saying `# v2.0.3`. The commit it actually pins is **`v2.6.0`**:

```
repos/google/osv-scanner-action/tags
  v2.6.0  a345acffa6     <- what the pin is
  v2.0.3  40a8940a65     <- what the comment says
```

So `main` was running a six-minor-versions-newer scanner while claiming to run v2.0.3.
Nothing was compromised and nothing was broken — the **commit** is the pin and the
comment is only a note — but the note was false, and the note is what a reviewer reads
when deciding whether a bump is safe. The SHA is authoritative, so the practical risk
was that someone comparing this pin against the v2.0.3 release would be comparing
against a lie.

It went unnoticed because Dependabot writes the trailing comment from the version it
*believes* it is pinning to, and nothing checked.

The fix here is one character. The durable part is the gate:

```
wrong version annotation           -> fails, "which is a different commit"
a pin changed without a --refresh  -> fails, "has no record"
the record dated a year ago        -> fails, "636 days old"
```

**And the subpath trap, demonstrated rather than described.** Querying
`repos/google/osv-scanner-action/osv-scanner-action/tags` 404s — the second segment is
a *directory inside* the repository, not the repository itself. The script asks about
`repos/google/osv-scanner-action`, which is why it found this at all; a check written
the obvious way would have reported a 404 and been read as "no tags, nothing to check".

All nine now name the release they actually name:

| action | was | is |
|---|---|---|
| `actions/dependency-review-action` | `v4` | `v4.9.0` |
| `actions/download-artifact` | `v4` | `v4.3.0` |
| `actions/upload-artifact` | `v4` | `v4.6.2` |
| `anchore/sbom-action` | `v0` | `v0.24.0` |
| `docker/build-push-action` | `v6` | `v6.19.2` |
| `docker/login-action` | `v3` | `v3.7.0` |
| `docker/metadata-action` | `v5` | `v5.10.0` |
| `docker/setup-buildx-action` | `v3` | `v3.12.0` |
| `github/codeql-action` | `v3` | `v3.38.2` |

`verify:action-pin-versions` closes it. Answering needs the GitHub API, and there are
two things about that which are easy to get wrong in a way that looks like success:

- **An annotated tag resolves to a tag object, not a commit.** `refs/tags/v3.0.3` on
  `action-gh-release` returns a SHA that is not the pinned commit, so an un-dereferenced
  check reports every annotated release as a mismatch. My first shell attempt did
  exactly this and reported **17 mismatches on a tree where nothing was wrong** — then,
  having "found" them, nearly reported a supply-chain problem.
- **A subpath action is a directory, not a repository.** `github/codeql-action/analyze`
  resolves under the repository `github/codeql-action`, and asking about the subpath
  404s, which is indistinguishable from a real failure.

So the answers are **recorded** in `scripts/action-pin-versions.json` by an explicit
`--refresh`, and the gate compares the record against the code: offline, deterministic,
fast enough to be required on every PR. The record **fails on staleness** at 90 days,
deliberately — a lockfile nobody refreshes is the same failure as a check nobody runs.

### `@types/node` 20 → 26, closed with a reason (#39)

The recorded blocker was real: `npm run typecheck` with 26 installed produces exactly
the three `KeyUsage` errors the earlier note described. But the reason not to merge is
stronger than the conflict, and it is not the conflict.

`@types/node` describes the API surface of the Node version you run, and this project
runs **Node 22**, stated in three places `verify:node` keeps in agreement:

```
.nvmrc                    22
package.json engines.node >=22
Dockerfile                FROM node:22-slim
```

`@types/node@26` describes Node 26, which is not what ships. Adopting it would mean
`npm run typecheck` accepts code written against APIs that do not exist in the runtime
the image runs — turning the typecheck from a guard into a source of false confidence.
That is worse than a green typecheck with slightly older types.

The `KeyUsage` conflict is the visible symptom: Node 26's own `KeyUsage` union added
members the global WebCrypto declarations lack, so a `CryptoKeyPair` from
`node:crypto` stopped being assignable to the one `@peculiar/x509` expects. A cast would
silence it, but the runtime object is identical and only the declarations differ — so a
cast is defensible in a test and still the wrong fix, because it papers over the
type/version mismatch rather than resolving it.

`@types/node` moves in lockstep with the Node version, in a release that also raises
`.nvmrc`, `engines.node` and the Dockerfile. The frontend is already on 26 because it
is a different package with a different toolchain, and that is not the same decision.
## [3.5.3] - 2026-09-30

*An alert that moved instead of closing, and the four line-anchoring rules that went with it.*

### The filesystem race did not close. It moved.

3.5.2 rewrote `configWriter.write` to go through a descriptor and said the two
`js/file-system-race` alerts would close. They did not — they **moved** to
`safeFile.ts`, where `openExistingOrNew` answered "did this file already exist" with
an `lstat` before opening it.

CodeQL was right about that code too. An `lstat` followed by an `open` on the same name
is a check followed by a use, which is the shape the rule reports. The probe was not the
check — the check is entirely in the open's flags — but it was still a **second
resolution of the path**, which is the exact thing `safeFile.ts` exists to remove. So
the fix was to delete the probe, not to explain it.

It was also a field nothing read. `OpenFile.existed` was consulted by exactly one thing:
the test asserting that it was correct. A field that exists in order to be asserted is
circular, and it had been given a name and a doc comment in the meantime.

Two lessons worth keeping:

- **"Will clear when it is pushed" is a prediction, and 3.5.2 got it wrong.** The
  triage recorded it that way rather than as done, which is the only reason the
  correction is visible.
- **A fix that relocates a finding has not necessarily solved it.** The alert moving
  files is what exposed the second resolution; treating "the original file is clean"
  as done would have left it.

`keystone-config-no-pre-open-lstat` now stops the probe being added back. The one
legitimate `lstat` — inside the `EEXIST` branch, called *after* the open has already
failed, to say which refusal occurred — is suppressed with a reason rather than left to
become the one finding that teaches people to ignore the rule.

### Four dynamic regexes replaced with string comparisons

`bump-version.mjs` built a `RegExp` per call from a key read out of a literal table. No
untrusted input reaches it, but a key containing `.` or `(` would have matched more than
intended, and it made a reader reason about escaping in a script whose previous version
once shipped a bug by writing the wrong thing to a manifest.

A trimmed line either starts with `key:` or it does not. That is a string comparison,
and it removes the hazard rather than escaping it:

```js
const trimmed = line.trimStart();
if (!trimmed.startsWith(`${key}:`)) return null;
```

The `YAML key ends at the colon` guard is new and worth naming: without it, `version:`
would also match `versionOverride:`. The old pattern had the same behaviour by
accident, from `\s*` after the colon; the new one has it on purpose.

Verified against the two bugs this file has already shipped — a comment naming the key
and a version stays untouched, and `keepPrefix` still keeps `ghcr.io/…/name` when
rewriting only the tag:

```
comment line untouched:       true
real image updated:           true
comment newTag untouched:     true
real newTag updated:          true
```

### And one unused import

`examples/login-form-react/backend-example.ts` had two. 3.5.1 removed `type JWTPayload`
and the alert simply moved to the next import. That is what a moving alert looks like,
and it is the second time this release has been told one by an alert that did not
disappear.

### CodeQL

**63 alerts, 0 open.** All 63 are either dismissed with a stated reason or fixed. The
last six were: one filesystem race that moved rather than closed, four dynamic regexes,
and one unused import.
## [3.5.2] - 2026-09-29

*The last two open CodeQL alerts, and the symlink the rule was not asking about.*

### SEC-065, low — the setup config writer followed a symbolic link

`EnvFileConfigWriter.write` did this:

```ts
const stats = await fs.stat(this.filePath);
if (stats && !stats.isFile()) return err(…);
…
await fs.writeFile(this.filePath, body, { mode: 0o600 });
```

Two resolutions of one name with a window between them. CodeQL flagged it twice as
`js/file-system-race`, and it was right.

**But the race is the narrow half.** `fs.writeFile` follows a symlink *by design*, so a
`.env` that is a link is not a race at all — it is the ordinary case. The writer reads
the target, merges into it, and overwrites it with mode `0600`. No timing required, and
a fix that only closed the window would have left the larger half in place. `fs.stat`
follows too, so the "is it a regular file" check was cheerfully reporting that the
*target* was a regular file.

Severity is low and deliberately not inflated: this writes inside the application
directory, and anyone who can plant a symlink there can already achieve more than one
stray write. The primitive it hands over — *write `0600` to any path this process can
write* — is the part worth closing. The JSON writer had the same shape without even the
`stat`, and both writers' `backup()` did stat-then-`copyFile`.

### One descriptor, opened once

`src/services/setup/safeFile.ts` opens each file once with `O_NOFOLLOW` and routes
every read and write through that one handle, so there is no second resolution left to
attack. `O_NOFOLLOW` is the part that removes the steady-state problem, and it is the
part a stat-then-write fix misses. Backups use `O_EXCL`, so a name that already exists
— or a link planted at the backup path — is refused rather than written through.

The merge behaviour is deliberately unchanged: `routes/config.ts` passes a **fully
merged** set because it has already applied redaction, while `routes/setup.ts` passes
only new values and relies on the writer's merge to preserve the rest of the file.
Unifying those would change what one of them writes.

### The error codes, measured

| what is at the path         | `open` with `O_NOFOLLOW` | code   |
|-----------------------------|--------------------------|--------|
| a directory                 | refused                  | EISDIR |
| a symlink (final component) | refused                  | ELOOP  |
| a symlink, with `O_EXCL`    | refused                  | EEXIST |
| a FIFO, a socket, a device  | **opens**                | —      |

The last row is why the `fstat` is not dead code. The first draft handled only the
fstat, and the directory test then failed with a bare `EISDIR` — so "the stat check
must be unreachable" was available and wrong. The FIFO case proves it is not.

Two limits, stated rather than glossed: `O_NOFOLLOW` covers the **final** component
only, so a symlink in a *parent* directory is still followed (closing that needs
`openat`, which Node does not expose); and it is `undefined` on Windows, so the flag is
omitted and the protection is genuinely gone. `symlinkProtection` reports which of the
two a caller is getting rather than implying one.

### The test that passed against the defect

The end-to-end assertion — *the symlink target's content is unchanged* — **stayed green
with `write()` reverted.** Because `write()` also called `read()` on the way through,
and `read()` is hardened too, the read refused first and the write was never reached.

A test that passes for the wrong reason is worse than a missing one, because it looks
like coverage. So the write is also tested at the descriptor with nothing in front of it,
and `keystone-config-writes-by-descriptor` in `.semgrep.yml` catches a writer that stops
using the primitive. Both verified by reverting:

```
behavioural suite, write() reverted    -> 2 of 21 fail
keystone-config-writes-by-descriptor   -> configWriter.ts:154
restored                               -> 21 of 21, 0 semgrep findings over 204 paths
```

### The bump script is not atomic, and the gate is the backstop

While preparing this release, `bump-version.mjs` left `k8s/base/kustomization.yaml` at
3.5.1 while `package.json` and `deployment.yaml` moved to 3.5.2. The cause was in the
command invoking it, not the script: a diagnostic `grep` with an invalid option died,
the pipeline closed, and the script took `SIGPIPE` mid-write.

It writes four places sequentially, so being killed between them leaves a tree that
describes two different releases. `verify:k8s` caught it immediately — which is the
gate doing precisely the job it was written for, and the reason a release process can
trust `bump` followed by `verify` rather than `bump` and hope.

No change made: making the script transactional across four files and a
`package-lock.json` is real work, and the gate already turns a silent half-release
into a loud one.

### CodeQL

**62 alerts triaged. This closes the last two.** Whether they actually close is a
prediction, not a claim — the re-analysis will say, and the triage records it that way
rather than as done.
## [3.5.1] - 2026-09-29

*The two things 3.5.0 left open, and the general gates that stop them recurring.*

### SEC-059, medium, now fixed — unauthenticated AES-256-CBC in a secrets provider

Four of the five locally-encrypting providers used AES-256-GCM. `azureKeyVault.ts`
used AES-256-**CBC**: malleable and unauthenticated, so anyone with write access to
the stored ciphertext can flip plaintext bits without the key — the position
encrypting secrets at rest exists to defend against.

3.5.0 recorded it as "not fixed, deliberately", because changing the cipher
invalidates every stored value and a secrets provider has no safe default for a
value it cannot read. That reasoning was right, so the fix is a migration:

- `src/services/secrets/cipher.ts` — one cipher, one format, in a module both the
  provider and the test import. `encryptAtRest` writes
  `aes-256-gcm$<base64url(iv || tag || ct)>`, byte-for-byte what the other three
  already used, so a ciphertext says what it is and can be migrated.
- `decryptAtRest` reads that format and rejects a tampered value, and also reads
  the pre-3.5.1 CBC form. Deleting that read path would turn a security
  improvement into an outage.
- Migration is the **existing explicit operation**,
  `npm run db:reencrypt-oidc-secrets`. A read must not silently rewrite storage, so
  it does not — the first version's comment claimed "every read writes back", which
  is not what happens and cannot.

**Two controls keep it fixed.** `keystone-secrets-aead-only` forbids a non-AEAD
`createCipheriv` anywhere under `src/services/secrets/`, and
`keystone-secrets-legacy-cbc-is-named` requires the one remaining
`createDecipheriv` to sit in a function whose *name* says it is a migration. Crude
and deliberately: `decryptLegacyCbc` tells a reader the path is temporary, and
"have we finished migrating" becomes a property of the source.

### The test that tested a copy

The first SEC-059 suite duplicated the encrypt and decrypt logic into the test
file. Reverting the provider to CBC left all nine tests green, because the tests
were not running the provider. A test of a copy cannot fail.

So the cipher is now a module, imported by both. Reverting it to unauthenticated CBC
fails 2 of 10; restoring it passes 10 of 10.

### Reading `errors` alongside `results`

The semgrep rule that keeps SEC-059 fixed returned zero findings, and zero findings
is what a rule that does not fire returns — so there was no way to tell the two
apart from the field I was reading. The rule was broken three ways:

1. **A string literal's metavariable value carries its quotes.** `^aes-\d+-cbc$`
   matches nothing; `^"aes-\d+-cbc"$` matches the literal. Established by bisection
   against a scratch file, not by assumption.
2. **YAML quoting.** The pattern contains double quotes, so it needs single quotes.
   The unquoted form parsed and did not match; the double-quoted form needed escapes
   and matched nothing.
3. **One rule was missing `languages`,** which made the *whole config* invalid, so
   semgrep scanned **zero paths** and reported zero findings.

Every one is the same failure this registry keeps finding: a control that reports
success for the thing it exists to catch. What changed the outcome was printing
`results`, `errors` and `paths.scanned` together — at which point `errors: 2` and
`paths scanned: 0` said what was wrong immediately.

`--error` does exit non-zero on a config error, so CI would have failed the job.
Only the local runs misled, and only because they printed one number.

### SEC-061, medium — eight credential-consuming routes had no rate limit

3.5.0's predecessor recorded "21 routes have no rate limit" and deliberately left
the judgement open. Making it per route corrected the number in **both**
directions.

**9 of the 21 were already limited.** CodeQL's `js/missing-rate-limiting` looks for
a `rateLimit` call in a route's own options and misses two ordinary shapes: a
limiter in a `preHandler` array on a preceding line, and a limiter behind a named
helper — `factorRateLimit("totp-verify")` is how this repository has always done it.

**8 were not, and now are:** the two federation callbacks, the enterprise SSO
callback, the magic-link verifier, the SAML start and ACS, and the two WebAuthn
authentication endpoints. Two of those were the ones worth the most attention — the
magic-link token is in the **query string**, so it is the most brute-forceable route
in the system, and the SAML ACS runs signature verification on an attacker-supplied
assertion, which is the classic DoS shape. Each is keyed on its own prefix so one
flood cannot deny service to another.

**3 stay unlimited on purpose**, and are now written down: the drop-in SDK and its
SRI hash are a static file a CDN fetches, and `/setup/init` is an operator's *first*
request to a new installation — a rate limit there can lock somebody out of their own
deploy, which is a support incident caused by a security control. An omission nobody
recorded looks exactly like an oversight.

`src/tests/security/rateLimit/unauthenticatedSurface.test.ts` drives each route past
its budget and requires a 429 with a `Retry-After`. Verified by deleting the
magic-link verifier's limiter and watching that one test fail.

**The first version of that test passed in isolation and failed with 8 errors in the
full suite** — the reverse of the usual risk, and it cost more than it should have.
`npm test` sets `LOGIN_MAX_ATTEMPTS=1000000` so the rest of the suite is not
throttled by the routes under test. Run alone, the budget defaults to 10 and 60
requests trip it easily.

So the test was measuring **the configured budget** rather than whether a limiter is
wired up, and a green run meant nothing. The budget is now forced to 5 at the top of
the file, before `config` is imported, which is the only way the assertion can mean
anything — and `node --test` runs each file in its own process, so it is contained.

Verified in **both** environments, and the break fires in both. A test that only
tells the truth in one of the two ways it can be run is a test that will lie to
whoever runs it second.

### SEC-064, medium — the API surface review skips a quarter of the route files

`review-api-surface.mjs` is the gate on the API surface. It resolves a route file's
mount prefix by matching `import <name>` against `register(<name>, { prefix })`, and
it does not follow **composition** — `admin/*.ts` are composed by `admin/index.ts` and
registered once. **8 of 25 route files have no resolved prefix and are not analysed
at all.** The tool reports 79 routes across 22 files and mentions the 8 it skipped
only in a list at the end.

A second consequence surfaced with it, and it is the more interesting one: **8 of
23 `PUBLIC_BY_DESIGN` reasons were inert** — they named route paths the server does
not serve, so `get()` returned `undefined` for the route each was written about
while the entry read as if it were doing work.

They were noticed only because adding a `preHandler` array to six routes made the
parser see them at all. `--strict` then failed and pointed at three reasons that had
never been checked. `/setup` named a path that does not exist at all: the plugin is
mounted at `/setup` and serves `/setup/status` and `/setup/init`.

The reason table is now checked in **both** directions. It already failed a route
with no reason; it now also reports a reason that matches no route, and distinguishes
**inert** (the path is in no route file) from **unverified** (the route is real, but
in a file the parser cannot place). The comparison is on trailing segments, because a
plugin's prefix is not declared in its file — `/auth/refresh` is a refresh route in a
file mounted at `/auth`.

**The unresolved-prefix gap is recorded, not fixed.** Following composition is a real
change to how routes are discovered; 8 files remain unanalysed, the tool prints them
and the count, and this says so. "Unverified" is a truthful middle state between
claiming coverage and claiming nothing.

### SEC-062, low — the enterprise SSO endpoints are at a doubled `/sso/sso/`

`oidcEnterpriseRoutes` is mounted at `/sso` and its routes also declare `/sso/`, so
the public path is `/sso/sso/oidc/:connectionId`. `docs/API.md` documents it, which
is how a mistake acquires the appearance of a decision.

Found by the rate-limit test, where the served path had to be discovered rather
than read off the route file. **Not fixed**: it is a public endpoint on a released
product, and a customer who integrated it has that URL in an IdP configuration this
repository cannot see. Adding the clean path as an alias is safe but needs care —
both registrations must share one rate-limit prefix, or the alias silently doubles
the budget.

### SEC-063, low — the same defect, in a second place, found by the general gate

`src/services/totp.ts` writes TOTP seeds as `v2.<iv>.<tag>.<ct>` with AES-256-GCM
and still reads a `v1` `iv:data` format with AES-256-CBC. Identical to SEC-059,
recorded by nobody.

Found by `scripts/verify-secrets-cipher.mjs` — the check written for SEC-059,
widened to all of `src/services/secrets/` plus `totp.ts`. That is the argument for
a general gate over a targeted fix: **a targeted fix would have been one more place
to remember.**

Not fixed, for the same reason as SEC-059 — a TOTP seed that cannot be decrypted
is a seed nobody can log in with — but now *counted* in `ALLOWED_LEGACY_READS`, so a
new legacy read fails the build and the last one going away is a visible,
deliberate change rather than something a customer discovers.

### The general gate, and the four ways it was wrong first

`verify-secrets-cipher.mjs` is a direct string check rather than a semgrep rule, and
that is deliberate. The semgrep rule kept failing in ways that all looked like
success:

1. **A string literal's metavariable value carries its quotes.** `^aes-\d+-cbc$`
   matches nothing; `^"aes-\d+-cbc"$` matches the literal. Found by bisection
   against a scratch file, not by assumption.
2. **YAML quoting.** The pattern contains double quotes, so it needs single quotes.
   The unquoted form parsed and matched nothing; the double-quoted form needed
   escapes and matched nothing.
3. **One rule was missing `languages`,** which made the *whole config* invalid, so
   semgrep scanned **zero paths** and reported zero findings.
4. **A fixture covering all seven ciphers showed the two rules contradicting each
   other** — the "never write a non-AEAD" rule fired on the legacy *read* the other
   rule exists to permit, so a correct migration could not pass both. And the
   naming rule, which was supposed to fire on an *unnamed* legacy read, fired on the
   well-named one, because semgrep has no `metavariable-pattern-not-regex` and the
   `pattern-not-inside` workaround binds its variable only inside the negative, so
   the conjunction never holds. That rule was **deleted** rather than left in place
   matching nothing.

So the naming requirement — that a legacy read live in a function whose name says it
is temporary — is enforced by a *count* instead. Counts do something the rule could
not: **removing the last legacy read becomes a visible change**, and a legacy read
that is *added* fails the build. Verified both ways.

Both breaks were planted, and both fired:

```
writes with "aes-256-cbc"                    -> fails
3 legacy decryption sites, only 2 recorded   -> fails
```

## `verify:doc-scripts` — a comment that named a script which does not exist

A comment in `azureKeyVault.ts` told a reader to run `npm run db:reencrypt-oidc`.
The real script is `db:reencrypt-oidc-secrets`, and a reader who follows the
instruction gets "Missing script" — which reads as a broken script rather than a
documentation error.

`scripts/verify-doc-scripts.mjs` checks every `npm run <name>` in the markdown
against every `package.json` in the repository. It found one on its first run, and
then reported that **17 scripts exist but are never documented** — including all six
gates 3.5.0 added. They are now in `docs/CONTRIBUTING.md`, with what each one is
for and the two habits that came out of building them.

Its first version looked only at the root `package.json` and reported
`docs/CONTRIBUTING.md` for naming `npm run test:e2e`, which **does exist** in
`frontend/package.json`, in a line that says "(from `frontend/`)". The check was
wrong, not the documentation, and a check that demands the root manifest would have
had the author rewrite a correct sentence to satisfy a linter.

### The gates, now seventeen

`verify:doc-scripts` and `verify:secrets-cipher` join the `gates` job, which is a
required check on `main`. Every gate is documented in `docs/CONTRIBUTING.md` —
which is what the new check insists on, and which it enforced by reporting 17
scripts that existed and were never mentioned.

## [3.5.0] - 2026-09-29

*Operability, and the audit's own scope. The release where the deployment turned
out to have no readiness probe at all, the most important operational signal turned
out to be silent, and 4,031 lines of published code and security controls turned
out never to have been looked at.*

### SEC-056, high — the deployment advertised a readiness probe that could not fail

**`/ready` did not exist.** The roadmap's claim that "`/health` and `/ready`
exist" was itself stale, and what the manifests did about it was the finding.

`k8s/base/deployment.yaml` pointed its `readinessProbe` at `/health` — the only
one of the two endpoints that was real. `/health` returns `{status: "ok"}`
unconditionally and touches nothing external, so a pod with no database was
reported **ready**, kept in the load balancer's rotation, and every authenticated
request it received failed. It pointed there because `/ready` had never been
written, while `README.md` documented it.

```
/health   is this process alive?       PostgreSQL down -> 200    Redis down -> 200
/ready    can it serve a request now?  PostgreSQL down -> 503    Redis down -> 200 degraded
```

`/health` must not depend on PostgreSQL either: a liveness probe that does turns a
transient blip into three failed probes and a restart, a worse outage than the one
it was reacting to. Redis alone is `degraded` and answers 200 — a pod with no
Redis falls back to the in-process queue and can still authenticate, so removing
it from the rotation would take authentication offline for a recoverable
degradation.

Both checks are real commands — `select 1` and `ping` — each bounded at 2s, run in
parallel. A status read is not enough: a pool that exists is not a database that
answers, and the shared Redis client is `lazyConnect`, so its status is `"wait"`
until some *other* code path issues a command.

### SEC-057, medium — a Redis outage made the probe unable to report the Redis outage

Both probes sat behind the **global rate limiter** — an `onRequest` hook, so before
the handler — and the limiter uses Redis. With both dependencies unreachable, over
a real socket:

```
handler's own verdict    2.0s   every call
1st HTTP response        8.1s
2nd HTTP response       20.3s
3rd HTTP response       20.4s
```

Against the manifest's `timeoutSeconds: 5` the kubelet would have recorded a
**timeout** rather than the 503, during precisely the outage the probe exists to
report. With Redis healthy the same call took **31ms**, which is what identified
the limiter. After the exemption: 576ms, 2.0s, 2.0s.

Getting there meant ruling out three candidates, and the wrong one is the lesson:
the probe's own timeout was fine (2.0s, from the per-check latencies in the body);
`ioredis` was not it (a status read instead of `ping()` still took 20s); and
`app.inject` was not it either (a real socket still took 20s). If `inject` had been
the source, the fix would have been aimed at the test and the probe would still
ship taking twenty seconds during an outage.

Two traps are recorded permanently: a cache-busting query string on an entry
module does **not** reach its dependencies, so `import("./index.js?dead=1")` got
the healthy pool and the first version of the test asserted nothing; and
`return reply;` from an async `onRequest` hook **deadlocks the request**.

### The metrics an operator needs at 3am, and the one that was silent

**The emergency local limiter engaged with no signal at all.** Both limiters run on
Redis so the budget is shared across the fleet. When Redis is unavailable the
per-endpoint ones fall back to a per-process budget and the *global* one **fails
open** — every request allowed. The `catch` in `checkLimit` returned a decision
with no counter, no log line and no event.

A counter of *refusals* would not have caught it. Under per-process limits the
refusal rate looks normal, because each instance is still enforcing a budget. What
is anomalous is the **fallback engaging**.

```
keystone_rate_limit_redis_errors_total{key_prefix="global"} 1
keystone_rate_limit_redis_errors_total{key_prefix="login"} 1
keystone_emergency_local_limiter_total{key_prefix="login",outcome="allowed"} 1
keystone_authentication_attempts_total{outcome="failure",reason="invalid_credentials"} 1
```

Also new: `keystone_authentication_attempts_total{outcome,reason}`,
`keystone_token_operations_total{operation,outcome}`,
`keystone_deliveries_total{kind,outcome}`,
`keystone_delivery_duration_seconds{kind}` and
`keystone_dependency_up{dependency}` — the last fed from the readiness report, so
the metric and the endpoint cannot disagree because they are the same call.

`outcome` and `reason` are separate labels because the question is not "are logins
failing" but "why": a spray, a broken second factor and a buggy client all read as
"logins are failing" and none of them is actionable.

`docs/dashboards/authentication.json` is **generated** and the generator fails if
a panel names a series that is not registered — a dashboard is the one artefact
here that nobody runs, so a renamed series would leave it blank at 3am. It caught
two false reports on its first run, including `keystone_dependency_up`, a series it
referenced and nothing had built.

`/metrics` was itself rate limited: one login against a dead Redis produced three
`key_prefix="global"` errors, because the two `/metrics` fetches around it counted
too. Exempted with the probes.

### The audit's own scope was an assumption

`src/`. Not stated by anyone; `packages/` and `scripts/` fell outside it because
nobody decided they should be inside.

```
packages/   1,107 lines   five packages published to npm — tokens, cookies,
                          PKCE verifiers, nonces
scripts/    2,924 lines   the security control suite: every gate here is a file
```

**The registry now covers everything the repository publishes or runs** — `src/`,
`packages/`, `scripts/`, `k8s/`, `.github/workflows/` — with three named
exclusions, each with its cost stated. `frontend/` is the honest gap: 69 `.tsx`
files that Semgrep's TypeScript support aborts on. The exclusion is `frontend/`,
**not** TSX — `packages/keystone-react/src/index.tsx` parses at 100% and is
scanned.

The scope is a field in `registry.json`, the renderer emits it, and the checker
fails if it names a tree that does not exist or an exclusion without a reason.

### 63 CodeQL alerts, not 25 — and 24 dismissed with a reason

Ten of the fourteen rules were the same false positive repeated, and 21 alerts were
one already-enumerated decision, so the grouping is the durable artifact
(`docs/security/codeql-triage.md`). Afterwards: 24 dismissed, 39 open, **and every
one of the 39 is real**.

The most instructive dismissal is `gcm-no-tag-length`: 4 **errors** demanding a
12-byte auth tag. 12 bytes is the **IV** length. NIST SP 800-38D's strongest GCM
tag is 128 bits, which is what Node defaults to and what WebCrypto mandates —
obeying the rule would have weakened all four. And while checking the question the
rule was actually asking — is the tag *verified on decrypt*? — the answer turned up
SEC-059 instead.

### SEC-058, low — the console email provider forged log entries

`ConsoleEmailProvider` printed `To:`, `Subject:` and the body on separate lines with
the values interpolated raw, so a newline in a subject or body wrote log entries of
its own. Now one JSON-encoded line.

### SEC-059, medium — one secrets provider encrypts with unauthenticated CBC

Four of the five locally-encrypting providers use AES-256-**GCM**.
`secrets/azureKeyVault.ts` uses AES-256-**CBC**, which is malleable and
unauthenticated: someone with write access to the stored ciphertext can flip
plaintext bits without the key, which is the position encrypting secrets at rest
exists to defend against. Exploitability is limited — a bit flip in a TOTP secret
does not obviously yield it — which is why this is medium.

**Not fixed, deliberately.** Changing the cipher invalidates every already-encrypted
value, and a secrets provider has no safe default for a value it cannot decrypt.
`db/reencryptOidcSecrets.ts` has the shape of the migration. Recorded so it is not
lost.

### SEC-060, low — two provably dead branches in the workflow blocked-reason chain

Dismissed in the first triage pass as "CodeQL wants a switch", which is true and
would have closed a real finding. The alert's own message is more specific: *"This
use of variable `isOutOfScope` always evaluates to false."* It is — and so does
`triggerMismatch`, because line 145 returns early when either is set. The security
behaviour was never affected; the *explanation* was, so an out-of-scope event left
no run record and no reason. Removed. Reading the rule's name and stopping there is
how a correct detector gets dismissed.

### Every action was pinned to a major version, which is not a pin

`actions/checkout@v4` looks pinned and is not: `@v4` is a mutable tag, so whoever
owns the action chooses the code that ships in a release, after the review that
approved it. All 46 are now SHA-pinned with the version in a comment, and
`verify-action-pins.mjs` fails a PR that adds an unpinned one — and fails a SHA pin
with *no* version comment, because a correct pin nobody can update on purpose is
barely better than a tag.

### The Node version was written out in ten places, and one of them did not exist

Deciding on Dependabot #34 turned up a dependency the decision could not be made
without. `benchmark.yml` already pointed `setup-node` at a **`.nvmrc` that was never
created**; the Dockerfile said 22 in two places, eight workflows said 22, and
`package.json` had no `engines` field. Merging that PR would have produced a
container on Node 26 while CI tested 22 — the mismatch that turns "the tests
passed" into "the release does not work", and the build could not see it.

Now `.nvmrc` holds the version, all nine `setup-node` steps read it, `engines.node`
is declared, and `verify-node-version.mjs` fails if any of the four disagree.
#34 is closed rather than merged: the bump is a decision with a test run behind it,
and it is now a one-file change.

Its first version had a fallback that **accepted every range it did not recognise**,
so `engines.node: ">=23"` passed for a project on 22. A permissive fallback in a
gate is worse than none — it reports the thing the gate exists to catch as fine.
`rangeAdmits` is now unit-checked against eighteen cases including `""`, `">="` and
`"nonsense"`.

### 3.3.0 and 3.4.0 were published with no changelog entry

Found by the new `verify-changelog.mjs`, which also compares against the npm
registry — the existing release check verified the changelog *ships*, and nothing
checked that it was *current*. Both entries are written, the 1.1.0–1.6.0 block is
reordered, and all 14 published versions are now represented.

### The documentation told users to import a package that did not exist

`HOW-KEYSTONE-WORKS.md` imported `@hilbras/keystone/sdk`, a subpath the published
package did not serve: there was no `exports` map and no `sdk` directory, so it did
not resolve for anyone who installed it.

`scripts/verify-doc-samples.mjs` compiles every sample in the two guides against
the real packages **and** resolves each specifier against the real `exports` map.
The second half matters more than the first: the first version aliased the subpath
in a `tsconfig`, so the compile passed and the documentation was still wrong.

### A hand-rolled YAML reader, and a gate inside it that could not fail

`scripts/verify-k8s-manifests.mjs` renders `k8s/base` and both overlays without
pulling in the kustomize binary, and fails on a readiness probe not at `/ready`, a
liveness probe not at `/health`, an image tag that is `:latest` or disagrees with
`package.json`, a container with no resource limit, a variable `config.ts` insists
on that nothing provides, and a placeholder.

Its YAML reader (`scripts/lib/yaml.mjs`) had three bugs, each making the gate
report something false. The third is the one worth naming: `containersOf` read
`spec.containers`, but a Deployment has them at `spec.template.spec.containers`, so
it returned nothing and **the entire Deployment block was dead code** — while the
gate printed

```
version: 3.4.0 (manifest image tag matches package.json)
```

with the image at `:latest`. A summary line claiming a check that had never run. It
was visible only because the summary asserted something a reader could contradict
by opening the file.

That produced `scripts/lib/patch.mjs`, which throws when a replacement matches
nothing. A `str.replace` that changes nothing is a silent no-op that looks exactly
like a success — one of these migrations reported "manifests pinned to 3.4.0" for a
pattern indented two spaces off, and it was believed.

### Changed

- **`lint` covers `packages/` and `scripts/`.** Sixteen warnings, two of them
  declaration-that-is-built-and-never-used: `verify-image-hygiene.mjs` declared
  `CREDENTIAL_FILES` and never used it, while the built-image check hardcoded a
  *smaller* set with no `.keystore` and no `.git/`; and `keystone-sdk` built a
  `fields` array and never used it. The `find` expression is now derived from the
  list.
- **semgrep covers `src packages scripts`**, and every rule in `.semgrep.yml` now
  carries a `paths` block saying where its construct can exist. Eight of twelve
  rules had no scope at all, because the scan was only ever pointed at `src/`.
  `keystone-no-console-in-server` was tried at `packages/**` (5 findings, all a
  browser library correctly reporting a failed connect) and at `src/**`
  (**151** findings, mostly `src/cli.ts`) — and does not extend, with the reason
  recorded.
- **`verify:image` now runs on pull requests.** It existed only in `release.yml`,
  which fires on a tag push, so `.dockerignore` and the build context were never
  checked on the PR that could have broken them.
- **The five SDK packages share the server's version** and declare
  `keystonePeer.server: ">=3.4.0 <3.5.0"`. They were all at `1.0.0` against a 3.4.0
  server, which is the clearest possible statement that the constraint was never
  stated anywhere. `scripts/sync-sdk-versions.mjs` keeps them together.
- **`package.json` gains an `exports` map**, which makes the documented
  `@hilbras/keystone/sdk` subpath resolve and closes the deep-import surface.
  Deep imports into a security product's internals were never supported; this
  makes that explicit rather than incidental.

### The `gates` job, which is a required check on `main`

```
lint  registry:check  verify:changelog  check:docs  reaudit:check
review-api-surface  dashboard:auth  verify:node  verify-action-pins
verify:image  verify:doc-samples  verify:sdk  verify:k8s
```

Fourteen gates, all of which run on every pull request. The three that used to
exist only in `release.yml` — and so only on a tag push — were the reason five
controls appeared to be in place and were not.

## [3.4.0] - 2026-09-28

*Behaviour. Six suites, and every one of them found something — which is not a
statistic you can plan for, it is what happens when the tests finally exercise the
code paths that were written to be exercised.*

### SEC-055, high — four defects in the CLI, and none of them reachable

`user:create` never worked. Every connection-opening CLI command hung. `secrets:rotate`
reported success while rotating nothing. `--version` printed a hardcoded `1.9.0`.

The common cause is the third one, and it is the one worth remembering:
**`withReleasedConnections` did not exist.** Nothing closed the PostgreSQL pool,
the shared Redis client, or the permission cache's own connection, so the first
command that opened a connection opened it and then waited for the process to exit
on its own. `user:create` additionally never called `loadSigningKeys()`, so it had
no key to sign with.

`secrets:rotate` with the environment provider now **fails loudly** rather than
reporting success. It cannot be idempotent — minting a key in-process would give
every instance a different one — and a rotation that silently does nothing is
worse than one that refuses. The database provider genuinely rotates, so the test
asserts the key *changes*.

11 of 21 tests fail when reverted.

### SEC-052, high — Zitadel sent no nonce, pinned no algorithm, required no claims

Three omissions in one connector, and the shape of all three is the same: a
verification step that existed and did not check anything.
`src/services/connectors/types.ts` now requires `nonce`, `algorithms` and
`requiredClaims` on an OIDC connector, so the next connector cannot be added
without them. 11 of 70 tests fail when reverted.

### SEC-051, high — the WebAuthn challenge store was a process-local `Map`

Two replicas, two stores, so a challenge minted on one pod could not be verified
on the other. Redis `GETDEL`, which is single-use by construction.
SEC-050 is the finding that found it: the stored challenge was not the returned
challenge, so **WebAuthn could never complete at all** — `@simplewebauthn`
re-encodes a string challenge, so the value in the database was not the value sent
to the browser. 12 of 17 tests fail when reverted.

### SEC-053, high — three counts, all wrong

`isFailedLoginAnomaly` recorded the failure as it read the count, so the check
raised its own threshold. The login route re-emitted an event the domain service
had already emitted. And `setTimeout(() => this.run(...))` discarded a promise, so
a job that threw took the process with it.

All three were `void`-shaped: a return value nobody read, a subscription that
fired twice, a promise nobody held. 2 of 17 tests fail when SEC-051's fix is
reverted alone.

### SEC-049 and SEC-054, medium

The email-verification token was not single-use under concurrency, and every
unmatched URL became its own Prometheus series — which is a cardinality bomb
reachable by anyone who can send a request.

### The dead counter

`keystone_failed_logins_total` was registered and never incremented, so it
exported as a series of zeros, which on a dashboard is indistinguishable from a
series that should read zero. It is now fed by an **event subscriber**, not a route
call, because `user_login_failed` is emitted from six places and a route-level
counter would have to be added to all six.

`src/tests/integration/metrics.test.ts` now asserts statically that every
registered `keystone_*` series has a call site in `src/`. A behavioural check
would only have proved which subsystems that one test happens to touch —
`keystone_cache_hits_total` is perfectly alive and no amount of logging in and out
of the server touches it. What rots is the pairing between a registered name and
the code that writes to it, and that is a property of the source.


## [3.3.0] - 2026-09-28

*Codebase shape. The release that turned two conventions into gates, and turned
one thing in the roadmap into a finding.*

### Two layering rules, and the gate that would have caught them

`AGENTS.md` said routes must not import the database client and that `src/services/domain/`
must not throw. Both were true in the document and false in the code:
`setup.ts` and `admin/platform.ts` reached past the data layer, and
`workflows.ts` did authorization by hand.

Two semgrep rules enforce them now, and they are the working pair
`keystone-route-imports-db` and `keystone-route-imports-drizzle`, with paths
anchored as `/src/routes/**`.

**`pattern-regex` was tried and rejected** for the layering rules. A check that
cannot fire looks exactly like a codebase with no violations, and both obvious
`pattern` forms for these imports quietly match nothing: `import $X from ".../db/index.js"`
does not treat `...` as a path wildcard inside the string, and
`import $X from "drizzle-orm"` does not match a *named* import list, which is how
both files actually import it. Every rule was verified against a deliberately
planted violation before being written down.

### `review:api` became a gate

It reported; it did not fail the build. It now gates the three checks that are
mechanically decidable — no authentication guard, an empty `PUBLIC_BY_DESIGN`
reason, an unresolvable guard name. The 27 routes with no authorization guard and
the 30 with no rate limit stay **reported only**, because a gate that fires on 57
routes trains people to ignore it, and a mechanical rule cannot tell a login from
a discovery document.

### `console.*`, 101 → 12

Read through the existing `request.log` / `serviceLogger` calls rather than
replaced with a blanket suppression, because the point is that a log line carries
its request id. The twelve that remain are files that legitimately log.

### A fixed regression, in the same release

The §3.2 `console.*` migration mangled three multi-line calls in
`src/services/secrets/environment.ts` into bare statements that **discarded the
JWT PEM output**. Caught before release, and it is the reason
`verify-release-metadata` now checks the tarball contents rather than trusting
that a build produced something.

### The gates moved where they run

`npm run lint`, `registry:check`, `check:docs`, `reaudit:check` and
`review-api-surface` ran only in `release.yml` — which fires only on a **tag
push**. So five gates did not run on any pull request. They now run in a new
`gates` job in `ci.yml`, which is a required status check on `main`.

That was the same defect three times over: a control that exists, and does not
cover what it is assumed to.
## [3.2.0] - 2026-09-28

*The database layer. The release the roadmap called medium-risk, and which turned
up two security findings that had nothing to do with databases.*

### Two rate limits were never running

**SEC-047 — the distributed limiter was dead on arrival.** `checkLimit` opened with
`if (!isRedisReady()) return <the local decision>`. The shared Redis client is
created with `lazyConnect`, so on a fresh process its status is `"wait"` and
`isRedisReady()` is false. The guard returned the in-process budget **without ever
issuing a command** — so the client stayed lazy, so the next request reached the
same verdict, and Redis was never reached on any request. Whether rate limiting
was shared across a fleet depended on whether something unrelated happened to touch
Redis first: the queue, anomaly detection, or — as of this release — the new
permission cache. In a deployment where nothing did, every instance limited
independently, which is the exact weakness the distributed limiter exists to
prevent. Three controls were inert: the emergency local limit on `login` and
`mfa/verify` (a brute-force budget per instance), the `scim-auth` pre-authentication
budget on `/scim/v2/*` (**nothing** — it is called with `useEmergencyLocal: false`
and so failed open on every request), and the global `onRequest` limiter (same).

Fix: attempt the command, and let a real failure select the local path. A
lazily-connecting client connects on its first command, so there is nothing to poll.

**SEC-048 — the anti-spraying budget bounded nothing.** `rateLimit()` built every
key as `prefix:identifier:body.email`, appending the submitted address whether or
not the limiter wanted it. `login-per-address` — 30 per fifteen minutes, which
exists *because* the per-account budget beside it is the wrong shape for spraying —
was therefore keyed on address **and** account. Thirty distinct accounts from one
address each got a full budget of thirty. The code, the comment beside it, and
`docs/security/rate-limiting.md` all disagreed with each other, and no test asserted
it. Key composition is now the explicit option `includeSubmittedAddress`, defaulting
to the old behaviour so no other limiter moved; both address-only budgets opt out.

Found by accident, which is worth recording: the permission cache issues a command
on the same Redis client, which connected it, which switched the limiter from
per-instance to shared — and the security suites' aggregate request count then
exceeded a budget that had never applied to them. A control that is quietly off is
invisible until something turns it on.

### Fixed

- **The SCIM group reconcile no longer costs a transaction per member.**
  `addMember` opened its own transaction and issued six statements per member, so
  a 1,000-member push was 6,010 statements. `reconcileMembers` resolves the group,
  the current members and the organization memberships once, then applies the
  whole set-difference in two statements. **70 → 15 statements at 10 members, 610 →
  15 at 100, and 15 at 1,000** — the count no longer depends on the group size.
- **A rejected reconcile now applies nothing.** The old loop inserted members one
  at a time and threw partway through, so a request refused with 404 could leave
  the first few members inserted — a state no single request described, and which a
  retry would have found already half-done. It is one transaction now.
- **The login budgets are configurable** (`LOGIN_MAX_ATTEMPTS`,
  `LOGIN_PER_ADDRESS_MAX`, `LOGIN_WINDOW_SECONDS`). They had to be: until now they
  were decorative, since raising them appeared to do nothing and lowering them broke
  nothing.

### Added

- **A Redis permission cache** for the hottest read in the system, which runs on
  every organization-scoped request. Invalidated on every write, with a 5-minute
  TTL only as a backstop.
  Deliberately **Redis-only, with no in-process fallback**: the general-purpose
  cache in `services/cache.ts` falls back to a `Map`, which is right for a rendered
  dashboard and wrong for an authorization decision, because a fallback entry has
  no invalidation path and two instances would answer differently. A revoked
  permission that survives in a cache is a security defect, not a caching trade-off.
  An empty set is never cached either, so a role granted permissions later is not
  left holding nothing until the TTL expires.
- **`src/repositories/workflow.ts`**, and `workflows.ts` behind a shared guard.
  Five handlers each wrote their own membership query against `db` and decided
  authorization for themselves; the check is now one `preHandler` and the query is
  behind a repository. The behaviour is unchanged — same 403s, same audit events —
  and it is now visible in the route table.
- **Two gates, each verified by breaking it**: `reconcileStatements.test.ts`
  (reverting to the per-member loop fails it, and the message names the counts) and
  `permissionIndex.test.ts`.

### The index migration did not happen, on purpose

§2.2 proposed indexes on `permissions` and `role_permissions`. Both already had
composite unique indexes — `(resource, action)` and `(role, permission_id)` — which
are exactly the columns the query uses. The analysis found no *other* index and
reported that as no index at all.

And at this repository's real counts (150 and 302 rows) the planner correctly picks
a sequential scan: **0.291ms, 5 buffers**. Forcing the existing indexes costs more —
**0.415ms**. The index would have been 40% slower for the same answer, plus a write
on every permission seed. So the deliverable is a gate, not a migration: it asserts
the indexes exist, asserts the catalogue is below the size at which the sequential
scan was last measured, and tells you exactly what to re-measure when it isn't.

The crossover is somewhere between 302 rows (scan wins) and 2,000 matching rows
(index wins, 5.2ms against 7.9ms). The real condition is the shape, not the number:
the catalogue is bounded by the resource:action surface, so it cannot grow with
users or organizations.

### Removed

- **`src/services/permissions.ts`**, which nothing imported. It was a second,
  drifting copy of the permission catalogue — the same 22 permissions and 3 role
  maps as `repositories/permission.ts`, able to disagree with the copy that actually
  authorizes.

## [3.1.0] - 2026-09-28

*Measure. Two things were asserted to be observability and performance work and
were neither: the OpenTelemetry dependency instrumented nothing, and the
performance claims rested on a reading of the code rather than a timing of it.*

### Added

- **Four spans on the four chokepoints** — `src/services/spans.ts`, with the span
  names as exported constants so a dashboard query and a test can share them.
  The v3.0.1 analysis found OpenTelemetry wired into the bootstrap and
  instrumenting **zero** custom spans: every trace was HTTP-and-database
  auto-instrumentation, which cannot tell a correct argon2id cost from a query in
  a loop, and cannot distinguish a replayed refresh token from an ordinary one.

  | Span | Where | What it answers |
  |---|---|---|
  | `keystone.token.issue` | `createTokenSet` — the single door every token in the system is minted through | which flow, whether MFA was required, and which factor |
  | `keystone.token.rotate` | `rotateRefreshToken`, at both decisions | whether a rotation was granted or refused, and a refusal spike is a replay spike |
  | `keystone.scim.group.reconcile` | `PUT /scim/v2/Groups/:id` | members submitted, added, removed — so a slow reconcile is attributed to group size |
  | `keystone.webhook.deliver` | `deliverNow`, on delivery, rejection and unreachable | which endpoint, which attempt, what came back |

- **A hot-path benchmark, and a nightly gate that fails on a regression against
  the recorded baseline** — `src/bench/hotPaths.ts`, `npm run bench:hot`,
  `.github/workflows/benchmark.yml`, `docs/performance/`. The gate's decision
  logic is in `src/bench/compare.ts` and is unit-tested: query count is an exact
  hard gate, timing is compared control-relatively at 40%, the tolerance comes
  from the recorded baseline rather than from the run being judged, and a
  scenario that stops being measured is itself a failure.
- **`src/db/queryCounter.ts`** — an exact count of the SQL a block of code sent.
  Timing tells you a path got slower; it does not tell you why, and on a shared
  runner a timing regression is often just a neighbour.
- **`KEYSTONE_LOG_LEVEL`** — read only by `buildApp`. The benchmark injects tens of
  thousands of requests and was spending more time serialising log lines than
  serving them, so it was measuring logging.
- **`docs/performance/README.md`** — why the numbers are in files and not in
  comments, which is a story about two unindexed tables that turned out not to
  need indexes.

### Changed

- **`createTokenSet` takes a `flow`.** A union rather than a string, so a
  misspelled flow is a compile error at the call site instead of a span attribute
  that quietly says `"unknown"` forever. All eleven internal call sites name their
  flow. The parameter is optional, because `createTokenSet` is exported and an SDK
  consumer should not have to learn a new argument to keep working.
- **`GET /scim/v2/Groups` re-reads the member list once per page instead of once
  per group** — §1.2, in the previous development cycle but recorded here because
  it is the change the benchmark now exists to protect.
- **`PUT /scim/v2/Groups/:id` reconciles by set-difference** — read the current
  members once, then add what is missing and remove what is gone, instead of
  re-reading the full member list inside the loop over submitted members. This is
  a **behaviour-preserving** change: the same memberships result.

### Fixed

- **The SCIM group reconcile no longer re-reads every member once per submitted
  member.** The old loop called `listMembers` inside the loop over `body.members`,
  which is quadratic in group size with a full table read on every iteration.
  Measured at 57× on a 1,098-group list before the change.
- **The reconcile checks organization membership for every submitted member, even
  the ones it does not need to write.** The set-difference rewrite made the check
  conditional on the member being absent from the group, which would have let a
  user removed from the organization — but still listed in a group — remain in
  it, with the reconcile reporting success. The check is unconditional; only the
  write is conditional. Covered by a new test in the SCIM isolation suite.

### Measured, and the diagnosis was half wrong

§1.4's benchmark instrumented the SQL, which corrected the roadmap in two places
that had been written before anything ran:

- The group list is **constant at 5 statements per page** — 5 at 50 groups, 5 at
  200, 10 for 1,000 (two pages, since the page cap is 500). The plan's target of
  "2 queries" was a guess. The read is already fixed; what remains is SCIM
  credential resolution.
- The reconcile is **not quadratic — it is linear with a 6× constant**, which is
  worse than it sounds. `addMember` opens a transaction per member: `BEGIN`, a
  group lookup, a membership lookup, an insert, `COMMIT`. Six statements and a
  commit per member; a 1,000-member group push is 6,010 statements. No
  individual query is slow. There are six thousand of them. §2.1 now has a real
  target instead of the guess.
- **Login is nine statements and about two seconds, and all of it is argon2id.**
  The parameters are above the OWASP minimum on purpose, and this is the number
  that says what that costs. The `keystone.token.issue` span separates the two:
  a two-second span over nine statements puts the time in the hash, not the
  database.

### The benchmark was wrong twice before it was right

Both are worth recording, because each produced a plausible result rather than an
obvious failure, and both are the sort of mistake that a gate silently inherits.

- **It measured the rate limiter instead of the login.** `POST /auth/token-login`
  allows five attempts per fifteen minutes. The sixth login from one address was
  refused — and a refusal is fast, because it never reaches the password check.
  The scenario reported 528, 495, 504, 504 and then **20ms**, and the 20ms was a
  429. Four plausible numbers in a row is what let it through. Each sample now
  uses a distinct source address.
- **It measured a refusal instead of an authorization.** `/v1/authz/check` answers
  `false` for anything the caller's role does not grant, and the scenario asked
  for a resource that is not in the permission catalogue — so the endpoint was
  correct and the benchmark was recording the cost of a denial. It now asks for
  something the role actually holds and asserts `allowed === true`, not merely a
  200. A denied answer is a valid answer, and it is a different code path.

- **It reported the fastest sample as the cost.** The usual rule is to take the
  minimum, because contention only adds time. That is true, and a 25× spread is
  not contention — it is state, and a state-dependent fast path is the one thing
  a minimum cannot tell apart from real speed. The gate now compares the median
  and records the minimum beside it, so the spread (`spread 1.1x` on a healthy
  run) stays visible.

## [3.0.1] - 2026-09-27

### Documentation

- **`docs/HOW-KEYSTONE-WORKS.md`** — a new guide covering both halves of the
  integration question: how a request actually flows through Keystone, and the
  five ways to connect a program to it, with working code in Node, Python, Go,
  Java, Ruby, .NET, PHP, Rust, Swift and Dart. It explains the things that are
  expensive to discover the hard way — that Fastify's plugin order *is* the
  security model, that refresh tokens rotate and a client which keeps the old one
  gets treated as a replay, that identifying a caller is not authorizing them,
  and how to verify a JWT without a network call.
- **The README was rebuilt as a product README.** It had grown to 34 headings,
  23 of them "What's new in vX.Y.Z" — a release-notes feed where a README belongs.
  It now carries all 20 sections the plan requires: installation, quick start,
  features, and a section per capability, with the per-version history collapsed
  to a link to the changelog.
- **`SECURITY.md` at the repository root**, so the disclosure path is where
  contributors and GitHub's Security tab look for it.
- **`docs/README.md` rebuilt as a real index**, grouped by start-here,
  integrating, reference, security, migrating and reference material.
- **`scripts/check-doc-links.mjs`**, wired into the release gate. It resolves
  every relative link in the README, `SECURITY.md`, `AGENTS.md` and `docs/`,
  including anchors. 137 links across 40 files.

### Fixed

- The generated security registry emitted documentation links relative to the
  repository root while living in `docs/security/`, so every link to a
  migration guide resolved to `docs/security/docs/...`. Four were broken; the
  generator now computes the path relative to the document itself.
- `SECURITY.md` linked to `../docs/security/` from the repository root, one level
  too high.

### Notes

The link checker found a bug in itself first: it collapsed runs of whitespace when
building anchors, so `1. Web / SPA` produced `1-web-spa` and rejected GitHub's
actual `1-web--spa`. A checker that flags valid links gets ignored, which is the
same failure mode as a security rule nobody can satisfy — so the anchor rule now
matches GitHub, and the fix was verified in all three directions: a dead file
fails, a dead anchor fails, and the double-dash anchor passes.

## [3.0.0] - 2026-09-27

### Security

- **Two registry entries withdrawn, because they were not real.** `SEC-043` and
  `SEC-044` were added during the 2.9.0 release with fixes at
  `src/services/saml/validator.ts` and `src/routes/sso.ts` — a directory that does
  not exist and a file that does not exist — and with issue descriptions the tests
  do not cover. `saml-validator.test.ts` exercises the *valid* signed-response
  path; it does not test a missing audience or issuer requirement.
  `sso-endpoint.test.ts` tests `isPrivateAddress`, a guard on operator-supplied
  endpoint addresses; it does not test an unregistered host alias. Neither had an
  evidenced defect behind it, so neither was a finding. Both are now recorded
  under `withdrawn` with the reason, and their suites under a new `coverage`
  section — a suite that asserts a property is coverage, not a vulnerability.
- **The registry validator never checked the `fix` field**, which is how the two
  above passed. It verified that the named *test* existed and that the *test* had
  a test in it; nothing confirmed the entry's claim about where the fix lives. It
  now resolves the fix site against the repository. Four entries named paths that
  do not exist; two were the invented ones, and the other two named
  `src/services/saml/*` for SAML logic that lives in `src/routes/saml.ts`. All
  four corrected.
- **Contiguity was the wrong rule for ids.** Renumbering after a withdrawal would
  change every id other documents already cite, and a registry whose ids shift is
  one nobody can reference. Ids may now gap, and a gap must be explained by a
  withdrawal carrying a reason. Set-based, not positional, so withdrawing one id
  does not invalidate the rest of the tail.

### Added

- `docs/RE-AUDIT.md` — the v3.0.0 re-audit matrix, **generated and verified**
  rather than written. Every cell is checked against the repository when the file
  is produced: `Fixed` only if the fix site exists, `Regression Test` only if the
  named file exists *and contains a test*. Deleting a test turns the cell red on
  the next run instead of leaving a stale assurance in a release document.
- `scripts/render-reaudit-matrix.mjs`, wired into `npm run reaudit:check`, the
  test suite, and the release gate. `npm run reaudit:render` regenerates it.
- `coverage` and `withdrawn` sections in the registry, so a suite with no finding
  behind it is recorded honestly and a removed finding is explained.

### Verified

- **Multi-tenant isolation, re-audited.** Every organization-scoped admin route
  was checked for a membership guard in the requested organization rather than
  the caller's own. `requireOrganizationRole` resolves `orgId` from
  `request.params.id` and checks membership in *that* organization, so the pattern
  is sound. Routes using only `app.authenticate` were traced into the
  application layer: `GET /organizations/:id` calls `getOrganization`, which
  enforces `requireOrganizationPermission` before returning. SAML and OIDC
  connection routes use org-scoped repository methods (`listByOrgId`,
  `findByIdAndOrgId`) rather than bare id lookups. No cross-tenant path found.

### Gate results

| Gate | Result |
| --- | --- |
| `npm run lint` | 0 warnings, 0 errors |
| `npm run typecheck` | pass |
| `npm run registry:check` | 44 entries, 18 suites, 12 of 12 attack classes |
| `npm run reaudit:check` | 18 plan findings, every claim verified |
| `npm test` | 450 pass, 1 skipped, 0 fail |
| `npm run test:security` | 402/402 |

## [2.9.0] - 2026-09-27

### Security

- **The security regression registry is now machine-enforced.** All 46 findings
  from the hardening programme are recorded in `docs/security/registry.json` with
  the issue, the fix, the test that fails without it, the documentation and the
  release. `npm run registry:check` fails when an entry names a test that does not
  exist, when a security suite is claimed by no entry, or when a mandatory attack
  class is uncovered. The registry is generated into
  `docs/security/registry.md` so the prose cannot drift from the data.

  This matters because a registry that is allowed to become false is worse than no
  registry: it converts "I don't know whether this is covered" into "yes,
  covered". Four of the 44 entries exist because an event, a test or a rule was
  present but never actually exercised.

- **48 security tests were not running, and the run reported success.**
  `node --test` expands `**` as a single directory level rather than as globstar,
  so the discovery patterns stopped matching as soon as the security suites gained
  a directory level. The entire authorization suite dropped out; everything that
  remained passed, so the job went green. There is now one pattern per directory
  depth, spelled out, with no overlap between them.

- **A deleted security test would have kept running.** `tsc` does not remove
  output for sources that are renamed or deleted, so a moved suite ran twice under
  two paths and a deleted suite continued to pass in CI. The build now cleans
  `dist` first.

- **Secret scanning added over the full history.** Gitleaks, on push and pull
  request, scanning every commit rather than the tip. The repository history is
  clean — no npm token, no signing key, no private key. A deliberately planted
  private key under `src/tests/` is still caught, so the test-fixture allowlist
  does not become a hole.

- **CodeQL added** for JavaScript/TypeScript and Actions, on push, pull request
  and weekly, failing on `error` severity.

- **8 project-specific Semgrep rules**, each mapped to a registry entry. They
  encode defects this codebase actually shipped, including two that are ordering
  and completeness problems no general rule can see: `requireHumanPrincipal`
  placed before `app.authenticate` sees no service account and permits everything,
  and a secret-denylist where an allowlist is the only correct shape. Each rule
  was verified to fire on a deliberately vulnerable fixture and to stay silent on
  the real backend.

### Added

- `docs/security/registry.json` — 44 findings, machine-readable and enforced.
- `docs/security/registry.md` — generated from the above.
- `docs/security/registry-exceptions.md` — the only place a release gate may be
  waived, and an entry without an expiry does not count.
- `docs/security/{rate-limiting,scopes,configuration,audit,supply-chain}.md`.
- `scripts/verify-security-registry.mjs` and `scripts/render-security-registry.mjs`.
- `src/tests/helpers/paths.ts` — resolves paths from the nearest `package.json`,
  so a suite can be moved without its paths silently breaking.
- `src/tests/security/registry.test.ts` — the registry check runs as part of
  `npm test`, not only at release time.
- `src/tests/security/authentication/login-abuse.test.ts` — 7 tests for 2.8.0
  behaviour that shipped untested.
- `src/tests/security/audit-export.test.ts` — 5 tests for the CSV export.
- `src/tests/security/service-accounts/audit-attribution.test.ts` — 5 tests for
  audit attribution of a machine principal.
- `.github/workflows/{codeql,sast}.yml`, `.semgrep.yml`, `.gitleaks.toml`.
- 7 release-gate steps in `release.yml`, replacing a single audit call.

### Fixed

- `mfa.test.ts` now connects Redis, so it exercises the rate limiter rather than
  passing because the limiter failed open. (Shipped in 2.8.0; the connection is
  what makes the suite meaningful.)

### Testing

`npm test` and `npm run test:security` are unchanged in count where the change was
organisational, which is the point: 430 tests before the restructure, 430 after,
381 security tests before, 381 after. The 7 new authentication tests are on top.

### Fixed

- **The audit log export did not neutralise spreadsheet formula injection.** The
  CSV export quoted a value containing a delimiter or a quote, but a value whose
  first character is `=`, `+`, `-` or `@` is evaluated as a formula by Excel,
  LibreOffice and Google Sheets when the file is opened. Several exported columns
  are attacker-supplied — the user agent above all — and an audit export is
  precisely the file an operator opens in a spreadsheet, so that is the expected
  consumer rather than an edge case. A `User-Agent` of `=cmd|'/c calc'!A1`
  reached the export intact. A leading apostrophe is now applied before quoting,
  and a value with no formula prefix is left untouched. (SEC-045)

  It came out of triaging Semgrep's advisory findings. The rule that pointed at
  the code, `direct-response-write`, is a false positive — the content type is set
  explicitly and every field is escaped — but the code it flagged was not sound.
- **Every service-account request produced no audit record at all.** A machine
  principal carries a sentinel id of `sa:<uuid>` so that routes expecting
  `request.user` keep working without a matching user row. The audit subscriber
  passed that sentinel into `audit_log.user_id`, which is a uuid column. Postgres
  rejected the insert, the subscriber's `catch` logged `failed to write event`, and
  the record was lost. The request succeeded, so nothing failed visibly, and a
  missing audit record is indistinguishable from a request that never happened.

  So every request authenticated by an API key or an mTLS service account left no
  audit trail. The privileged, non-human path was the one that was invisible,
  which is the wrong direction for that gap to point. The sentinel is now stripped,
  `user_id` is left null, and the service account is recorded in
  `metadata.serviceAccountId`. (SEC-046)

  It surfaced in CI and not locally: a new test's fixture passed on this machine
  and failed in CI, and the reason was visible in the log above the failure.

### Fixed

- **The published package could not be imported.** `dist/index.js` and
  `dist/index.d.ts` shipped with no `main` and no `types`, so
  `import "@hilbras/keystone"` did not resolve. The `bin` worked, so the CLI was
  usable and the library surface was not — and nothing failed, which is why it
  went unnoticed. `main` and `types` are now declared. Deliberately *not* `exports`:
  that would be the more complete fix but is a breaking change for anyone
  deep-importing `dist/` paths, and 2.6.0 is already published.
- **The migration guides did not ship.** `docs/` was never in `files`, so the
  instructions for the breaking changes in 2.4.0, 2.6.0 and 2.7.0 were reachable
  only on GitHub. Someone upgrading via npm received the changelog but not the
  document it referred to.
- **`npm run verify:release` had a gap that allowed both.** It checked version,
  license and repository, and a package with no entry point and no documentation
  passed. It now also requires `main`/`types` to exist on disk, requires the
  migration docs in `files`, requires `dist/tests` to stay excluded, and refuses
  to publish credential material. Verified by reverting: each of the three
  defects is caught with a message naming the problem.

### Known limitations

- The Semgrep scan covers the backend. Semgrep's TypeScript support fails on a
  `.tsx` file in the frontend dashboard (TSX generics versus JSX ambiguity) and
  aborts the whole scan rather than skipping one file, so the frontend is not
  scanned. This is a tool limitation, recorded rather than papered over.
- The `keystone-cookie-without-secure` rule stays silent when a cookie's options
  are spread from another variable, because the rule cannot substantiate a finding
  there. `auth.ts` builds its options in a helper and spreads them.
- The Semgrep community rulesets (`p/default`, `p/security-audit`,
  `p/owasp-top-ten`) run **advisory**, not blocking. Their 15 findings against
  `src/` have been triaged: four are `escapeXml` output the rule cannot see
  through, six are `console.*` log-forging at worst, four are AES-GCM where Node
  enforces the tag length through `setAuthTag`, and one was the `direct-response-write`
  false positive that led to SEC-045. Gating on a community ruleset nobody has
  worked through means either a permanently red build or a gate that gets switched
  off, so they report and the triage is recorded here instead. The project ruleset
  in `.semgrep.yml` is the blocking gate.
- Two suites span two domains rather than being split: `proxy/trust-boundary.test.ts`
  also covers mTLS certificate binding, and `oauth/oauth2-hardening.test.ts` also
  covers OIDC ID token verification. Splitting them is mechanical but every split
  copies the whole import header into each partition, and the resulting churn
  risks removing a live import. The registry records the mapping instead.

## [2.8.0] - 2026-09-27

### Security

- **A Redis outage removed rate limiting entirely.** Every limiter checked
  `isRedisReady()` and returned `true` when Redis was down. During an outage
  `login`, `mfa/verify`, `sms-otp/verify` and the OAuth token exchange had no limit
  at all — and an outage is exactly when unlimited attempts are worth having,
  because it is the moment an attacker cannot be traced to a single event stream.
  Sensitive endpoints now fall back to a bounded in-process budget. The fallback
  is strictly weaker: a client gets one budget per instance. That is a
  degradation worth having; unbounded is not. The store is capped, because an
  unbounded map keyed by client address is itself a denial-of-service vector.
- **MFA verification shared one budget across all users behind an address.** The
  key was `mfa-verify:<address>:<body.email>`, and that endpoint does not carry
  an email, so every second-factor verification from one address drew on the same
  budget of 20. An attacker got 20 guesses; so did an office behind a single NAT,
  where one busy office could lock out every legitimate second-factor login. The
  key now includes the challenge, which identifies one login attempt, giving an
  attacker 20 guesses at the code they are actually attacking without spending
  anyone else's budget.
- **Second-factor management shared one budget per address.** The TOTP routes
  allowed 10 attempts keyed on the address alone, with the same consequence.
  Brute-forcing a TOTP code is per-account, since the code is checked against one
  user's secret, so the budget is now keyed on the user.
- **Credential spraying was unbounded.** The login budget was keyed on address
  *and* submitted address, so it stopped repeated guesses at one account and did
  nothing about an attacker who varied the address on every request and guessed
  across a thousand accounts from one host. A second, address-keyed budget bounds
  that independently.
- **A refused request left no record.** A rate-limit trip produced a `429` and
  nothing else, so sustained guessing at `login` or `mfa/verify` was invisible
  except in aggregate. `rate_limit_triggered` now records the endpoint, the client
  address, and **which limiter decided** — a degraded in-process control is a
  different operational situation from a healthy distributed one, and conflating
  them would hide it.
- **Failed logins were never audited.** `user_login_failed` existed in the event
  vocabulary and was never emitted, on either `/login` or `/token-login`.
- **A replayed refresh token was indistinguishable from an unknown one.** It is now
  detected, emits `refresh_token_replayed`, and revokes the account's remaining
  credentials — a replay means the token is known to somebody else, so answering
  only that one request leaves the rest of what it could mint intact.
- **API key creation had no rate limit.** Minting a credential is an
  authentication event and is now bounded.

### Already sound, verified rather than assumed

`X-Forwarded-For` handling, the trusted-proxy model, and the address-based rate
limit keys were delivered in v2.0.0. Item 3 of this phase is therefore
verification rather than new work: a spoofed header from an untrusted peer, a
multi-entry header, `x-real-ip`, `Forwarded`, IPv4, IPv6, and both spellings of
IPv4-mapped IPv6 are now covered by tests.

### Added

- `src/services/localRateLimit.ts` — the in-process fallback, bounded and swept.
- `refresh_token_state` inspection, distinguishing a spent token from an unknown
  one.
- 16 tests: the emergency limiter's accounting, bounding and eviction behaviour;
  proxy spoofing across IPv4, IPv6, mapped IPv6, and multi-entry headers; an
  enumeration check that every sensitive limiter carries the emergency flag,
  including the ones built by a factory; and the abuse event payloads.

### A test suite that was not testing what it appeared to

`mfa.test.ts` never connected Redis. The shared client is created with
`lazyConnect`, so every rate limit in that suite was evaluated against a limiter
that was not running, and the suite passed **only because the limiter failed
open** — the behaviour this phase removes. It now connects Redis explicitly, and
surfaced two real keying defects that had been hidden by fail-open. Fixing those
took the suite from 12 failures to 55/55.

## [2.7.0] - 2026-09-27

### Security

- **The admin configuration endpoint leaked secrets it did not recognise.**
  Redaction was a denylist: a set of known-sensitive names plus a regex. Run
  against 24 secret-looking key names it missed 12, among them `SIGNING_KEY`,
  `JWT_SIGNING_KEY`, `SENDGRID_KEY`, `PROVIDER_APIKEY`, `SAML_CERT`, `TLS_KEY`,
  `CERT_PRIVATE`, `HMAC_KEY`, `KMS_KEY` and `DB_URL`. The endpoint returned their
  values in the clear to an owner-authenticated caller. A denylist is a losing
  game here: the next person to add a secret-bearing variable leaks it and
  nothing fails. Redaction is now an **allowlist**, so a key is private until
  someone deliberately decides otherwise.
- **CORS allowed every origin when `ALLOWED_ORIGINS` was empty.** The origin
  callback returned true for an empty allowlist, so an unset variable was
  equivalent to "permit every origin" on a server that sends credentialed
  cookies. It now fails closed and logs a warning at boot, so a misconfiguration
  is visible before a browser is turned away rather than after.
- **The setup server reflected any origin with credentials.** It creates the owner
  account and writes configuration, and was registered with `origin: true`. Any
  page a browser visited could attempt a credentialed request against the
  bootstrap surface. Origins must now be listed, defaulting to its own loopback
  addresses.
- **The setup token was written to stdout in cleartext.** It appeared in
  container logs, in journald, and in whatever ships logs off the host, where it
  remains readable long after the bootstrap it was for. It is a full
  account-initialisation credential. It is now printed only on an explicit
  `KEYSTONE_PRINT_SETUP_TOKEN=true`, and never in production. The rejection path
  also no longer logs the presented and expected token lengths, which disclosed
  the length of the expected token.
- **Webhook signing secrets were stored in plaintext.** A database dump yielded a
  working signing key for every endpoint, letting an attacker forge deliveries
  that the receiving service would accept as genuine. They are now encrypted with
  AES-256-GCM under the existing key. **Encrypted rather than hashed**, because
  Keystone signs outbound payloads with the secret and therefore has to be able
  to recover it; hashing would make signing impossible. Rows written before this
  change are read unchanged, and re-saving or rotating an endpoint upgrades them.
- **Session cookies were not `Secure` by default in production.** The default was
  `false`, so an operator who did not set `COOKIE_SECURE` received cookies that
  would be sent over plain HTTP. Production now defaults to `true`; development
  still defaults to `false` and either can be set explicitly.
- **The setup server bound to all interfaces.** It inherited `HOST`, which
  defaults to `0.0.0.0` — correct for the main server and wrong for the one that
  creates the owner account. It now defaults to loopback, honours a private
  interface, and warns if explicitly told to bind to everything.

### Changed

- CORS policy extracted to `isOriginAllowed` in `src/services/trustedProxies.ts`,
  shared by the main and setup servers.
- `EXPOSABLE_CONFIG_KEYS` is the allowlist. `isSensitiveConfigurationKey` is
  retained for the write path, where a client may legitimately send a value that
  must be recognised as "preserve this, do not overwrite it".

### Added

- 27 tests: configuration redaction against the 12 previously-leaked names, the
  setup token's logging behaviour in all three modes, webhook secret encryption
  including the legacy plaintext read path and signature stability, the CORS
  policy, and the production deployment defaults.

## [2.6.0] - 2026-09-27

### Security

- **The API key scope guard had a bypass by construction.** It read
  `scopes.includes(scope) || scopes.includes("service_account")`, so a key whose
  scope list contained the literal string `"service_account"` satisfied *every*
  scope requirement. That string was client-suppliable: `POST /api-keys` stored
  whatever `scopes` it was given, with no validation against any list.
- **The same guard also failed open.** It returned early whenever
  `apiKeyScopes` was absent, which is indistinguishable from "this is a session".
  A key that resolved without a scope list therefore skipped the check entirely.
- **The guard was never referenced.** `requireScopes` was defined and decorated
  onto the Fastify instance, but no route in the repository used it. Scopes were
  stored, returned to callers, and enforced nowhere.

### How exploitable this actually was

Stated precisely, because it matters for prioritising: `app.authenticate` is
JWT-only and returns 401 for anything that is not a valid access token.
`authenticateOrApiKey` is the handler with the API key path, and before this
release exactly one route used it — `GET /auth/validate`. A leaked API key
therefore reached one endpoint, which returns the caller's own public profile.

So the exposure was a credential whose stated limits were fiction, on a
credential that could be used almost nowhere. That is a real defect and worth
fixing, but it is not an authentication bypass, and describing it as one would
mislead anyone deciding what to do first.

### Changed

- `src/services/scopes.ts` — a scope registry: the canonical names, their
  descriptions, per-principal defaults, validation, and the allow-list grant
  check. A scope that is not defined cannot be granted.
- Unknown or forbidden scopes are refused at key creation with a `400` naming
  what was rejected and what is allowed, instead of being stored verbatim.
- `requireScopes` now fails closed, keyed off a new `request.apiKeyId` that is
  set only when a machine credential authenticated the request. A session is
  still exempt, since it carries a person's authority and is governed by the
  permission system.
- Applied to the routes where a credential's limits matter most: API key
  creation, listing and revocation, session listing and revocation, and profile
  read and write.
- `profile:read`, `profile:write`, and `mfa:manage` are human-only. A service
  account's profile is a synthesized object with an id of `sa:<uuid>` that
  matches no user row, so the scope is meaningless for a machine and misleading
  in an audit log.
- A service account's default grant is now `organizations:read` only. A personal
  key's default is read-only on the caller's own resources; the previous
  `api:read` default was not in any registry, which is a fair indication that
  nothing was checking it.

### Added

- `src/plugins/machinePrincipal.ts` — `requireHumanPrincipal`, refusing a service
  account on TOTP, WebAuthn, SMS OTP, identity linking, OAuth consent, and
  userinfo routes with an explicit `403` and an audit record. This is a backstop
  rather than a fix for a live hole: those routes are JWT-only today, so a
  machine credential is refused with a 401 before the guard is reached. It exists
  so that switching a route to `authenticateOrApiKey` does not silently make a
  machine principal acceptable somewhere a person was assumed.
- 25 tests covering the registry, validation, intersection, the grant check, the
  fail-closed behaviour, HTTP enforcement on the one key-reachable route, and
  the machine-principal boundary.

### Fixed

- Scope enforcement is keyed on `apiKeyId` rather than the presence of a scope
  list, closing the fail-open path.
- The `service_account` wildcard no longer grants anything.
- Scope ordering is normalised, so two equivalent requests produce identical
  rows.

## [2.5.0] - 2026-09-27

### Security

- **The OIDC nonce never reached the Google connector.**
  `GoogleConnector.exchangeCode` overrode the base method and called
  `super.exchangeCode(code, redirectUri)` without forwarding its options, so the
  nonce added in 2.4.0 was discarded. Every other OIDC provider validated the
  nonce; Google — the default, and therefore the most likely to be deployed — did
  not. An ID token minted for a different user or session would have been
  accepted on that path.
- **The unsigned SAML `Issuer` was never validated.** The response-level
  `<saml:Issuer>` sits outside both signed regions, so rewriting it does not
  invalidate the signature, and neither samlify nor Keystone compared it to the
  registered IdP. SAML 2.0 §2.5.1.5 requires a relying party to verify an
  unsigned issuer against trusted metadata. An assertion could claim to have been
  issued by a different identity provider. The assertion's own issuer is inside
  the signed region and was always covered; this closes the element the signature
  cannot.

### Fixed

- `verifyRelayState` returned by throwing on a missing or non-string signature,
  turning a malformed RelayState — a bad request an attacker fully controls —
  into a 500 rather than a 400. It now returns false for anything malformed.
- A missing `userinfoEndpoint` was passed to the fetcher behind a non-null
  assertion, producing `userinfoEndpoint must be a valid URL` for a URL that was
  never configured. It is now reported as unconfigured so enrichment is skipped.

### Added

- 24 adversarial SAML tests covering tampered signatures, untrusted signing keys,
  rotated-out certificates, unsigned assertions, XML signature wrapping, issuer
  and audience substitution, destination and recipient prefix / superstring / case
  variants, expired assertions, `NotBefore` violations, `InResponseTo` mismatch,
  transaction replay, and five RelayState tampering scenarios.
- 10 tests for OIDC userinfo endpoint resolution, Google nonce forwarding, and
  organization-scoped membership.
- `docs/security/enterprise-sso.md` — SAML and OIDC setup, every check applied to
  an assertion or ID token, certificate rotation, endpoint SSRF policy,
  organization scoping, and recommendations.

### Already sound, verified rather than assumed

Membership is keyed on `(orgId, userId)` throughout, with a unique constraint on
that pair and provisioning via `ON CONFLICT DO NOTHING` — so two simultaneous
logins cannot create duplicate memberships. SAML connections are resolved by
`(connectionId, orgId)`, the transaction is consumed atomically for replay
protection, RelayState is HMAC-signed and bound to a browser nonce compared in
constant time, and assertions and messages are both required to be signed. A test
now pins the membership behaviour rather than leaving it to inspection.

## [2.4.0] - 2026-09-27

### Security

- **The `authorization_code` grant did not authenticate the client.** It looked
  the application up by `client_id` and went straight to redeeming the code,
  never calling `verifyClientSecret`. RFC 6749 §3.2.1 requires a confidential
  client to authenticate at the token endpoint. The code and its PKCE verifier
  were the only factors, so an intercepted code was redeemable by whoever
  intercepted it. Confidential clients must now present `client_secret`; public
  clients are exempt because they have none, and PKCE is what authenticates them.
- **Redirect URIs accepted script-bearing schemes.** Registration validated with
  `z.string().url()`, which accepts anything the URL parser accepts — verified to
  include `javascript:alert(1)` and
  `data:text/html,<script>alert(1)</script>`. A redirect URI becomes a `Location`
  header that the identity provider itself emits, so an organization admin could
  register one and hand any user who authorized their application a redirect
  toward script execution on the auth domain. Browser policy against top-level
  `javascript:` navigation limits the practical impact, but on an identity
  provider this is not an acceptable input. Registration now also rejects
  wildcards, fragments, embedded credentials, and plaintext HTTP to non-loopback
  hosts. A test records that `z.string().url()` accepted each of these.
- **OIDC federation sent no nonce and verified none.** `state` proved the callback
  belonged to a login this browser started, but nothing bound the returned ID
  token to that login. Any ID token the provider considered valid was accepted,
  including one minted for a different user or session. A nonce is now generated
  per authorization request, kept in an httpOnly cookie, sent to the provider, and
  required to match.
- **ID token verification inferred rather than required.** Algorithms are now
  pinned to RS256/ES256/PS256 instead of being derived from the key material, and
  `exp`, `iat`, `iss`, `aud`, `sub` are required rather than validated only when
  present — a token with no expiry was previously accepted indefinitely.

### Changed

- **Effective scopes are intersected, not trusted.** The client's `scope`
  parameter was stored verbatim, with consent as the only filter. The effective
  set is now registered ∩ requested ∩ consented, and a scope outside the
  registration is refused with `invalid_scope` rather than silently dropped, so a
  client asking for authority it was never granted is visible instead of quietly
  downgraded. An empty `allowed_scopes` preserves existing behaviour.
- **Public clients.** A `client_type` column distinguishes `confidential` from
  `public`; a public client is issued no secret rather than a secret it is
  expected to ignore, and a check constraint keeps the two halves consistent.
  `client_secret_hash` is now nullable. PKCE is mandatory for a secretless client
  at both `/authorize` and `/token`; the `verifyPKCE` branch that returned true
  when no challenge was registered is gone.
- **Redirect URIs are compared with one shared helper** at registration and at
  use, so the two cannot drift. Exact string comparison throughout — no prefix
  matching, no normalization, no case folding. The token endpoint's dead
  `redirect_uri IS NULL` tolerance was removed: `redirect_uri` is required at
  `/authorize`, so the branch was unreachable, and it would have accepted any
  redirect URI had the field ever become optional.
- **Refresh tokens carry the granted scope set** in a new `scopes` column, so the
  authorization context survives rotation instead of being dropped at the first
  refresh. A refresh may narrow the grant but never widen it.
- **PKCE comparison is constant-time**, so a verifier cannot be recovered byte by
  byte.

### Already sound, verified rather than assumed

Authorization code consumption was already atomic — a conditional `UPDATE` with
`used_at IS NULL` and a required returned row — and is now covered by a
concurrency test (20 parallel redemptions, exactly one winner). PKCE was already
required at `/authorize` by the request schema, so the dead branch in
`verifyPKCE` was a latent weakness rather than a live bypass. The refresh grant
already validated client binding, MFA context, and organization membership.

### Added

- 42 tests: redirect URI registration and exact matching, PKCE verification,
  scope intersection, client authentication at the token endpoint, public client
  invariants, atomic code consumption, ID token verification against a locally
  signed key (missing / wrong / replayed / expired nonce, no-expiry, wrong issuer,
  wrong audience, foreign signing key), and scope preservation across rotation.

## [2.3.0] - 2026-09-27

### Security

**Completing a password reset did not remove existing access.** It changed the
password and left every session, every refresh token, and every other
outstanding reset token working. A password reset is the standard response to a
suspected compromise, so the previous behaviour defeated its own purpose: an
attacker who triggered the reset kept their session and kept their access, while
the victim believed they had locked the intruder out.

- A successful reset now invalidates all sessions, all refresh tokens, and all
  outstanding recovery credentials for the account.
- Reset tokens issued alongside the one used are now spent, so a reset email
  captured earlier cannot be completed after the user has already recovered.
- Revocation is centralized in `src/services/sessionRevocation.ts`
  (`revokeUserSessions`, `revokeRefreshTokens`,
  `revokeAuthenticationSessions`, `revokeRecoveryCredentials`). It was
  previously open-coded at each call site, which is how the most important site
  came to omit it. The MFA-enablement path now routes through the same function,
  so the rule cannot drift between the two.
- Revocation is scoped to one user, is idempotent, and honours an exclusion for
  a change the user makes to their own account.

API keys are deliberately **not** revoked by a password reset. They are
separately issued, long-lived credentials belonging to integrations rather than
to the person, and killing them silently breaks deployments. The residual gap is
real — a key minted by an attacker who already held the password survives — and
key expiry and rotation is the right answer rather than coupling key lifetime to
a human's password.

### Already sound, verified rather than assumed

- Recovery credentials are 384-bit `crypto.randomBytes`, stored only as a SHA-256
  digest, single-use (since 2.2.0), valid for one hour, rate-limited to 5 per 15
  minutes, and audited.
- `POST /auth/forgot-password` returns `{ success: true }` on both the found and
  not-found paths, so the response does not disclose whether an account exists.
  (A residual timing difference remains, since the found path sends mail.)

### Added

- 9 tests, including that an attacker's session and refresh token do not survive
  a reset, that an intercepted earlier reset token is dead, that a bystander's
  credentials are untouched, and that the recovered user can still log in.

## [2.2.0] - 2026-09-26

### Security

Three single-use credentials were validated with a conditional `SELECT` and then
marked used with an **unconditional** `UPDATE`:

```text
SELECT ... WHERE used_at IS NULL      <- conditional
if (!row) return
UPDATE ... SET used_at = now()        <- UNCONDITIONAL: the race
```

Between those two statements, any number of concurrent requests pass the same
check. Every one of them then succeeds.

- **Magic links** could be redeemed by any number of parallel requests, each
  producing a full login. A link that was meant to be usable once was usable
  indefinitely under concurrency.
- **Password reset tokens** could be spent by parallel requests, each writing a
  different password, last writer winning. This was the most consequential of
  the three: whoever won the race held the account, and an attacker racing the
  legitimate user could take it over.
- **SMS OTP codes** could be verified more than once concurrently, so a
  six-digit code was not single-use.

The fix is to make the write the gate rather than a follow-up:

```text
UPDATE ... SET used_at = now()
WHERE token_hash = ? AND expires_at > now() AND used_at IS NULL
RETURNING ...
```

PostgreSQL evaluates that predicate while holding a row lock, so exactly one
transaction updates the row and observes a returned row. The claim and the
validation become one statement with no window between them.

The four other single-use credentials in scope were already atomic and were
verified rather than assumed: refresh token rotation, MFA challenges, OAuth2
authorization codes, and TOTP backup codes all perform a conditional update and
require a returned row.

### Added

- `src/services/singleUse.ts` — one atomic claim and refusal-classification
  primitive, used by all three credentials. Consumption now lives in one place,
  so a credential cannot drift back into a hand-rolled read-then-write.
- Replay detection. A credential presented after it was already spent now emits
  `magic_link_replayed`, `sms_otp_replayed`, or
  `password_reset_token_replayed`, all of which reach the audit log through the
  event bus. Previously a replay was indistinguishable from a typo, so a leaked
  token returning was invisible to an operator. An **expired** credential is
  deliberately not reported as a replay, because that is not a leak.
- 25 tests, including the plan's 10 / 50 / 100 concurrent-request levels against
  every affected credential, and the same levels through the service entry points
  a route actually calls.

### Changed

- `resetPasswordWithToken` now spends the token before doing any work, and
  reports an expired link distinctly from an invalid one. Spending other live
  reset tokens for the same user after a successful reset, since any were issued
  alongside the one just used.

## [2.1.0] - 2026-09-26

### Security

Four moderate advisories in the development tree, from `drizzle-kit` pulling
`@esbuild-kit/esm-loader`, which pinned its own copy of `esbuild@0.18.20`
(`GHSA-67mh-4wv8-2f99`, fixed in 0.25.0).

The advisory allows a website to send requests to an esbuild **dev server** and
read the response. Keystone never calls esbuild's `serve()` API, the packages
are `devDependencies`, and `npm audit --omit=dev` was already clean, so this was
not exploitable here. It was still a real advisory in the tree that builds and
publishes the artifact, and `npm audit fix --force` offered only a downgrade of
`drizzle-kit` to 0.18.1, which is a breaking change.

Resolved with an `overrides` entry forcing `esbuild >= 0.25.0`, which collapses
all three copies to 0.28.2 and clears the audit for production and development
trees alike. Verified that `db:generate`, `db:migrate`, and `db:seed` all still
work against the forced version, and that no non-dev package resolves esbuild.

### Fixed

- The published container image shipped 8 HIGH-severity advisories that no
  JavaScript scanner can detect. `npm audit` and OSV both read
  `package-lock.json` and correctly reported zero, because the vulnerable
  packages are not in Keystone's dependency tree: they are the ones bundled
  inside the base image's `npm@10.9.9` (`brace-expansion@2.0.2`,
  `ip-address@10.1.0`, `pacote@19.0.2`, `picomatch@4.0.3`, `sigstore@3.1.0`).
  The runtime image never invokes npm — `CMD` is `node dist/index.js`, and the
  development compose override builds the `builder` target, which keeps its own
  npm — so it is now removed from the production stage. This clears all 8 and
  reduces the image from 600 MB to 550 MB.

  Only container scanning finds this class of problem, which is why the gate
  exists. Keystones own `brace-expansion@5.0.12` is already above the fixed
  version and was never affected.

### Added

- `.github/dependabot.yml` — weekly updates for npm (root and frontend), GitHub
  Actions, and Docker. Routine patches are grouped; security updates are not, so
  a compromised package lands alone and identifiable.
- `.github/workflows/supply-chain.yml` — OSV scanning (independent advisory
  source from npm's), enforced `npm audit` over both trees, dependency review on
  pull requests, SBOM generation, container scanning, and a license gate.
- `npm run verify:release` — fails on a version that disagrees between
  `package.json` and the lockfile, a dependency in one and not the other, a
  missing or malformed license, or a missing `repository` field. Wired into both
  CI and the release workflow so a bad artifact cannot be published.

### Fixed

- `package.json` declared no `license` field, despite shipping an MIT `LICENSE`
  file. The published package carried no machine-readable terms.

### Changed

- Fastify is at 5.12.5 and `fast-uri` resolves to 3.1.8, both already above the
  5.12.2 / 3.1.7 targets. No upgrade was required.
- The license allowlist permits only permissive terms, with an explicit
  exception for the pre-SPDX `MIT*` identifier that older packages emit.

## [2.0.0] - 2026-09-26

### Security

The mTLS trust boundary trusted whatever the request said about itself. Any
client that could reach Keystone could name a service account in a header and
become it, and could set its own IP address to escape every rate limit. This
release makes identity come only from values a client cannot forge.

- **`x-service-account-id` no longer authenticates.** It previously resolved a
  service account on its own, with no certificate and no credential, so anyone
  who knew or guessed an account ID became that account. It is now read only as a
  hint alongside a valid certificate, and only when the account it names is the
  one that certificate is bound to. A mismatch is refused, not fallen back from.
- **Client identity is bound to a certificate fingerprint.** A new unique
  `service_accounts.cert_fingerprint` column pins a SHA-256 fingerprint to
  exactly one account. Fingerprints are stored canonicalized, so the hex and
  colon-separated spellings of one certificate cannot become two bindings, and
  malformed values are rejected before reaching the database. Service accounts
  are resolved by fingerprint rather than by their operator-chosen name.
- **Identity headers are stripped from untrusted peers.** An `onRequest` hook
  registered before every plugin and route removes
  `x-forwarded-client-cert`, `x-client-cert-fingerprint`,
  `x-forwarded-client-cert-chain`, `x-service-account-id`, `x-forwarded-for`,
  `x-real-ip`, and `forwarded` unless the peer is a configured trusted proxy.
  Stripping rather than ignoring means a route added later cannot read a
  spoofed identity by accident.
- **Rate limits can no longer be escaped.** The server was created with
  `trustProxy: true` and the limiter read `x-forwarded-for` unconditionally, so
  any client could present a fresh address per request and never be limited —
  including against login, password reset, MFA verification, and SCIM. Limit keys
  now come from the peer address unless a trusted proxy forwarded one.
- **Trust decisions do not use `request.ip`.** With `trustProxy` enabled that
  value is derived from the attacker-controlled header, so the trusted-proxy
  check uses the socket peer address, the only value a client cannot set.
- **Forwarded values are validated before use.** Certificate headers are
  length-capped, and a fingerprint must be a well-formed SHA-256 digest, so
  garbage cannot be used as a lookup key.
- **Inactive and revoked service accounts cannot authenticate by certificate.**

### Added

- `KEYSTONE_TRUSTED_PROXIES` — comma-separated proxy IPs, IPv4 CIDRs, or IPv6
  prefixes permitted to set client-identity headers. Unset by default, which
  trusts nothing. IPv4-mapped IPv6 peers are normalized before matching, and
  unrecognized input fails closed.
- `PUT /v1/admin/organizations/:id/service-accounts/:accountId/certificate` —
  bind or clear a client-certificate fingerprint, auditing
  `service_account_certificate_bound` / `service_account_certificate_unbound`.
  A certificate already held by another account returns `409`.
- `POST /v1/admin/organizations/:id/service-accounts/:accountId/revoke` —
  permanently stop an account authenticating, auditing
  `service_account_revoked`. Revoking an already-revoked account returns `409`
  rather than a silent success.
- `docs/security/trust-boundaries.md`, `docs/security/proxy-security.md`, and
  `docs/security/mtls.md` — the trust model, proxy requirements with working
  nginx and ALB configuration, and the mTLS identity rules.
- `docs/MIGRATION-2.0.md` — migration instructions, including the failure mode
  that presents as unrelated clients sharing a rate-limit budget.

### Fixed

- The SCIM token-hash unique indexes introduced in 1.9.0 were declared in the
  Drizzle schema but never emitted as a migration, so they did not exist in any
  deployed database. They are created by migration `0015`.
- The documented nginx configuration used `$proxy_add_x_forwarded_for`, which
  appends to a client-supplied value and lets a client prepend a forged address.
  Corrected to `$remote_addr`, with inbound identity headers stripped.

### Changed

- `trustProxy` is derived from `KEYSTONE_TRUSTED_PROXIES` instead of being
  unconditionally `true`.
- `requireMTLS` distinguishes an untrusted peer (`401 MTLS_UNTRUSTED_PEER`) from
  a missing certificate (`401 MTLS_CERTIFICATE_MISSING`), so a misconfiguration
  is distinguishable from an attack.

### Breaking

- mTLS clients that authenticated with `x-service-account-id` alone must bind a
  certificate fingerprint instead.
- Deployments behind a reverse proxy must set `KEYSTONE_TRUSTED_PROXIES`.
  Without it, forwarded headers are stripped and every client shares one
  rate-limit budget, so unrelated users can rate-limit each other.

## [1.9.0] - 2026-09-25

### Security

SCIM was a single global credential. In 1.8.x a deployment could provision
exactly one organization, the bearer token was stored and compared in plaintext,
and mutations reached global user records.

- SCIM credentials are per-organization. Every connection belongs to exactly one
  organization, at most one is live per organization, and every user and group
  read and write is filtered by it. A cross-tenant target returns `404`, so the
  endpoint is not a tenant oracle.
- Bearer tokens are stored only as a SHA-256 digest and resolved by that digest,
  so a database dump yields no usable token and the comparison carries no timing
  signal. Connections can expire, be rotated, and be revoked.
- Issuing, rotating, and revoking a SCIM credential is owner-only. A SCIM token
  provisions and deactivates tenant users, so a mere admin or member cannot mint
  one.
- Deprovisioning removes the organization's membership and deactivates the
  account only when no membership remains. Previously it deactivated a shared
  account in every organization that user belonged to, without those
  organizations' authorization.
- SCIM refuses to change the global attributes of a shared user, to reactivate a
  shared account, and to remove the last owner of an organization.
- SCIM can no longer attach a user who already belongs to another organization,
  and the conflict message no longer names the organization that holds them.
- Unauthenticated SCIM traffic is budgeted before the authentication hook emits
  audit and webhook events, closing an unauthenticated write-amplification path.
- SCIM request budgets are keyed per credential, so one noisy identity provider
  cannot exhaust every other tenant's allowance.

### Changed

- `SCIM_BEARER_TOKEN` and `SCIM_ORG_ID` are deprecated. They are adopted once
  into a connection at startup and then ignored, so an upgrade does not break an
  existing identity provider. Adoption is one-time in any state, so a restart
  cannot resurrect a revoked credential.
- Deprovisioning a single-tenant user now removes the membership as well as
  deactivating the account. Deprovisioning a shared user removes only the
  membership, and a follow-up `DELETE` returns `404`.
- `POST /scim/v2/Users` is create-or-update; profile fields for an existing
  member are applied rather than dropped.
- A user removed from an organization can be re-provisioned. Previously the
  global email lookup found the inactive row and returned `409` forever.
- Rotating a credential revokes the previous token immediately
  (`SCIM_ROTATION_GRACE_SECONDS` defaults to `0`). A grace window is now an
  explicit opt-in and is not a revocation mechanism.
- Groups are real organization-scoped records. The synthetic role-bucket
  projection (`<orgId>:<role>` ids) is removed.
- Malformed path ids return a SCIM `404` instead of surfacing a driver error, and
  validation and internal failures return SCIM `Error` objects.

### Added

- `scim_connections` with rotation, revocation, expiry, and a token hint.
- `scim_groups` and `scim_group_members`, organization-scoped throughout.
- `PATCH /scim/v2/Users/:userId` and `POST /scim/v2/Users/.search`.
- Group create, replace, patch, delete, and member management endpoints.
- `filter`, `startIndex`, and `count` on list endpoints; unsupported filters are
  rejected rather than silently ignored.
- `GET /scim/v2/ServiceProviderConfig` and `GET /scim/v2/ResourceTypes`.
- Owner-only admin API for creating, listing, rotating, and revoking SCIM
  connections, with a dashboard UI for the same.
- `findByIdInOrg`, `updateInOrg`, `listOrgIdsForUser`, and `removeFromOrg`
  repository methods for organization-scoped user access.
- Audit events `scim_connection_created`, `scim_connection_rotated`,
  `scim_connection_revoked`, `scim_access_denied`, `scim_authentication_failed`,
  and the `scim_group_*` group events.
- `docs/MIGRATION-1.9.md`.

## [1.8.0] - 2026-09-25

### Security

MFA was advisory in 1.7.x. A user with TOTP enabled could sign in with only a
password, and when a code was supplied it was verified *after* the access token,
refresh token, and session had already been created. 1.8.0 makes the second
factor mandatory.

- Password authentication now stops at `requires_mfa` for MFA-enabled accounts.
  No access token, refresh token, or session row is created at that stage.
- New `POST /auth/mfa/verify` completes the transition. The challenge is opaque,
  stored only as a hash, short-lived, single-use, and bounded by an attempt
  budget enforced in the database.
- Token issuance is guarded at a single chokepoint. A token cannot be minted for
  an MFA-enabled user without a recorded factor, so no login path bypasses MFA by
  omission.
- TOTP verification uses the user's own decrypted secret. Each time-step is
  accepted exactly once, so a captured code is rejected even against a freshly
  issued challenge.
- Enabling MFA revokes every existing refresh token and session for the account.
  Sessions record how MFA was satisfied, and refresh rotation refuses sessions
  with no recorded factor.
- Backup codes carry 80 bits of entropy, are stored as a keyed (peppered) hash,
  expire after 90 days, and are consumed by a conditional update so concurrent
  use has exactly one winner.
- TOTP secrets are written with AES-256-GCM. Values written by earlier versions
  used AES-256-CBC and remain readable.

### Changed

- `POST /auth/login` and `POST /auth/token-login` return `401` with
  `code: "MFA_REQUIRED"` and a challenge when MFA is required. See
  [MIGRATION-1.8.md](docs/MIGRATION-1.8.md).
- The undocumented `totp_code` field on the login endpoints is removed and
  ignored.
- `POST /auth/totp/backup` now regenerates backup codes and requires a current
  TOTP code. `POST /auth/totp/backup/verify` consumes a backup code.
- `POST /auth/totp/verify` additionally reports `sessionsRevoked`.
- WebAuthn assertions satisfy MFA on their own. Magic links refuse to downgrade a
  TOTP-protected account, and SAML, enterprise OIDC, federation, and OAuth2
  report a typed `mfa_required` error.
- OAuth2 authorization codes carry the MFA factor of the session that approved
  them, so the token exchange cannot launder an unverified login.
- Access tokens for MFA sessions carry `mfa_verified`, `mfa_factor`, and `amr`.
- Factor management requires step-up: `/auth/totp/enroll`, `/auth/totp/verify`,
  `/auth/totp/backup`, `/auth/totp/disable`, and passkey registration for a
  TOTP-protected account all require the account password in addition to the
  session.
- A passkey registered after TOTP was enabled is treated as a single factor and
  cannot be used to sign in on its own.
- Disabling TOTP deletes its backup codes.
- Failed MFA factor attempts count toward the account lockout.
- `SDK.authentication.login()` returns a discriminated union; `completeMfa()` is
  new.

### Fixed

- `/auth/mfa/verify` wrote session cookies under a name derived from the login
  flow instead of the client id, so MFA-completed sessions were not readable by
  the auth plugin and every application on the cookie domain shared one name.
- The MFA step no longer accepted accounts that are deactivated, under review,
  or locked out, which the password step already refused.
- Repeated password steps no longer cancel an MFA challenge created moments
  earlier.
- `MFA_CHALLENGE_TTL_SECONDS`, `MFA_MAX_ATTEMPTS`, and
  `TOTP_BACKUP_CODE_TTL_SECONDS` are validated at startup and fall back to their
  defaults instead of silently breaking every login.
- The MFA factor copied out of a verified token into the authorization-code
  table is validated against the column's check constraint.
- SAML now reports `mfa_required` for MFA-protected accounts instead of
  collapsing the failure into a generic validation error.

### Added

- `mfa_challenges` table, `MfaChallengeRepository`, and `MfaService`.
- `MFA_CHALLENGE_TTL_SECONDS`, `MFA_MAX_ATTEMPTS`, and
  `TOTP_BACKUP_CODE_TTL_SECONDS` configuration.
- Audit events `mfa_challenge_created`, `mfa_challenge_failed`,
  `mfa_challenge_expired`, `mfa_challenge_rejected`, `mfa_verified`,
  `mfa_bypass_blocked`, and `mfa_backup_code_regenerated`.
- Dedicated rate limits for MFA verification and every TOTP management endpoint.
- MFA challenge step in the admin dashboard login form.
- `docs/MIGRATION-1.8.md`.
- MFA security regression suite (`src/tests/security/mfa.test.ts`).

## [1.7.0] - 2026-09-24

### Added

- Dedicated owner-only platform-role endpoint at `PATCH /v1/admin/platform/users/:userId/role`.
- Centralized platform and organization authorization guards with explicit organization context.
- Versioned audit events for platform-role, membership, permission, and denied-authorization transitions.
- Dedicated authorization regression suite covering privilege escalation, tenant isolation, workflow safety, secret disclosure, and audit metadata.
- RBAC and authorization-boundary documentation.

### Changed

- Platform roles are explicitly limited to `owner` and `user`.
- Organization roles are explicitly limited to `owner`, `admin`, and `member`.
- Authorization checks now require an explicit `organizationId`.
- Frontend administration clients use the dedicated platform-role endpoint and safe workflow definitions.
- SAML metadata lookups require both connection and organization identifiers.

### Fixed

- Organization user routes can no longer mutate global users or deactivate shared accounts.
- Generic profile and in-process identity contracts can no longer carry a platform role.
- Organization admins cannot promote themselves or other members to organization owner.
- The sole organization owner cannot be demoted or removed.
- Tenant workflows now use a closed safe-step allowlist; plugin aliases, arbitrary webhooks, organization creation, and authorization-mutating steps fail closed.
- Global workflows require platform-owner access, and workflow execution rechecks organization membership.
- Organization creation always assigns an owner; actorless global deactivation APIs were removed from the organization domain.
- Last-owner transitions use database row locks to prevent concurrent demotion/removal.
- Platform-user deactivation now disables login, invalidates existing sessions, revokes refresh tokens and user API keys, and preserves the last active owner invariant.
- User-management responses redact application secret hashes, OIDC/API-key credentials, configuration values, password hashes, TOTP secrets, and metadata.
- SAML/OIDC public lookups require an organization context; new OIDC client secrets are encrypted at rest, and legacy plaintext values are re-encrypted on first callback use.
- OAuth/OIDC client context no longer places an organization claim in a user token unless the user is a member of that application's organization.
- Failed authorization attempts and role transitions now produce structured audit evidence.
- SAML schema validation now has a signed-response regression test and audience/destination/recipient checks, alongside one-time transaction claiming and OIDC ID-token/JWKS verification.
- Enterprise SSO requires an explicit connection/subject identity link and rejects platform-owner tenant login; generic OAuth no longer auto-links by email.
- SCIM is scoped to `SCIM_ORG_ID`, cannot re-enable quarantined or platform-owner accounts, attributes audits to the SCIM credential, and deactivates rather than deleting users.
- OIDC endpoint checks cover private, carrier-grade, benchmarking, dotted/hex IPv4-mapped, DNS-pinned, and redirecting targets.
- Legacy account migration quarantines ambiguous unverified rows instead of activating them.
- SAML semantic validation and OIDC/JWKS checks are covered by signed-response tests; OAuth2 refresh success and failure emit audit events.
- Refresh-token rotation and OAuth authorization-code consumption are atomic and client-bound.
- Legacy unverified accounts are quarantined for explicit review during the deactivation migration.
- OIDC endpoint configuration blocks private/redirected targets by default; SCIM reflects account deactivation.
- Added a blocking `oxlint` gate with warnings denied; CI now runs lint separately from typecheck.
- Pinned safe transitive versions for `@xmldom/xmldom`, `fast-uri`, and `find-my-way`; the High-severity production audit gate now passes.
- API-key validation uses public user projections and emits `api_key_used` audit events; the compiled OIDC re-encryption helper closes its database pool before exit.

### Security

- Critical organization-admin-to-platform-owner escalation paths are closed at HTTP, application, domain, SDK, and repository boundaries.
- Cross-tenant authorization context is resolved from authenticated database membership rather than client-controlled application context.
- Workflow definitions that are malformed or contain blocked authorization steps fail closed.

### Breaking Changes

- Organization user PATCH/DELETE endpoints no longer mutate global accounts; they return a migration response. Use platform user administration or organization member endpoints.
- `/v1/authz/check` requests must include `organizationId`.
- Custom organization role names are no longer accepted; only `owner`, `admin`, and `member` are supported.
- Public SAML/OIDC initiation and metadata URLs require `organizationId`.
- Direct authorization SDK calls now require both actor and organization IDs.
- OIDC connections require a JWKS URI; OAuth2 application-bound refresh requests must provide the bound `client_id` and `client_secret`.
- SCIM requires both `SCIM_BEARER_TOKEN` and `SCIM_ORG_ID`, and operates only within that organization.
- Legacy unverified accounts may be marked `account_review_required` and require explicit review.
- Tenant workflow definitions containing authorization-mutating, plugin, organization-creation, or arbitrary webhook steps are rejected or blocked.

### Migration

- Move platform role changes to `PATCH /v1/admin/platform/users/:userId/role`.
- Use `/v1/admin/organizations/:id/members/:userId` for organization role changes.
- Remove unsafe workflow steps before deployment.
- Update SAML/OIDC URLs to include the organization ID.
- Update authorization-check clients to send the organization ID explicitly.

### Dependencies

- No dependency changes in this release. Existing dependency audit findings remain tracked for the planned supply-chain phase.

### Testing

- Backend typecheck and build pass.
- Backend test suite passes with the security regression suite enabled.
- Frontend production build passes.

## [1.6.0] - 2026-09-20

Frontend upgrades — React 19, Vite 8, Tailwind 4, TypeScript 7.

### Changed

- **React** 18.3.1 → 19.3.0
- **React DOM** 18.3.1 → 19.3.0
- **Vite** 5.4.21 → 8.3.0
- **@vitejs/plugin-react** 4.7.0 → 6.1.1
- **Tailwind CSS** 3.4.19 → 4.3.3 — complete rewrite: config moved from JS to CSS `@theme` directive, PostCSS plugin replaced with `@tailwindcss/vite`.
- **@simplewebauthn/browser** 13.3.0 → 14.0.0
- **TypeScript** 5.9.3 → 7.0.2 (frontend)
- **@types/react** 18.3.31 → 19.0.0
- **@types/react-dom** 18.3.7 → 19.0.0

### Removed

- **autoprefixer** — not needed with Tailwind 4.
- **postcss** — not needed with Tailwind 4.
- **tailwindcss-animate** — animations built into Tailwind 4.

### Added

- **@tailwindcss/vite** — replaces PostCSS plugin approach.

### Migration notes

- `tailwind.config.js` deleted — config now lives in `src/tailwind.css` using `@theme` directive.
- `postcss.config.js` deleted — Tailwind 4 uses Vite plugin directly.
- `src/index.css` updated to use `@import "./tailwind.css"` instead of `@tailwind base/components/utilities`.

[1.7.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.7.0
[1.6.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.6.0
[1.5.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.5.0
[1.4.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.4.0
[1.3.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.3.0
[1.2.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.2.0
[1.1.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.1.0
[1.0.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.0.0
## [1.5.0] - 2026-09-20

Auth & infrastructure upgrades — jose 6, ioredis 6, bullmq 6, simplewebauthn 14, nodemailer 10.

### Changed

- **jose** 5.10.0 → 6.2.12 — `KeyLike` type removed, replaced with `CryptoKey`.
- **ioredis** 5.11.1 → 6.0.0
- **bullmq** 5.80.2 → 6.3.8
- **@simplewebauthn/server** 13.3.2 → 14.0.2 — `AuthenticatorTransportFuture` renamed to `AuthenticatorTransport`.
- **nodemailer** 9.0.3 → 10.0.10

### Fixed

- **jose 6 migration** — Replaced `KeyLike` with `CryptoKey` in secrets provider, tokens service, and database/environment secrets providers.
- **simplewebauthn 14 migration** — Renamed `AuthenticatorTransportFuture` to `AuthenticatorTransport` in webauthn service.

## [1.4.0] - 2026-09-20

Fastify ecosystem upgrades — all plugins updated to latest major versions.

### Changed

- **fastify-plugin** 5.1.0 → 6.0.0
- **@fastify/cookie** 10.0.1 → 11.1.2
- **@fastify/cors** 10.1.0 → 11.3.0
- **@fastify/static** 8.3.0 → 10.1.4
- **@fastify/swagger-ui** 5.2.6 → 6.1.1

## [1.3.0] - 2026-09-20

Core tooling upgrades — TypeScript 7, Zod 4, Drizzle latest, Commander 15, Dotenv 18.

### Changed

- **TypeScript** 5.9.3 → 7.0.2 — new major version with stricter type checking.
- **Zod** 3.25.76 → 4.6.5 — API redesign: `z.record()` now requires explicit key type. Updated 7 call sites across 6 route files.
- **Drizzle ORM** 0.31.4 → 0.45.2
- **Drizzle Kit** 0.22.8 → 0.31.10
- **Commander** 12.1.0 → 15.0.0
- **Dotenv** 16.6.1 → 18.0.1

### Fixed

- **Zod 4 migration** — Updated all `z.record()` calls to include explicit `z.string()` key type parameter (sso.ts, auth.ts, config.ts, profile.ts, setup.ts, webauthn.ts, workflows.ts).

## [1.2.0] - 2026-09-20

Dependency updates — safe patches and minor versions.

### Changed

- **fastify** 5.10.0 → latest 5.x
- **@fastify/swagger** 9.8.0 → latest 9.x
- **argon2** 0.44.0 → latest 0.x
- **otpauth** 9.5.1 → latest 9.x
- **@opentelemetry/sdk-node** 0.220.0 → latest 0.x
- **@opentelemetry/auto-instrumentations-node** 0.78.0 → latest 0.x
- **autoprefixer** 10.5.2 → latest 10.x (frontend)
- **postcss** 8.5.19 → latest 8.x (frontend)
- **lucide-react** 1.24.0 → latest 1.x (frontend)
- **@playwright/test** 1.61.1 → latest 1.x (frontend)

## [1.1.0] - 2026-09-19

Security hardening, architecture improvements, and enterprise SSO enhancements.

### Added

- **SCIM provisioning** — User and group provisioning endpoints (`/scim/v2/Users`, `/scim/v2/Groups`) for identity provider integration.
- **Enterprise SSO** — SAML 2.0 and OIDC enterprise connectors with SCIM user provisioning.
- **mTLS support** — Service account resolution via client certificate headers.
- **Comprehensive audit logging** — All authentication events (register, login, logout, refresh) and state-changing operations now emit audit events.
- **Rate limiting** — Added to 8 sensitive endpoints: password reset, magic links, email verification, SMS OTP send/verify, and organization creation.
- **Owner-only access** — Configuration and permission management endpoints restricted to platform owner.
- **Organization membership checks** — Workflow operations now verify org membership.
- **XML injection prevention** — SAML metadata generation now escapes dynamic values.
- **Cryptographic nonces** — Rate limiter uses `crypto.randomBytes()` instead of `Math.random()`.
- **Shared helpers** — `sendResultError` and `escapeXml` utilities for consistent error handling and XML safety.

### Changed

- **Admin routes split** — Monolithic `admin.ts` (1071 lines) refactored into 7 focused modules under `src/routes/admin/` (platform, organizations, permissions, sso, billing, webhooks, helpers).
- **Repository pattern enforced** — 9 route files updated to use DI container repositories instead of direct database access.
- **Dynamic imports eliminated** — 15+ `await import()` workarounds converted to static imports across 10 files.
- **Permission endpoints** — Now require owner-only access (was any authenticated user).
- **Workflow endpoints** — Now require organization membership (was any authenticated user).
- **Config endpoints** — Now require owner-only access (was any authenticated user).

### Fixed

- **Critical runtime crash** — Missing `cache` import in `src/index.ts` causing shutdown failures.
- **Import ordering bug** — `sessions.ts` using `config` and `hashToken` before import declaration.
- **Missing dependency** — Added `fastify-plugin` as explicit dependency.
- **Redundant dynamic imports** — Removed 2 unnecessary `await import("jose")` calls in `tokens.ts`.
- **Duplicate code** — Consolidated 3 duplicate `sendResultError` functions to shared helper.
- **Unused imports** — Cleaned up across 8+ files.

### Security

- **Rate limiting** — 8 endpoints protected against abuse (password reset, magic links, email verification, SMS OTP, org creation).
- **Authorization hardening** — 16 endpoints updated with proper owner/role/org membership checks.
- **XML injection prevention** — SAML metadata generation escaped in 2 files.
- **Cryptographic security** — Rate limiter nonce generation uses secure random bytes.
- **Information leak removal** — Queue class name no longer exposed in API response.
- **Input validation** — All route inputs validated with Zod schemas.

