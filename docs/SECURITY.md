# Keystone Security

This document outlines the security model and operational practices for Hilbras Keystone.

## Authentication

- **Passwords** are hashed with **argon2id** (OWASP-recommended parameters). Legacy deployments that used scrypt can still verify existing hashes; new hashes always use argon2id.
- **Multi-factor authentication** is mandatory for any user with TOTP enabled. Password authentication stops at `requires_mfa` and issues no access token, refresh token, or session; only `POST /auth/mfa/verify` completes the transition to `authenticated`.
- MFA challenges are opaque, stored only as a hash, short-lived (`MFA_CHALLENGE_TTL_SECONDS`, default 300), and single-use. Each state change is a conditional database update, so concurrent verification has exactly one winner. Starting a new password step supersedes any outstanding challenge.
- TOTP codes are verified against the user's own decrypted secret. Each time-step is accepted once — a captured code is rejected even against a freshly issued challenge.
- Backup codes carry 80 bits of entropy, are stored as a keyed (peppered) hash, expire after `TOTP_BACKUP_CODE_TTL_SECONDS` (default 90 days), and are consumed by a conditional update so a code can never be used twice.
- TOTP secrets are encrypted with AES-256-GCM. Values written by earlier versions used AES-256-CBC and remain readable so enrolled authenticators survive the upgrade.
- Token issuance is guarded at a single chokepoint: a token cannot be minted for an MFA-enabled user without a recorded factor, so no login path can bypass MFA by omission. WebAuthn assertions satisfy the requirement on their own; magic links refuse to downgrade a TOTP-protected account, and SAML, enterprise OIDC, federation, and OAuth2 report a typed `mfa_required` error.
- Sessions record the factor that satisfied MFA. Refresh rotation refuses sessions with no recorded factor, and enabling MFA revokes every existing refresh token and session for the account.
- A verified WebAuthn assertion also satisfies the MFA requirement, so a passkey sign-in does not additionally require a TOTP code. A passkey registered *after* TOTP was enabled does not: it is a single factor, and sign-in is refused. Registering a passkey on a TOTP-protected account requires the account password.
- Changing how an account proves its identity — enrolling, confirming, regenerating backup codes for, or disabling TOTP — requires step-up: the account password in addition to the session. A stolen access token must not be enough to take over an account's second factor.
- Failed MFA factor attempts count toward the account lockout, so a stolen password cannot be brute-forced through the slower MFA step.
- **Social and enterprise login** is handled by connectors that normalize profile data. Keystone acts as the identity broker and issues its own tokens.
- **Enterprise SSO** uses OIDC or SAML. SAML responses are schema-validated with the configured `xmllint` validator, signature-verified, and checked for audience, destination, and subject recipient. OIDC ID tokens are verified against the connection JWKS and issuer/audience. Existing enterprise users require an explicit `(connection, subject)` identity link and organization membership; platform owners cannot authenticate through tenant SSO.
- Generic OAuth requires a provider-verified email and never treats email equality alone as an identity link.

## Tokens

- **Access tokens** are short-lived RS256-signed JWTs. Sessions that completed MFA carry `mfa_verified`, `mfa_factor`, and an `amr` list so relying parties can assert the authentication method used.
- **Refresh tokens** are opaque, rotated on use, and stored as SHA-256 hashes. Rotation validates client, application, membership, and account state before an atomic conditional claim, so a wrong-client request cannot burn a valid token.
- **API keys** are opaque, prefix-searchable, and hashed at rest.
- **JWT signing keys** are rotatable. The JWKS endpoint publishes the active key plus recently rotated keys for a 24-hour grace period.
- **Cookies** use `HttpOnly`, `Secure` (configurable), and `SameSite=lax`.
- SCIM credentials are per-organization. Every connection belongs to exactly one organization, at most one connection is live per organization, and every user and group read and write is filtered by that organization. A cross-tenant target returns `404`, not `403`, so the endpoint is not a tenant oracle.
- SCIM bearer tokens are stored only as a SHA-256 digest and resolved by that digest, so a database dump yields no usable token and the comparison carries no timing signal. Tokens can expire, be rotated, and be revoked. Rotation invalidates the old token immediately unless an explicit grace window is requested — a grace window is a continuity aid, not a revocation.
- Issuing, rotating, and revoking a SCIM credential is owner-only; a SCIM token can provision and deactivate tenant users, so a mere admin or member must not be able to mint one.
- A user row is global, so deprovisioning removes the organization's membership first and deactivates the account only once no membership remains. SCIM refuses to change global attributes of a user who also belongs to another organization, and refuses to reactivate a shared account.
- SCIM cannot remove the last owner of an organization, and never modifies platform owners or accounts pending platform review.
- SCIM audit rows record the connection id and organization for every mutation, and credential lifecycle transitions emit `scim_connection_created`, `scim_connection_rotated`, and `scim_connection_revoked`. Rejected requests emit `scim_access_denied` and `scim_authentication_failed`.
- `SCIM_BEARER_TOKEN` and `SCIM_ORG_ID` are deprecated. They are adopted once into a connection at startup and then ignored, so removing them does not affect an adopted credential; revoke through the connection API instead.
- Configuration and profile responses redact secret-like values before leaving the API; raw database URLs, credentials, signing keys, provider secrets, SCIM tokens, Vault tokens, and generic `*_CLIENT_SECRET` values are not returned.
- SAML RelayState is bound to a short-lived, one-time Redis transaction and initiating browser cookie; production requires a high-entropy `KEYSTONE_INTERNAL_API_KEY`.
- Deactivated users are rejected by password, token, API-key, refresh, magic-link, WebAuthn, OAuth, SAML, and OIDC authentication; deactivation revokes refresh tokens, sessions, and user API keys. Ambiguous legacy unverified accounts are quarantined with `account_review_required` during migration.

