# Implementation Plan: Phase 1 v1.7.0 Authorization Hardening

## Overview

Phase 1 closes the confirmed privilege-escalation and authorization-boundary findings in the `v1.6.0` codebase. The implementation will separate platform roles from organization membership roles, remove tenant-controlled global-role writes, enforce organization-role invariants, close workflow and resource-scope bypasses, sanitize user responses, centralize route policy checks, and add auditable regression coverage.

The implementation follows `plan.md` Phase 1 and keeps later roadmap work out of scope unless it is required to close a confirmed critical path.

## Threat Model

| Boundary | Asset | Threat | Required control |
| --- | --- | --- | --- |
| HTTP organization routes → global user row | Platform role and account state | Organization admin/owner writes `users.role` or globally deactivates a shared account | Organization routes may not mutate global user state; use `/members/:userId` for membership roles |
| Tenant workflow definitions → global event stream | Platform role and tenant membership | A member defines `assign_role` or cross-tenant membership steps | Reject unsafe workflow steps and scope workflow execution to the workflow organization |
| Organization membership table | Owner/admin/member authority | Admin self-promotion, owner invitation, or last-owner demotion | Central role-rank policy and last-owner invariant |
| Generic identity SDK/repository | `users.role` | Any caller smuggles `role` through a profile update | Remove `role` from generic profile contracts; expose a dedicated platform-role use case |
| Organization user responses | Password hashes, TOTP secrets, internal fields | Full `User` rows are returned to tenant members | Serialize every user response through `toPublicUser()` |
| Authorization context | Permission decisions and token claims | Client-controlled app/org context or stale membership is trusted | Resolve organization and membership from authenticated actor and route parameters; only membership-backed client context may add organization claims |
| Resource repositories | Cross-tenant SSO/application data | Connection IDs are looked up globally | Add organization-scoped resource lookups |
| Audit log | Role-transition evidence | Mutations are mislabeled, omit old/new state, and failed checks are silent | Add explicit event contracts and structured actor/target/org/before/after metadata |

## Architecture Decisions

1. **Platform roles are exactly `owner` and `user`.** Organization roles remain exactly `owner`, `admin`, and `member`. The two namespaces are never interchangeable.
2. **Platform role changes use a dedicated endpoint.** `PATCH /v1/admin/platform/users/:userId/role` accepts only the typed platform role. The existing generic platform-user PATCH no longer accepts `role`.
3. **Organization user write endpoints are retired.** Global profile mutation and global deactivation through `/v1/admin/organizations/:id/users/:userId` are rejected with a migration response. Membership changes use `/v1/admin/organizations/:id/members/:userId`.
4. **Role transitions are enforced below routes.** Route guards provide authentication/context checks; application/domain services enforce actor/target role transitions and last-owner invariants so in-process SDK callers cannot bypass them.
5. **Tenant workflows cannot mutate global or arbitrary-tenant authorization state.** `assign_role`, `add_membership`, and `add_app_membership` are rejected for organization workflows. The seeded workflow is migrated to a safe definition or removed. Event execution also checks organization context where the event provides it.
6. **Permission policy has one runtime source.** Route and plugin checks use the DI-backed authorization domain/repository path. The legacy permission module is retained only where needed for compatibility/seed bootstrapping until its callers are migrated.
7. **Audit changes use existing schema plus structured metadata.** No audit-table migration is required in this phase. Events include actor, target, organization, action, previous state, new state, and request metadata; request/plugin context remains backward compatible.
8. **Sensitive user fields never cross an HTTP boundary.** Use the existing `toPublicUser()` projection consistently for platform and organization user responses.
9. **Resource ownership is explicit.** Organization-scoped SSO connection lookups include `orgId`; a global lookup is not used for a tenant-authorized metadata endpoint.
10. **Existing behavior that depends on unsafe writes changes immediately.** This is a security release under the supplied roadmap; migration notes must identify the replacement endpoints and workflow behavior.

## Task List

### Task 1: Add failing authorization regression tests

**Description:** Build the security test harness and reproduce the confirmed organization-role escalation, workflow escalation, last-owner bypass, cross-tenant access, and sensitive-response findings before changing production code.

