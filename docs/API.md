# Hilbras Keystone — HTTP API Reference

Version 1.7.0

Every route also ships an interactive OpenAPI description served by the API itself:

- **Swagger UI:** `GET /documentation`
- **OpenAPI JSON:** `GET /documentation/json`

Unless stated otherwise, endpoints are served by the main API process
(`KEYSTONE_SETUP_MODE` unset). The first-run **setup server** exposes its own
smaller surface under `/setup/*` and is documented at the end.

## Authentication schemes

| Scheme | How | Used for |
| --- | --- | --- |
| Session cookie | Set by `POST /auth/login`, `register`, `token-login` | Browser flows |
| Bearer access token | `Authorization: Bearer <access_token>` (RS256 JWT) | APIs, SPAs |
| API key | `Authorization: Bearer <api_key>` or `x-api-key: <api_key>` | Machine-to-machine |

Endpoints marked **auth** accept any authenticated principal (session or bearer).
Endpoints marked **owner** additionally require the platform-owner role.

## Conventions

- All bodies and responses are JSON.
- Errors return `{ "error": string, ...details }` with an appropriate HTTP status
  (`400` validation, `401` unauthenticated, `403` forbidden, `404` missing,
  `409` conflict, `429` rate-limited).
- Refresh tokens rotate on every use; a replayed token revokes the session chain.

---

## Discovery & operations

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/.well-known/jwks.json` | public | RSA public keys for verifying access tokens (JWKS) |
| GET | `/documentation` | public | Swagger UI |
| GET | `/documentation/json` | public | OpenAPI document |
| GET | `/metrics` | public* | Prometheus metrics (*restrict via reverse proxy in production) |

---

## Core authentication — `/auth`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/register` | public | Create an account; sets session cookies |
| POST | `/auth/login` | public | Password login; sets cookies, returns tokens + user |
| POST | `/auth/token-login` | public | Exchange a one-time token (e.g. magic link) for a session |
| GET | `/auth/me` | auth | Current user profile with roles/memberships |
| POST | `/auth/refresh` | refresh cookie/body | Rotate refresh token, issue new access token |
| POST | `/auth/logout` | refresh cookie/body | Revoke refresh token, clear cookies |

### Sessions

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/auth/sessions` | auth | List active sessions for current user |
| DELETE | `/auth/sessions/:id` | auth | Revoke one session |
| POST | `/auth/sessions/revoke-all` | auth | Revoke every session of current user |

### Profile

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/auth/profile` | auth | Full profile of current user |
| PATCH | `/auth/profile` | auth | Update name, username, avatar, password change, etc. |

### Email verification

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/email-verification/send` | auth | Send verification email to signed-in address |
| POST | `/auth/email-verification/request` | public | Request verification email by email address |
| GET | `/auth/email-verification/verify` | public | Verify with `token` query parameter |

### Password recovery

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/forgot-password` | public | Send password-reset email |
| POST | `/auth/reset-password` | public | Reset password with `token` + new password |

### Magic links

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/magic-link/send` | public | Email a sign-in link |
| GET | `/auth/magic-link/verify` | public | Consume link token, establish session |

### TOTP (authenticator apps)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/totp/enroll` | auth | Begin enrollment, returns otpauth URI + QR secret |
| POST | `/auth/totp/backup` | auth | Generate backup codes |
| POST | `/auth/totp/verify` | varies | Verify TOTP/backup code during login challenge |
| POST | `/auth/totp/disable` | auth+code | Disable TOTP after code confirmation |

### WebAuthn / passkeys

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/auth/webauthn/register/options` | auth | PublicKeyCredentialCreationOptions |
| POST | `/auth/webauthn/register/verify` | auth | Attestation verification, stores credential |
| POST | `/auth/webauthn/authenticate/options` | public | Assertion options for a username/discoverable flow |
| POST | `/auth/webauthn/authenticate/verify` | public | Verify assertion, establish session |

### SMS OTP

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/sms-otp/send` | public | Send one-time code to phone number |
| POST | `/auth/sms-otp/verify` | public | Verify code, establish session |

### Social OAuth

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/auth/oauth/:provider` | public | Redirect to provider (google, github, …) |
| GET | `/auth/callback/:provider` | public | Provider callback; links/creates account, sets session |

### API keys

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/api-keys` | auth | Create API key (returned once, hashed at rest) |
| GET | `/auth/api-keys` | auth | List caller's API keys (metadata only) |
| DELETE | `/auth/api-keys/:id` | auth | Revoke an API key |
| GET | `/auth/validate` | auth or API key | Validate current credentials, returns principal info |

---

## OAuth 2.0 provider — `/oauth2`

