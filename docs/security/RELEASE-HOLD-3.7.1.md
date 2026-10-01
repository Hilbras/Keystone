# Release hold — 3.7.1

**Status: held deliberately. Do not tag `v3.7.1` until the condition below clears.**

## What is merged

`main` is at `2d346bd` — SEC-079 (webhook response-body privacy) plus the
`EXCLUDED_FROM_REVIEW` entry and the documentation. All four required checks on
`main` passed: backend, frontend, docker, gates. `package.json` reads `3.7.1`.

**Nothing is tagged and nothing is published.** npm `latest` is `3.7.0`.

## The blocker

The `Container scan` job in `supply-chain.yml` failed on PR #88 with one HIGH
advisory:

```
libpcre2-8-0   CVE-2026-103111   HIGH   fixed   10.46-1~deb13u2 → 10.46-1~deb13u3
pcre2: Out-of-bounds write via crafted regular expression
```

**It is not caused by SEC-079 and not caused by any change in that diff.** It is
in `node:26-slim`, the runtime base, and it is disclosed upstream.

The same scan passed on the three preceding `main` commits, so the advisory was
published after they — it is newly disclosed, not a regression.

## Why a rebuild does not clear it

Measured, not assumed:

```bash
docker pull node:26-slim
docker run --rm node:26-slim dpkg-query -W -f='${Version}\n' libpcre2-8-0
# → 10.46-1~deb13u2
```

A freshly pulled `node:26-slim` **still** carries `deb13u2`. Debian has not
published `deb13u3` for that tag, so no rebuild produces an image the scan accepts.
Tagging now would publish a knowingly-vulnerable image, which is why the release
is held.

## What clears it

Debian publishing `libpcre2-8-0 10.46-1~deb13u3` for trixie, which propagates into
a new `node:26-slim` tag. Check with the command above; when it reports `deb13u3`,
tag and publish.

```bash
git tag -a v3.7.1 -m "3.7.1 — stop persisting the webhook consumer's response body"
git push origin v3.7.1
# then watch the release workflow
```

## The gap this exposed, which is worth fixing separately

**`release.yml` has no image vulnerability check.** It runs `npm audit
--omit=dev --audit-level=high`, which sees JavaScript advisories only, and then
verifies, builds, publishes. OS-package vulnerabilities in the runtime image are
scanned by `supply-chain.yml`, which is:

- not a required check on `main`, and
- not a dependency of the release workflow.

So a release can ship an image with a HIGH OS advisory and the release gates all
green — which is what happened here. `trivy-action` is configured with
`exit-code: "1"`, so the scan itself does fail; nothing is waiting on it.

That is a control that reports success for something other than what it protects,
which is the defect class this project has now found ~50 times. A fix belongs in
the release path — the scan needs to be reachable from `release.yml`, or the release
needs to depend on it.

## Considered and rejected

| option | why not |
|---|---|
| `node:26-alpine` | has no `pcre2` package at all, so the CVE cannot apply — but switching the base image is a real change with its own consequences, and it is a decision rather than a workaround to take unilaterally |
| `node:26-bookworm-slim` | carries pcre2 `10.42`, a different major line from the vulnerable `10.46`; not the affected package, and equally a base change |
| pinned `apt upgrade` in the Dockerfile | would fetch `deb13u3`, which is not published — so it cannot work today either |
