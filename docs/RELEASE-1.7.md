# v1.7.0 Release Checklist

This checklist is for the local release candidate. Tagging, GitHub Release creation, and npm publication still require explicit approval.

## Local verification

- [x] `npm ci` (2026-09-24 local run; release CI repeats the install)
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
- [x] Scoped SCIM credential, organization isolation, review-state, and last-owner coverage
- [x] OIDC endpoint SSRF policy coverage, including private and mapped address ranges
- [x] User/application/API-key/configuration secret projection coverage
- [x] Account deactivation, refresh-token/API-key revocation, and cross-client token-scope coverage
- [x] Non-burning wrong-client refresh rejection and execution-time workflow authorization coverage
- [x] Fail-closed legacy migration and SAML audience/destination/recipient semantic coverage
- [x] Authorization audit metadata, top-level tenant attribution, and denied-attempt coverage
- [x] Runtime role constraints, owner-required organization creation, and legacy-value normalization migration

## Unresolved release blockers

### Dependency audit

The release workflow now runs `npm audit --omit=dev --audit-level=high` as a blocking gate; the lint exception remains explicitly documented. The 2026-09-24 run still reports 3 High severity findings: `@xmldom/xmldom` (multiple XML parser/serialization advisories), `fast-uri` (host-confusion/SSRF advisories), and `find-my-way` (HTTP/2 DDoS). `npm audit fix` is available, but no forced remediation was applied. The roadmap schedules dependency remediation for a later supply-chain phase, but no exception is approved yet. Do not tag or publish until these findings are either fixed or covered by an explicitly approved, time-bounded exception with an owner and review date.

### Lint

The repository currently has no real lint script/configuration. `typecheck` is not a substitute for lint. Add a real lint gate or record an explicit release exception before tagging.

### npm publication

The release workflow now builds the package, runs `npm pack --dry-run`, installs the packed tarball in a clean temporary prefix, and smoke-tests the CLI before publication. The job still requires the `NPM_TOKEN` GitHub secret, which is not currently configured. Verify trusted publishing or configure the secret before release.

### External actions

- [ ] User approves dependency/lint decisions
- [ ] User approves tag and remote publication
- [ ] Tag `v1.7.0` is pushed
- [ ] GitHub Release is verified
- [ ] npm package is installed and smoke-tested
