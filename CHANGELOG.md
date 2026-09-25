# Changelog

All notable changes to Hilbras Keystone are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [1.4.0] - 2026-09-20

Fastify ecosystem upgrades — all plugins updated to latest major versions.

### Changed

- **fastify-plugin** 5.1.0 → 6.0.0
- **@fastify/cookie** 10.0.1 → 11.1.2
- **@fastify/cors** 10.1.0 → 11.3.0
- **@fastify/static** 8.3.0 → 10.1.4
- **@fastify/swagger-ui** 5.2.6 → 6.1.1

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
