# Keystone Security

This document outlines the security model and operational practices for Hilbras Keystone.

## Authentication

- **Passwords** are hashed with **argon2id** (OWASP-recommended parameters). Legacy deployments that used scrypt can still verify existing hashes; new hashes always use argon2id.
- **Multi-factor authentication** is supported through TOTP and WebAuthn/Passkeys.
- **Social and enterprise login** is handled by connectors that normalize profile data. Keystone acts as the identity broker and issues its own tokens.
- **Enterprise SSO** uses OIDC or SAML. SAML responses are schema-validated with the configured `xmllint` validator and signature-verified; OIDC ID tokens are verified against the connection JWKS and issuer/audience. Existing enterprise users must already be organization members before an SSO callback can link them.

## Tokens

- **Access tokens** are short-lived RS256-signed JWTs.
- **Refresh tokens** are opaque, rotated on use, and stored as SHA-256 hashes. Rotation is an atomic conditional claim and is bound to the originating client/application and organization.
- **API keys** are opaque, prefix-searchable, and hashed at rest.
- **JWT signing keys** are rotatable. The JWKS endpoint publishes the active key plus recently rotated keys for a 24-hour grace period.
- **Cookies** use `HttpOnly`, `Secure` (configurable), and `SameSite=lax`.
- Configuration and profile responses redact secret-like values before leaving the API; raw database URLs, credentials, signing keys, and provider secrets are not returned.
- SAML RelayState is bound to a short-lived, one-time Redis transaction and initiating browser cookie; production requires a high-entropy `KEYSTONE_INTERNAL_API_KEY`.
- Deactivated users are rejected by password, token, API-key, refresh, magic-link, WebAuthn, OAuth, SAML, and OIDC authentication; deactivation revokes refresh tokens, sessions, and user API keys. Ambiguous legacy unverified accounts are quarantined with `account_review_required` during migration.

## Authorization

- Platform roles are exactly `owner` and `user`; organization roles are exactly `owner`, `admin`, and `member`.
- The namespaces are independent. Organization membership never grants platform-owner access.
- Platform role changes use the dedicated owner-only endpoint `PATCH /v1/admin/platform/users/:userId/role`.
- Organization member APIs may change only `organizationMembership.role`; global account writes and deactivation are rejected.
- Organization permission checks resolve the authenticated actor and route organization explicitly. Client-controlled application/origin context is not an authorization decision.
- `/v1/authz/check` requires an explicit `organizationId` and fails closed when the actor is not a member.
- OIDC/SAML endpoint configuration rejects local/private targets by default; private enterprise endpoints require an explicit deployment opt-in and outbound fetches reject redirects.
- The last platform owner and the last organization owner cannot be demoted.
- Tenant workflows cannot assign roles or add memberships across organizations, cannot be registered or executed by actors lacking workflow-management permission, and are blocked when inactive.
- See [RBAC.md](RBAC.md) for the role matrix and migration guidance.

## Secrets

The secrets provider abstraction stores:

- JWT signing and encryption keys
- API keys and client secrets
- Password hashes

Default provider stores secrets in PostgreSQL. Production deployments should use `EnvironmentSecretsProvider` or an enterprise backend (AWS KMS, HashiCorp Vault, Azure Key Vault) via plugin.

## User data exposure

Administrative and organization user responses use a redacted public projection. Password hashes, TOTP secrets, setup tokens, and sensitive metadata are never returned by user-management endpoints. Treat any client that depends on those fields as requiring a separate, explicitly authorized migration.

## Rate limiting

A Redis-backed sliding-window rate limiter protects authentication and public endpoints. It returns `429 Too Many Requests` with a `Retry-After` header. It fails open if Redis is unreachable.

## Audit and monitoring

Every security-relevant action emits a versioned event:

- `user_registered`, `user_login`, `user_login_failed`
- `oauth_callback`, `saml_sso_login`, `oidc_enterprise_login`
- `api_key_created`, `api_key_revoked`
- `authz_check`, `password_reset_requested`, `password_reset_completed`
- `platform_role_changed`, `organization_member_role_updated`, `organization_member_invited`, `organization_member_removed`
- `permission_role_updated`, `workflow_blocked`, `unauthorized_access`, `api_key_used`

Events are written to the audit log, exported to webhooks, and consumed by anomaly detection. Authorization transitions include actor, target, organization, previous/new state, request ID, IP address, and user agent where available. Audit persistence is asynchronous; production deployments should monitor subscriber failures.

## Reporting vulnerabilities

If you discover a security issue, please report it privately to the Hilbras security team. Do not open a public issue until a fix is released.