**Acceptance criteria:**
- [ ] Tests cover organization admin → platform owner, organization owner → platform owner, member → platform owner, unauthorized global role modification, and cross-organization targets.
- [ ] Tests cover admin self-promotion, admin owner invitation, and last-owner demotion/removal.
- [ ] Tests cover workflow `assign_role` and cross-tenant membership attempts.
- [ ] Tests assert organization/platform user responses never contain `passwordHash`, `totpSecret`, or other internal authentication fields.
- [ ] The new tests fail against the current implementation for the expected security reasons.

**Verification:**
- [ ] `npm run build` succeeds with the new test sources.
- [ ] Focused compiled security test command runs and demonstrates the RED state.

**Dependencies:** None

**Files likely touched:**
- `src/tests/security/authorization.test.ts` (new)
- `src/tests/security/fixtures.ts` (new, if DB fixtures are needed)

**Estimated scope:** Medium

### Task 2: Quarantine organization-scoped global user mutations

**Description:** Remove global user writes and deactivation from organization routes, make the retired write contract explicit, and sanitize all organization user responses.

**Acceptance criteria:**
- [ ] Organization user PATCH/DELETE cannot modify `users.role`, profile authentication fields, or global deactivation state.
- [ ] Requests attempting the retired contract receive a clear non-success response and cannot mutate global state.
- [ ] `/organizations/:id/members`, `/users`, `/users/:userId`, and invite responses use safe public projections.
- [ ] The vulnerable route is covered by a permanent regression test.

**Verification:**
- [ ] Focused authorization tests pass.
- [ ] `npm run typecheck` passes.
- [ ] No response body contains password/TOTP secrets in the new tests.

**Dependencies:** Task 1

**Files likely touched:**
- `src/routes/admin/organizations.ts`
- `src/services/application/identity.ts` (only if safe profile contract is narrowed)
- `src/types.ts` (if the public projection type needs extension)
- `src/tests/security/authorization.test.ts`

**Estimated scope:** Small/Medium

### Task 3: Add an explicit platform-role use case and endpoint

**Description:** Separate platform role transitions from generic profile updates and expose them only through the platform-owner route.

**Acceptance criteria:**
- [ ] Platform role input accepts only `owner` or `user`.
- [ ] Only an authenticated platform owner can change a platform role.
- [ ] Organization owner/admin/member roles cannot satisfy the platform-owner policy.
- [ ] A dedicated role endpoint exists and the generic platform user PATCH rejects/strips role input rather than accepting it.
- [ ] Role changes return `Result`-consistent errors and are covered for positive and negative cases.

**Verification:**
- [ ] Focused platform-role tests pass.
- [ ] Typecheck and build pass.
- [ ] Database role remains unchanged after every denied attempt.

**Dependencies:** Tasks 1–2

**Files likely touched:**
- `src/services/domain/authorization.ts`
- `src/services/domain/identity.ts`
- `src/services/application/identity.ts`
- `src/routes/admin/platform.ts`
- `src/tests/security/authorization.test.ts`

**Estimated scope:** Medium

### Task 4: Remove role from generic identity/profile contracts

**Description:** Make the generic profile update incapable of writing a platform role, then update trusted callers to use the explicit platform-role use case where applicable.

**Acceptance criteria:**
- [ ] `UpdateUserInput`, identity domain/application methods, and the internal SDK no longer expose `role` in generic profile updates.
- [ ] Workflow, organization, and ordinary profile callers cannot smuggle a role through a shared update method.
- [ ] Setup/CLI/bootstrap writers are explicit trusted exceptions, use valid platform-role values, and have documented audit behavior.
- [ ] Type-level and runtime tests prove the generic contract cannot carry `role`.

**Verification:**
- [ ] Typecheck/build pass.
- [ ] Repository and SDK contract tests pass.
- [ ] Search confirms no organization/workflow caller uses a generic role-bearing update.

**Dependencies:** Task 3

**Files likely touched:**
- `src/repositories/types.ts`
- `src/repositories/user.ts`
- `src/services/domain/identity.ts`
- `src/sdk/types.ts`
- `src/sdk/index.ts`

**Estimated scope:** Medium

### Task 5: Enforce organization membership role invariants

**Description:** Move membership transitions through the application/domain boundary and enforce actor rank, target scope, valid roles, and last-owner protection consistently.

**Acceptance criteria:**
- [ ] Only organization owners/admins with the required permission can manage memberships.
- [ ] Organization admins cannot grant `owner`, promote themselves, or modify an owner target.
- [ ] Organization owners cannot demote/remove the sole owner.
- [ ] Membership reads and writes are always scoped by `(organizationId, userId)`.
- [ ] Invite, update, and remove operations report previous/new state to the route audit layer.