Hilbras Keystone acts as an authorization server for first-party and third-party apps.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/oauth2/authorize` | session | Authorization endpoint (`response_type=code`, PKCE supported) |
| POST | `/oauth2/token` | client creds | Token exchange: `authorization_code`, `refresh_token`, `client_credentials` |
| GET | `/oauth2/userinfo` | auth | OpenID Connect userinfo claims |
| POST | `/oauth2/revoke` | public | RFC 7009 token revocation |
| POST | `/oauth2/consent` | auth | Grant or withdraw consent for an application's scopes |

---

## Authorization check

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/v1/authz/check` | auth | Evaluate organization RBAC: `{ organizationId, action, resource }` → `{ allowed }` |

`organizationId` is required. Keystone resolves the authenticated user's membership for that organization and returns `403` when the actor is not a member.

---

## Federation (social identity connectors) — `/federation`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/federation/providers` | public | Enabled connectors for the requesting app |
| GET | `/federation/:provider/start` | public | Begin federated sign-in for a connector |
| GET | `/federation/:provider/callback` | public | Connector callback |
| GET | `/federation/identities` | auth | External identities linked to current user |

---

## Enterprise SSO — `/sso`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/sso/saml/:connectionId?orgId=:organizationId` | public | Start SAML login for a connection (organization-scoped) |
| POST | `/sso/saml/acs` | public | SAML Assertion Consumer Service; signed RelayState binds the organization |
| GET | `/sso/saml/:connectionId/metadata?orgId=:organizationId` | public | Organization-scoped SAML metadata XML |
| GET | `/sso/sso/oidc/:connectionId?orgId=:organizationId` | public | Start organization-scoped enterprise OIDC login |
| GET | `/sso/sso/oidc/:connectionId/callback?orgId=:organizationId` | public | Enterprise OIDC callback; state binds the organization |

> ⚠️ Note the doubled `/sso/sso/oidc` segment — the OIDC enterprise routes declare
> `/sso/oidc/...` paths *and* are mounted under the `/sso` prefix. This is slated
> for normalization in a future minor release.

## SCIM 2.0 provisioning — `/scim/v2`

Authenticated per connection token (HTTP basic/bearer issued to the IdP).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/scim/v2/Users` | List users (filtering, pagination) |
| GET | `/scim/v2/Users/:userId` | Fetch user |
| POST | `/scim/v2/Users` | Provision user |
| PUT | `/scim/v2/Users/:userId` | Replace user |
| DELETE | `/scim/v2/Users/:userId` | Deprovision user |
| GET | `/scim/v2/Groups` | List groups |

---

## Admin API — `/v1/admin`

Most platform endpoints require the **owner** role. Organization and role reads
are available to any authenticated member.

### Platform

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/admin/platform/users` | owner | Redacted public users across orgs |
| PATCH | `/v1/admin/platform/users/:id` | owner | Update non-role platform user fields |
| PATCH | `/v1/admin/platform/users/:id/role` | owner | Change platform role (`owner` or `user`) |
| DELETE | `/v1/admin/platform/users/:id` | owner | Deactivate account and revoke sessions/tokens/API keys |
| GET | `/v1/admin/platform/organizations` | owner | All organizations |
| GET | `/v1/admin/platform/applications` | owner | All applications |
| GET | `/v1/admin/platform/audit-logs` | owner | Query audit trail |
| GET | `/v1/admin/platform/audit-logs/export` | owner | Export audit logs (CSV) |
| GET | `/v1/admin/platform/metrics/usage` | owner | Usage metrics |
| GET | `/v1/admin/platform/security-summary` | owner | Security posture snapshot |
| GET | `/v1/admin/platform/queue` | owner | Background queue stats |
| GET | `/v1/admin/platform/queue/failed` | owner | Failed jobs |
| POST | `/v1/admin/platform/queue/failed/:id/retry` | owner | Retry failed job |
| POST | `/v1/admin/platform/queue/retry-all` | owner | Retry all failed jobs |
| GET | `/v1/admin/platform/webhooks` | owner | List webhooks |
| POST | `/v1/admin/platform/webhooks` | owner | Create webhook |
| PATCH | `/v1/admin/platform/webhooks/:id` | owner | Update webhook |
| DELETE | `/v1/admin/platform/webhooks/:id` | owner | Delete webhook |
| POST | `/v1/admin/platform/webhooks/:id/rotate-secret` | owner | Rotate signing secret |
| GET | `/v1/admin/platform/webhooks/:id/deliveries` | owner | Delivery history |
| POST | `/v1/admin/platform/webhook-deliveries/:id/retry` | owner | Redeliver webhook |
| GET | `/v1/admin/platform/keys` | owner | Signing key metadata |
| POST | `/v1/admin/platform/keys/rotate` | owner | Rotate JWT signing keys |
| GET | `/v1/admin/platform/plugins` | owner | Installed plugins |
| GET | `/v1/admin/platform/plugins/extensions` | owner | Plugin extension points |
| DELETE | `/v1/admin/platform/plugins/:name` | owner | Uninstall plugin |
| GET | `/v1/admin/platform/feature-flags` | owner | Feature flags |
| GET | `/v1/admin/platform/feature-flags/:key` | owner | Single flag |
| DELETE | `/v1/admin/platform/feature-flags/:key` | owner | Delete flag |
| GET | `/v1/admin/platform/configuration-profiles` | owner | Saved configuration profiles |
| GET | `/v1/admin/platform/configuration-profiles/:id` | owner | Profile detail |

