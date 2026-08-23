# Keystone Roadmap

This roadmap captures completed milestones and planned work. It is ordered by priority and dependency.

## Completed

1. **Local password reset** — token-based password reset independent of Zitadel, with email queued for delivery.
2. **BullMQ background queue** — durable Redis-backed queue for email, webhooks, and workflows.
3. **Sanitized OAuth/Federation errors** — centralized error helper that exposes only opaque public codes.
4. **Distributed Redis rate limiting** — atomic sliding-window rate limiter with `Retry-After`.
5. **JWT key rotation grace period** — JWKS publishes active + recently rotated keys for 24 hours.
6. **Argon2id password hashing** — new hashes use argon2id; legacy scrypt hashes remain verifiable.
7. **Real email/SMS providers** — SMTP, SendGrid, Mailgun, and Twilio.
8. **Full SAML signature validation** — SAML responses validated through `samlify`.
9. **Integration tests + CI** — GitHub Actions job with Postgres/Redis services and a BullMQ integration test.
10. **CLI enhancements** — `user:create`, `keys:list`, `config:validate`, `org:create`.
11. **Backend setup endpoints** — `/setup/status` and `/setup/init` for fresh installations.
12. **Standalone setup frontend** — React + Vite wizard with Playwright E2E tests.

## Near term

- **Audit log UI and export** — paginated admin API, CSV export, SIEM-friendly streaming.
- **Organization-level SSO** — self-service OIDC and SAML connection configuration.
- **Branding and email templates** — customizable email HTML and sender identity per organization.
- **Session management** — list and revoke active sessions per user.
- **Webhook reliability** — retries, signatures, and delivery logs.

## Mid term

- **Multi-region replication** — read replicas, geo-distributed signing keys.
- **Advanced authorization** — attribute-based access control (ABAC) and custom policy plugins.
- **User impersonation** — secure admin impersonation with full audit trail.
- **SCIM provisioning** — inbound/outbound user and group provisioning.
- **Billing integration hooks** — seat-count events and plan enforcement.

## Long term

- **FIDO2/WebAuthn passkeys as primary auth** — passwordless-first flows.
- **Device trust and risk-based authentication** — risk scoring from anomaly detection.
- **Keystone Operator for Kubernetes** — automated deployments, certificate rotation, and backups.