**Verification:**
- [ ] Focused membership transition tests pass for owner/admin/member combinations.
- [ ] Cross-tenant membership tests return not-found/forbidden without mutation.
- [ ] Full backend test suite passes.

**Dependencies:** Tasks 1–2

**Files likely touched:**
- `src/services/domain/organization.ts`
- `src/services/application/organization.ts`
- `src/repositories/types.ts`
- `src/repositories/organization.ts`
- `src/tests/security/authorization.test.ts`

**Estimated scope:** Medium

### Task 6: Close unsafe workflow authorization paths

**Description:** Prevent tenant-defined workflows from assigning global roles or adding memberships to arbitrary organizations, and prevent a workflow from processing events outside its tenant context.

**Acceptance criteria:**
- [ ] Unsafe step types are rejected at workflow creation/update boundaries and fail closed during execution of existing definitions.
- [ ] A workflow cannot mutate `users.role` through any built-in or plugin fallback path.
- [ ] A workflow cannot add a user to an unrelated organization by slug or application client ID.
- [ ] Event execution enforces organization matching when the workflow is organization-scoped.
- [ ] The default seed workflow is changed to a safe definition or removed.

**Verification:**
- [ ] Workflow security tests fail before the fix and pass afterward.
- [ ] Existing safe workflow steps continue to work.
- [ ] No queued test run can change a user’s platform role through a workflow.

**Dependencies:** Tasks 1 and 4

**Files likely touched:**
- `src/routes/workflows.ts`
- `src/services/workflows/engine.ts`
- `src/services/workflows/steps.ts`
- `src/db/seed.ts`
- `src/tests/security/authorization.test.ts`

**Estimated scope:** Medium

### Task 7: Centralize authorization context and guards

**Description:** Replace scattered direct role checks with explicit platform, organization, permission, and resource-scope policy functions; ensure membership is resolved from the authenticated actor rather than client-controlled app context.

**Acceptance criteria:**
- [ ] A canonical platform-role policy exists and owner-only routes use it.
- [ ] A canonical organization-role + permission policy exists and route guards use it.
- [ ] Positive permission checks work after authentication; missing organization context fails closed.
- [ ] Organization/application/resource ownership checks are explicit and reusable.
- [ ] Legacy `requireOwner`/`requireAuthAndRole` callers are migrated or reduced to compatibility wrappers without bypassing the canonical policy.
- [ ] Application-bound OAuth/OIDC and session token claims are only issued with organization context after membership verification.

**Verification:**
- [ ] Authorization context unit/integration tests pass.
- [ ] Service-account and organization route permission tests do not regress.
- [ ] Typecheck/build pass.

**Dependencies:** Tasks 3–5

**Files likely touched:**
- `src/routes/admin/helpers.ts`
- `src/plugins/appContext.ts`
- `src/plugins/permissions.ts`
- `src/services/domain/authorization.ts`
- `src/tests/security/authorization.test.ts`

**Estimated scope:** Medium

### Task 8: Enforce organization-scoped resource ownership

**Description:** Make the SAML metadata route and repository lookup require both connection ID and organization ID.

**Acceptance criteria:**
- [ ] Repository exposes an organization-scoped connection lookup.
- [ ] Metadata for a connection outside the route organization is not returned.
- [ ] Existing organization connection list/create/delete behavior remains scoped.
- [ ] Cross-tenant regression test is permanent.

**Verification:**
- [ ] Focused SSO ownership test passes.
- [ ] Typecheck/build pass.

**Dependencies:** Task 7

**Files likely touched:**
- `src/repositories/samlConnection.ts`
- `src/routes/admin/sso.ts`
- `src/tests/security/authorization.test.ts`

**Estimated scope:** Small

### Task 9: Add authorization and role-transition audit contracts

**Description:** Register explicit event types for platform-role, permission-role, and authorization-denial events, then include complete transition metadata in successful and failed operations.

**Acceptance criteria:**
- [ ] Event type unions and runtime validation agree.
- [ ] Successful platform/membership/permission transitions include actor, target, organization, action, previous state, and new state.
- [ ] Failed platform/organization/permission authorization attempts emit `unauthorized_access` without leaking sensitive request data.
- [ ] Audit tests verify event persistence/metadata and misclassified legacy events are no longer used for these transitions.

**Verification:**
- [ ] Event unit tests pass.
- [ ] Authorization integration tests confirm audit records exist.
- [ ] Full backend test suite passes.