### Organizations, roles, service accounts

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/admin/organizations` | auth | Organizations of current user |
| GET | `/v1/admin/organizations/:id` | auth | Org detail (members, apps) |
| POST | `/v1/admin/organizations/:id/invites` | org owner/admin | Invite a member with an organization role |
| GET | `/v1/admin/organizations/:id/members` | org member | Redacted members with `membershipRole` and separate `platformRole` fields |
| PATCH/DELETE | `/v1/admin/organizations/:id/members/:userId` | org owner/admin | Change/remove an organization membership |
| GET | `/v1/admin/organizations/:id/users` | org member | Redacted organization users |
| GET | `/v1/admin/organizations/:id/users/:userId` | org member | Redacted organization user |
| GET | `/v1/admin/permissions` | owner | Effective permission catalog |
| POST | `/v1/admin/permissions` | owner | Create custom permission |
| DELETE | `/v1/admin/permissions/:id` | owner | Delete custom permission |
| GET | `/v1/admin/roles` | owner | Built-in organization role catalog |
| GET | `/v1/admin/roles/:role/permissions` | owner | Permissions mapped to an organization role |
| POST | `/v1/admin/organizations/:id/service-accounts` | org permission | Create service account |
| GET | `/v1/admin/organizations/:id/service-accounts` | org permission | List service accounts |
| GET | `/v1/admin/organizations/:id/service-accounts/:accountId` | org permission | Service account detail |
| PATCH | `/v1/admin/organizations/:id/service-accounts/:accountId` | org permission | Update service account |
| POST | `/v1/admin/organizations/:id/service-accounts/:accountId/api-keys` | org permission | Issue API key for service account |

Organization user PATCH/DELETE routes are retained only as explicit migration tombstones (`410`) for clients that used them to mutate global accounts. Use platform user administration for account-wide changes and `/members/:userId` for organization roles.

### Workflows

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/admin/workflows?orgId=:organizationId` | org member | List organization workflows |
| POST | `/v1/admin/workflows` | org owner/admin | Create workflow with safe email steps and an `orgId` |
| GET | `/v1/admin/workflows/:id` | org member / platform owner for global | Workflow detail |
| DELETE | `/v1/admin/workflows/:id` | org owner/admin / platform owner for global | Remove workflow |
| GET | `/v1/admin/workflows/:id/runs` | org member / platform owner for global | Execution history |

### Billing & runtime configuration

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/admin/billing/plans` | auth | Available plans |
| GET | `/v1/admin/config` | owner | Redacted runtime configuration view |
| PUT | `/v1/admin/config` | owner | Update configuration |
| POST | `/v1/admin/config/restart` | owner | Graceful restart of services |

---

## SDK serving — `/sdk`

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/sdk/keystone-dropin.js` | public | Drop-in browser widget (self-hosted build) |
| GET | `/sdk/keystone-dropin.js.sri` | public | Subresource-integrity hash for the drop-in |
| GET | `/sdk/branding/:clientId` | public | Per-application branding payload |
| POST | `/sdk/connect` | owner | Handshake used by embedded SDK components |

---

## Setup server (first-run wizard)

Enabled by starting with `KEYSTONE_SETUP_MODE=true` (see `docs/DEPLOYMENT.md`).

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/setup/status` | public | Whether setup is completed |
| GET | `/setup/diagnostics` | public | Environment diagnostics |
| POST | `/setup/config/dry-run` | public | Validate config payload without persisting |
| POST | `/setup/validate/db` | public | Test PostgreSQL connectivity |
| POST | `/setup/validate/redis` | public | Test Redis connectivity |
| POST | `/setup/validate/email` | public | Send test email via SMTP settings |
| POST | `/setup/validate/sms` | public | Send test SMS via provider settings |
| POST | `/setup/config` | public | Persist configuration |
| POST | `/setup/migrate` | public | Run database migrations |
| POST | `/setup/restart` | public | Restart into normal mode |
| POST | `/setup/init` | public | Bootstrap owner account + organization |
