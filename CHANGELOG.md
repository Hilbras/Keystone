# Changelog

All notable changes to Hilbras Keystone are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.2.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.2.0
[1.1.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.1.0
[1.0.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.0.0