**Dependencies:** Tasks 3, 5, and 7

**Files likely touched:**
- `src/services/events/types.ts`
- `src/services/events/validate.ts`
- `src/plugins/audit.ts`
- `src/routes/admin/platform.ts`
- `src/tests/security/authorization.test.ts`

**Estimated scope:** Medium

### Task 10: Update API/UI contracts and documentation

**Description:** Document the platform/organization role boundary, migration from retired organization user writes, workflow restrictions, API version, and frontend platform-role vocabulary.

**Acceptance criteria:**
- [ ] API reference documents the dedicated platform role endpoint and retired organization user mutation behavior.
- [ ] RBAC/security documentation explains the two role namespaces and policy order.
- [ ] Frontend platform user editor only offers `owner`/`user` and uses the dedicated endpoint.
- [ ] README, changelog, architecture/security docs, and supported-version policy are updated for v1.7.0.
- [ ] Migration notes identify all intentionally breaking security changes.

**Verification:**
- [ ] Frontend build passes.
- [ ] Documentation links resolve and version references are consistent.
- [ ] No secret or exploit detail is added to public release notes beyond safe remediation guidance.

**Dependencies:** Tasks 2–9

**Files likely touched:**
- `frontend/src/api.ts`
- `frontend/src/components/UsersPanel.tsx`
- `README.md`
- `CHANGELOG.md`
- `docs/API.md`
- `docs/SECURITY.md`
- `docs/RBAC.md` (new)
- `docs/ARCHITECTURE.md`
- `.github/SECURITY.md`

**Estimated scope:** Medium/Large; split documentation and frontend commits if needed

### Task 11: Synchronize release metadata and run quality gates

**Description:** Prepare the v1.7.0 release artifacts after implementation and verification; do not publish externally without explicit approval.

**Acceptance criteria:**
- [ ] `package.json` and `package-lock.json` report `1.7.0`.
- [ ] Typecheck, build, unit/integration/security tests, and frontend build pass.
- [ ] `npm audit` findings are triaged; any High/Critical exception has an owner, rationale, and review date.
- [ ] `npm pack --dry-run` contains no secrets, `.env` files, certificates, or temporary artifacts.
- [ ] Version consistency is checked across package metadata, docs, changelog, and planned tag.
- [ ] Any missing lint/security CI gates are explicitly resolved or documented as release blockers.

**Verification:**
- [ ] `git status` is clean except for explicitly retained user files.
- [ ] `git diff --check` passes.
- [ ] Release checklist is reviewed before tag/publish.

**Dependencies:** Tasks 1–10

**Files likely touched:**
- `package.json`
- `package-lock.json`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

**Estimated scope:** Small/Medium

### Task 12: External release checkpoint (approval required)

**Description:** Create the release commit/tag, GitHub Release, npm publication, and post-release smoke verification only after the user approves the completed local release candidate.

**Acceptance criteria:**
- [ ] User explicitly approves tag creation and remote publication.
- [ ] Tag, GitHub Release, and npm package all resolve to `1.7.0`.
- [ ] Published package installs and passes a smoke test.
- [ ] No unresolved Critical finding is released without an explicit documented exception.

**Verification:**
- [ ] Remote tag and GitHub Release verified.
- [ ] `npm install @hilbras/keystone@1.7.0` and smoke test verified.
- [ ] Post-release security check recorded.

**Dependencies:** Task 11 and explicit user approval

**Files likely touched:**
- Git metadata and release artifacts only

**Estimated scope:** External/irreversible

## Checkpoints

### Checkpoint: After Tasks 1–4

- [ ] Confirmed organization-to-platform escalation is blocked at route, service, and SDK boundaries.
- [ ] Focused security tests pass.
- [ ] No generic profile contract can carry a platform role.

### Checkpoint: After Tasks 5–8

- [ ] Membership rank, last-owner, workflow, and resource-scope invariants are enforced.
- [ ] Cross-tenant and privilege-escalation regression suite passes.
- [ ] No new direct role checks bypass the canonical policy.

### Checkpoint: After Tasks 9–11

