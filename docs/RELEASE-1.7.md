# v1.7.0 Release Checklist

This checklist is for the local release candidate. Tagging, GitHub Release creation, and npm publication still require explicit approval.

## Local verification

- [x] `npm ci` (2026-09-25 local run; release CI repeats the install)
- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `npm test` with PostgreSQL and Redis (97 passed, 1 skipped)
- [x] `npm run test:security` (47 passed)
- [x] `cd frontend && npm run build`
- [x] `npm pack --dry-run`
- [x] `git diff --check`

## Security verification

- [x] Organization-to-platform role escalation regression coverage
- [x] Organization membership rank and last-owner coverage
- [x] Workflow allowlist, malformed-definition, and tenant-scope coverage
- [x] SAML/OIDC organization-scope, schema validation, ID-token verification, and one-time RelayState transaction coverage
- [x] Existing-user enterprise SSO membership/identity-link and platform-owner isolation coverage
- [x] Generic OAuth verified-identity and no-email-autolink coverage
- [x] Scoped SCIM credential, organization isolation, review-state, platform-owner isolation, service attribution, and last-owner coverage
- [x] OIDC endpoint SSRF policy coverage, including private, carrier-grade, dotted/hex mapped, and DNS-pinned address ranges
- [x] User/application/API-key/configuration secret projection coverage
- [x] Account deactivation, refresh-token/API-key revocation, and cross-client token-scope coverage
- [x] Non-burning wrong-client refresh rejection, OAuth2 refresh success/failure audit coverage, and execution-time workflow authorization coverage
- [x] Fail-closed legacy migration and SAML audience/destination/recipient semantic coverage
- [x] Authorization audit metadata, top-level tenant attribution, and denied-attempt coverage
- [x] Runtime role constraints, owner-required organization creation, and legacy-value normalization migration

## Unresolved release blockers

### Dependency audit

The release workflow runs `npm audit --omit=dev --audit-level=high` as a blocking gate. The 2026-09-25 run passes with **0 High** findings after safe transitive overrides for `@xmldom/xmldom`, `fast-uri`, and `find-my-way`. Four Moderate findings remain outside the High-severity release gate and should continue to be tracked.

### Lint

The repository now has a real `oxlint` gate (`npm run lint`) with warnings denied, and CI runs it as a blocking step. Typecheck remains a separate gate.

### npm publication

The release workflow now builds the package, runs `npm pack --dry-run`, installs the packed tarball in a clean temporary prefix, and smoke-tests the CLI before publication. The job still requires the `NPM_TOKEN` GitHub secret, which is not currently configured. Verify trusted publishing or configure the secret before release.

### External actions

- [ ] User approves tag and remote publication
- [ ] Tag `v1.7.0` is pushed
- [ ] GitHub Release is verified
- [ ] npm package is installed and smoke-tested