## Authorization

- Platform roles are exactly `owner` and `user`; organization roles are exactly `owner`, `admin`, and `member`.
- The namespaces are independent. Organization membership never grants platform-owner access.
- Platform role changes use the dedicated owner-only endpoint `PATCH /v1/admin/platform/users/:userId/role`.
- Organization member APIs may change only `organizationMembership.role`; global account writes and deactivation are rejected.
- Organization permission checks resolve the authenticated actor and route organization explicitly. Client-controlled application/origin context is not an authorization decision.
- `/v1/authz/check` requires an explicit `organizationId` and fails closed when the actor is not a member.
- OIDC/SAML endpoint configuration rejects local/private targets by default, including hex-form IPv4-mapped IPv6; private enterprise endpoints require an explicit deployment opt-in and outbound fetches pin DNS answers and reject redirects.
- The last platform owner and the last organization owner cannot be demoted.
- Tenant workflows cannot assign roles or add memberships across organizations, cannot be registered or executed by actors lacking current workflow-management permission, and are blocked when inactive. Out-of-scope events do not create durable workflow runs.
- See [RBAC.md](RBAC.md) for the role matrix and migration guidance.

## Secrets

The secrets provider abstraction stores:

- JWT signing and encryption keys
- API keys and client secrets
- Password hashes

Default provider stores secrets in PostgreSQL. Production deployments should use `EnvironmentSecretsProvider` or an enterprise backend (AWS KMS, HashiCorp Vault, Azure Key Vault) via plugin.

## User data exposure

Administrative and organization user responses use a redacted public projection. Password hashes, TOTP secrets, setup tokens, and sensitive metadata are never returned by user-management endpoints. Self-service profile responses may return the authenticated user's own metadata, but API-key validation and cross-principal projections never do. Treat any client that depends on administrative metadata fields as requiring a separate, explicitly authorized migration.

## Rate limiting

A Redis-backed sliding-window rate limiter protects authentication and public endpoints. It returns `429 Too Many Requests` with a `Retry-After` header. It fails open if Redis is unreachable.

SCIM carries two budgets: one keyed on the authenticated credential, so one noisy identity provider cannot exhaust every other tenant's allowance, and an address-keyed budget in front of the authentication hook, because that hook runs before the credential limiter and emits audit and webhook events on failure.

MFA verification does not rely on that limiter alone: every challenge carries its own attempt budget (`MFA_MAX_ATTEMPTS`, default 5) enforced in the database, so attempts are counted even when Redis is unavailable. Factor management endpoints (`/auth/totp/*`) have dedicated budgets separate from login.

## Audit and monitoring

Every security-relevant action emits a versioned event:

- `user_registered`, `user_login`, `user_login_failed`
- `mfa_challenge_created`, `mfa_challenge_failed`, `mfa_challenge_expired`, `mfa_challenge_rejected`, `mfa_verified`, `mfa_bypass_blocked`, `mfa_backup_code_regenerated`
- `scim_connection_created`, `scim_connection_rotated`, `scim_connection_revoked`, `scim_access_denied`, `scim_authentication_failed`, `scim_group_created`, `scim_group_updated`, `scim_group_deleted`
- `oauth_callback`, `saml_sso_login`, `oidc_enterprise_login`
- `api_key_created`, `api_key_revoked`
- `authz_check`, `password_reset_requested`, `password_reset_completed`
- `platform_role_changed`, `organization_member_role_updated`, `organization_member_invited`, `organization_member_removed`
- `permission_role_updated`, `workflow_blocked`, `unauthorized_access`, `api_key_used`, `oauth2_refresh`, `oauth2_refresh_failed`; refresh, OAuth, SCIM, and API-key mutations carry server-derived actor and tenant attribution.

Events are written to the audit log, exported to webhooks, and consumed by anomaly detection. Authorization transitions include actor, target, organization, previous/new state, request ID, IP address, and user agent where available. Audit persistence is asynchronous; production deployments should monitor subscriber failures.

## Reporting vulnerabilities

If you discover a security issue, please report it privately to the Hilbras security team. Do not open a public issue until a fix is released.