- [ ] Audit records are complete and correctly classified.
- [ ] API/UI/docs/version metadata are synchronized.
- [ ] All local release gates are green or explicitly blocked.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Existing clients use organization user PATCH/DELETE for global account management | High | Return explicit migration errors; document replacement platform/member endpoints |
| Existing workflows contain unsafe steps | High | Reject at execution time, migrate/remove seed workflow, document data cleanup |
| Existing role-permission rows are global and unnamespaced | High | Do not silently rewrite them; protect owner mappings and defer namespace migration with a documented follow-up |
| Audit persistence is asynchronous and not transactionally coupled to mutations | Medium | Emit explicit events and test metadata; document transactional audit limitation |
| Existing High dependency advisories remain in the baseline | High | Do not hide them; resolve or document a time-bounded risk exception before release |
| Stale JWT role claims affect external consumers | Medium | Keystone reloads DB roles internally; document token-expiry/revocation behavior and track claim-hardening follow-up |
| Client-controlled application context can influence authorization | High | Resolve membership from authenticated actor and route org; fail closed when context is absent |
| No root lint command exists | Medium | Add a real gate or explicitly block release; do not label typecheck as lint |

## Open Decisions / Release Blockers

1. Whether to backport the existing High dependency remediation scheduled for Phase 5, or issue a documented, time-bounded exception for v1.7.0.
2. Whether to add a real linter and security-audit CI gate in this release, despite Phase 13 also planning broader quality gates.
3. How npm publication is performed from the release workflow; the current workflow creates GitHub/Docker artifacts but has no npm publish job and the repository currently has no configured GitHub npm secret.
4. Whether the supplied `plan.md` is the authoritative roadmap over the older root `ROADMAP.md`; this plan treats `plan.md` as authoritative because the user explicitly selected it.

## Review Remediation: Confirmed Bypasses Found After Initial Slice

The first implementation slice passed its focused tests but an adversarial review identified paths below the HTTP boundary and adjacent response leaks. These are part of Phase 1 because they can produce the same privilege escalation or credential disclosure.

### Task 13: Enforce a closed workflow step contract

- Replace the three-name denylist with a tenant-safe allowlist.
- Reject unknown/plugin alias steps at creation and execution.
- Block `create_organization` until organization creation has an owner and trusted actor.
- Restrict global workflows to platform owners; require membership for organization workflows.
- Add regression tests for plugin aliases, global workflow access, and malformed definitions.

### Task 14: Remove actorless global mutation APIs

- Make identity deactivation require a platform-owner actor and protect the last owner.
- Remove or make private the organization-domain global deactivation/removal helpers.
- Require an owner user whenever an organization is created, including SDK/CLI paths.
- Audit trusted bootstrap, CLI, seed, and SSO membership transitions.

### Task 15: Enforce application-layer permissions and scoped SDK authorization

- Require organization permissions in application services, not only route pre-handlers.
- Replace actorless authorization SDK methods with actor-plus-organization methods.
- Add revoked-permission and cross-tenant direct-SDK tests.

### Task 6A: Make owner invariants atomic

- Lock owner rows during platform-role and organization-membership transitions.
- Reject concurrent last-owner demotion/removal with a stable error.
- Add concurrent transition tests.

### Task 16: Enforce runtime role vocabularies and namespace boundaries

- Validate repository-level role writes at runtime.
- Reject custom/unknown permission role names and protect organization-owner mappings.
- Normalize or reject legacy invalid platform roles before token issuance.
- Remove the invalid `viewer` default role.

### Task 17: Close secret and configuration response leaks

- Project application, OIDC, and API-key responses through safe DTOs.
- Return OIDC/API-key plaintext credentials only once at creation.
- Redact configuration/profile values and remove arbitrary public metadata.
- Add response-leak regression tests.

### Task 18: Repair audit contracts and transition writers

- Synchronize `AuditEventType` and runtime validation.
- Emit denial/transition events from service-level denials and trusted writers.
- Record organization membership role separately from platform role in member lists.
- Add audit tests for each transition source.

### Task 19: Complete frontend and release contract follow-up

- Make organization selectors available to organization owners.
- Remove unsupported custom-role messaging and unsafe workflow controls.
- Preserve trusted API-key organization context.
- Update docs and rerun release gates.


- [ ] Every confirmed Critical/High Phase 1 finding has a fix and permanent regression test.
- [ ] No organization membership role can modify a platform role.
- [ ] No tenant workflow can modify platform or unrelated-tenant authorization state.
- [ ] No user response exposes password/TOTP secrets.
- [ ] Authorization policy is centralized and audited.
- [ ] Documentation, version metadata, tests, and release artifacts are synchronized.
- [ ] External release actions occur only with explicit approval.
