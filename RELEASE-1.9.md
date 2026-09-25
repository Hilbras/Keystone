# v1.9.0 Release Record

Published 2026-09-25. `@hilbras/keystone@1.9.0` is live on npm with a signed
provenance statement, and the GitHub Release `v1.9.0` is the latest release.

## What shipped

Three phases of the security roadmap, released together:

| Version | Scope | Migration guide |
| --- | --- | --- |
| 1.7.0 | Authorization and authorization-boundary hardening | `docs/MIGRATION-1.7.md` |
| 1.8.0 | MFA made mandatory; token-issuance chokepoint | `docs/MIGRATION-1.8.md` |
| 1.9.0 | SCIM made organization-scoped | `docs/MIGRATION-1.9.md` |

## Gates at the published commit

| Gate | Result |
| --- | --- |
| `npm run lint` (`oxlint src --deny-warnings`) | 0 warnings, 0 errors |
| `npm run typecheck` | pass |
| `npm test` | 208 pass, 1 skipped, 0 fail, 0 cancelled |
| `npm run test:security` | 160 pass, 0 fail |
| frontend build | pass |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| CI `verify`, `npm`, `docker`, `publish` jobs | all green |

## Two defects the release process caught

1. **Cancelled test files.** `--test-force-exit` quit the runner as soon as the
   first test file finished, cancelling slower siblings. On a fast machine the
   security suite won the race; on a CI runner the smoke suite finished first and
   47 security tests were reported as cancelled, failing the v1.7.0 release with
   **0 actual failures**. Fixed with `--test-concurrency=1`, which keeps the
   force-exit hang protection while making cancellation impossible.

2. **Missing repository URL.** `npm publish --provenance` was rejected with
   `E422` because `package.json` had no `repository` field, so npm could not match
   the build's provenance to the package. Added `repository`, `description`,
   `homepage`, and `bugs`.

Both were invisible locally and only surfaced in CI — worth remembering for the
next release.

## Post-release verification

- `npm view @hilbras/keystone version` → `1.9.0`
- Installed the published tarball into a clean project: version 1.9.0, CLI runs
- 638 published files, no `src/`, tests, or fixtures leaked
- 15 SQL migrations shipped

## Outstanding

- The `v1.7.0` tag still exists on the remote, pointing at `1baa22f`. It has no
  GitHub Release and was never published, and its CI run is red. Remove it with:
  ```bash
  git push origin :refs/tags/v1.7.0 && git tag -d v1.7.0
  ```
- `main` is still at `v1.1.0`. Releases 1.2.0 through 1.9.0 were tagged from
  `release/*` branches and main was never merged forward, which is why the
  repository's default branch looks stale. Worth deciding whether to merge.
- The `NPM_TOKEN` used for this release was pasted in chat in plain text. Revoke
  it on npmjs.com and set a fresh one with `gh secret set NPM_TOKEN`.
