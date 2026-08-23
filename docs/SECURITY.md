# Keystone Security

This document outlines the security model and operational practices for Hilbras Keystone.

## Authentication

- **Passwords** are hashed with **argon2id** (OWASP-recommended parameters). Legacy deployments that used scrypt can still verify existing hashes; new hashes always use argon2id.
- **Multi-factor authentication** is supported through TOTP and WebAuthn/Passkeys.
- **Social and enterprise login** is handled by connectors that normalize profile data. Keystone acts as the identity broker and issues its own tokens.
- **Enterprise SSO** uses OIDC or SAML. SAML responses are validated with `samlify`, including XML signature verification.

## Tokens

- **Access tokens** are short-lived RS256-signed JWTs.
- **Refresh tokens** are opaque, rotated on use, and stored as SHA-256 hashes.
- **API keys** are opaque, prefix-searchable, and hashed at rest.
- **JWT signing keys** are rotatable. The JWKS endpoint publishes the active key plus recently rotated keys for a 24-hour grace period.
- **Cookies** use `HttpOnly`, `Secure` (configurable), and `SameSite=lax`.

## Authorization

- RBAC permissions are checked through `/v1/authz/check`.
- Permissions can be scoped to organizations and applications.
- Future releases will support ABAC and custom policy plugins.

## Secrets

The secrets provider abstraction stores:

- JWT signing and encryption keys
- API keys and client secrets
- Password hashes

Default provider stores secrets in PostgreSQL. Production deployments should use `EnvironmentSecretsProvider` or an enterprise backend (AWS KMS, HashiCorp Vault, Azure Key Vault) via plugin.

## Rate limiting

A Redis-backed sliding-window rate limiter protects authentication and public endpoints. It returns `429 Too Many Requests` with a `Retry-After` header. It fails open if Redis is unreachable.

## Audit and monitoring

Every security-relevant action emits a versioned event:

- `user_registered`, `user_login`, `user_login_failed`
- `oauth_callback`, `saml_sso_login`, `oidc_enterprise_login`
- `api_key_created`, `api_key_revoked`
- `authz_check`, `password_reset_requested`, `password_reset_completed`

Events are written to the audit log, exported to webhooks, and consumed by anomaly detection.

## Reporting vulnerabilities

If you discover a security issue, please report it privately to the Hilbras security team. Do not open a public issue until a fix is released.
