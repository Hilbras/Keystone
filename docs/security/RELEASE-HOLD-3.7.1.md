# Release hold — 3.7.1 — CLEARED

**Status: CLEARED 2026-10-06. `v3.7.1` through `v3.9.1` are publishable.**

Kept as the record of *why* seven releases were held. An audit that deletes its own
findings teaches nothing to the next reader.

## What was held

Seven releases — `3.7.1`, `3.7.2`, `3.8.0`, `3.8.1`, `3.9.0`, `3.9.1` — were
merged to `main` with all four required checks green, and **nothing tagged, nothing
published**. npm `latest` was `3.7.0`.

`main` reached `2d346bd` at the start of the hold (SEC-079, webhook response-body
privacy), and the five later releases each merged normally behind it.

## The blocker, and why a rebuild could not clear it

The `Container scan` job in `supply-chain.yml` failed with one HIGH advisory:

```text
libpcre2-8-0   CVE-2026-103111   HIGH   fixed   10.46-1~deb13u2 → 10.46-1~deb13u3
pcre2: Out-of-bounds write via crafted regular expression
```

**Not caused by any change in this repository.** It was in `node:26-slim`, the
runtime base. The same scan had passed on the three preceding `main` commits, so it
was newly disclosed, not a regression.

Measured, not assumed, at the time:

```bash
docker pull node:26-slim
docker run --rm node:26-slim dpkg-query -W -f='${Version}\n' libpcre2-8-0
# → 10.46-1~deb13u2
```

A freshly pulled `node:26-slim` still carried `deb13u2`. Debian had not published
`deb13u3`, so **no rebuild produced an image the scan accepted.** Tagging would have
published a knowingly-vulnerable image, which is why the releases were held rather
than shipped with a note attached.

## The condition, met

The hold cleared itself on one condition — Debian publishing `deb13u3`:

```bash
docker pull node:26-slim
docker run --rm node:26-slim dpkg-query -W -f='${Version}\n' libpcre2-8-0
# → 10.46-1~deb13u3
```

`CVE-2026-103111` is **gone from the current base tag.** Condition satisfied.

## What clearing it did *not* mean

Stated because "the CVE is fixed" and "the image is clean" are different claims, and
only the first is true of the base tag.

A fresh `node:26-slim` still carries **46 HIGH advisories with no fix available** —
`util-linux`, `bsdutils`, `libsystemd0`, `perl-base` and others. Those do not block,
because `verify-image-vulnerabilities.mjs` passes `--ignore-unfixed`. That is the
correct policy: an advisory with no available fix cannot be remediated by holding a
release, and blocking on it would mean never shipping again.

Three advisories *do* have fixes — `CVE-2026-102276` and `CVE-2026-102278`
(`brace-expansion`), `CVE-2026-19534` (`undici`). **None of them is ours:**

- our `package-lock.json` carries `brace-expansion 5.0.12`, newer than the vulnerable
  `5.0.9`;
- we have **no `undici` dependency at all.**

Both live in **`node:26-slim`'s own bundled npm 11.19.1.** They were invisible to
`npm audit` and to every lockfile scanner precisely because they are not in our
lockfile — and the `Dockerfile` already deletes npm from the runtime stage for exactly
that reason, with a comment recording the reasoning.

## The decisive measurement

The scan that matters is of the **image that would actually be published**, not of the
base tag. Run with the release gate's own flags
(`--severity CRITICAL,HIGH --ignore-unfixed`):

```text
$ trivy image --severity CRITICAL,HIGH --ignore-unfixed keystone:<built>
BLOCKING advisories in the real runtime image: 0
npm in runtime image: absent
```

**The release gate passes.**

This was the *second* available way to get the answer wrong, and the first one looked
convincing. Scanning `node:26-slim` directly reports **3 blocking advisories** and
looks like the hold still applies. Scanning the built image reports **0**, because the
stage that ships has no npm in it. The release gate scans the built image, so the
built image is the only thing worth measuring.

## The gap this exposed, now closed by SEC-080

The original hold recorded a real defect:

> **`release.yml` had no image vulnerability check.** It ran `npm audit
> --omit=dev --audit-level=high`, which sees JavaScript advisories only, then verified,
> built and published. OS-package vulnerabilities in the runtime image were scanned by
> `supply-chain.yml`, which was not a required check on `main` and not a dependency of
> the release workflow. So a release could ship an image with a HIGH OS advisory with
> every release gate green — which is exactly what happened here.

That is a control reporting success for something other than what it protects — the
defect class this project has now found roughly fifty times.

`verify-image-vulnerabilities.mjs` is now a dependency of the release workflow, and it
scans the image that would actually be published rather than a separately built local
image. A gate that cannot run is a failure, never a pass. That is the change which
turned "we should not publish this" into a condition that could clear itself.

## Considered and rejected, at the time

| option | why not |
|---|---|
| `node:26-alpine` | has no `pcre2` package, so the CVE cannot apply — but switching the base image is a real change with its own consequences, and a decision rather than a workaround to take unilaterally |
| `node:26-bookworm-slim` | carries pcre2 `10.42`, a different major line from the vulnerable `10.46`; not the affected package, and equally a base change |
| pinned `apt upgrade` in the Dockerfile | would fetch `deb13u3`, which was not published — so it could not work either |

None of these was needed. Waiting for the upstream fix was both the cheapest option
and the one that required no judgement call.

## Releases now publishable

| Version | Subject |
|---|---|
| 3.7.1 | SEC-079 — stop persisting the webhook consumer's response body |
| 3.7.2 | SEC-080 — scan the real release image for OS advisories |
| 3.8.0 | SEC-081 — webhook retry backoff with jitter |
| 3.8.1 | SEC-082 / SEC-083 — signature verification hardening, delivery headers |
| 3.9.0 | §2.5 — queue worker identity, configurable concurrency |
| 3.9.1 | SEC-084 — a distributed lock with ownership verification |