# Changelog

All notable changes to Hilbras Keystone are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-23

First stable release of Hilbras Keystone, a standalone, API-first identity platform.

### Added

- **Authentication** — password (argon2id), magic links, social OAuth, enterprise SAML/OIDC,
  WebAuthn (passkeys), TOTP with backup codes, and SMS OTP.
- **Token issuance** — RSA-signed JWT access tokens, rotating refresh tokens, and API keys
  with hashing at rest.
- **OAuth 2.0 / OIDC provider** — `/oauth2/authorize`, `/oauth2/token`, `/oauth2/userinfo`,
  consent management, token revocation, and JWKS discovery at `/.well-known/jwks.json`.
- **Authorization** — RBAC/ABAC policy checks via `POST /v1/authz/check`, custom
  permissions, and role permission mapping.
- **Organizations & applications** — multi-tenant orgs, membership, per-application
  client credentials, branding, and service accounts.
- **Admin API** — platform users/orgs/apps, audit log export, usage metrics, security
  summary, queue introspection and retries, webhook management with delivery retries,
  signing-key rotation, plugin registry, feature flags, configuration profiles, and billing plans.
- **SCIM 2.0** — user and group provisioning (`/scim/v2/*`).
- **Event bus** — versioned domain events with subscribers for audit logging, webhooks,
  and anomaly detection.
- **Workflows** — configurable automation steps (email, SMS, webhooks) triggered by events.
- **Background jobs** — Redis/BullMQ-backed queue abstraction with failure retry endpoints.
- **Audit logging** — structured audit trail with CSV export and retention controls.
- **Setup wizard & admin dashboard** — React + Vite frontend with first-run setup server
  (`KEYSTONE_SETUP_MODE=true`) and post-setup administration UI.
- **SDKs** — `@hilbras/keystone-sdk` (browser drop-in, ESM/CJS/IIFE builds),
  `@hilbras/keystone-node`, `@hilbras/keystone-react`, `@hilbras/keystone-vue`,
  and `@hilbras/keystone-cli`.
- **Observability** — OpenTelemetry auto-instrumentation, Prometheus `/metrics`,
  health diagnostics, and Swagger UI at `/documentation`.
- **Deployment** — Docker Compose production stack, Kubernetes manifests with Kustomize
  base, systemd unit, and one-command installer scripts.

[1.0.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.0.0
