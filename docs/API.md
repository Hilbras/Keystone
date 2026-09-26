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
- Refresh tokens rotate atomically on every use and are bound to their client/application; replay or client mismatch is rejected.
- Application-bound OAuth2 refresh requests must include the original `client_id` and `client_secret`; the refresh route authenticates the client before rotation.

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

### Multi-factor authentication

When a user has TOTP enabled, the password step never returns a token. Instead
`/auth/login` and `/auth/token-login` respond with `401` and:

```json
{
  "error": "Multi-factor authentication required",
  "code": "MFA_REQUIRED",
  "mfaRequired": true,
  "challenge": "<opaque single-use challenge>",
  "expiresAt": "2026-01-01T00:05:00.000Z",
  "methods": ["totp", "backup_code"]
}
```

The challenge is short-lived, single-use, and stored only as a hash. Exchange it
once for tokens:

```http
POST /auth/mfa/verify
{ "challenge": "<challenge>", "code": "123456" }
```

`factor` may be sent as `"totp"` or `"backup_code"`; when omitted it is inferred
from the code shape (six digits = TOTP).

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/auth/mfa/verify` | challenge | Complete the second factor and receive tokens |

Error codes returned by `/auth/mfa/verify`:

| Code | Meaning |
| --- | --- |
| `MFA_CHALLENGE_INVALID` | Unknown challenge |
| `MFA_CHALLENGE_EXPIRED` | Challenge passed its expiry |
| `MFA_CHALLENGE_REPLAYED` | Challenge was already consumed |
| `MFA_CHALLENGE_LOCKED` | Attempt budget exhausted |
| `MFA_INVALID_CODE` | Factor did not match |
| `MFA_NOT_REQUIRED` | The factor was disabled while the challenge was open |

A TOTP time-step is accepted once. Replaying the same code — even against a
freshly created challenge — is rejected. Backup codes are likewise single-use
and expire after `TOTP_BACKUP_CODE_TTL_SECONDS` (default 90 days).

Enabling MFA revokes every existing refresh token and session for the account,
so credentials issued before enrollment cannot be used to obtain a new session.

### TOTP (authenticator apps)

All factor-management endpoints require **step-up**: the account password must be
supplied in the request body in addition to the session. A stolen access token
alone must never be enough to change how an account proves its identity.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| POST | `/auth/totp/enroll` | `{ password }` | Begin enrollment; returns otpauth URI, QR secret, and backup codes |
| POST | `/auth/totp/verify` | `{ password, code }` | Confirm enrollment; enables MFA and revokes existing sessions |
| POST | `/auth/totp/backup` | `{ password, code }` | Regenerate backup codes |
| POST | `/auth/totp/backup/verify` | `{ code }` | Consume a backup code; never establishes a session |
| POST | `/auth/totp/disable` | `{ password, code }` | Disable TOTP and destroy its backup codes |

Step-up failures return `401 STEP_UP_REQUIRED` (no password supplied) or
`401 INVALID_CREDENTIALS` (wrong password). Failed step-up attempts count toward
the account lockout.

### Passkeys and MFA

`POST /auth/webauthn/register/verify` also requires `{ password }` when the
account has TOTP enabled. A passkey satisfies the MFA requirement on its own,
**except** when it was registered after TOTP was enabled: such a credential is
treated as a single factor and sign-in is refused with `403 MFA_REQUIRED`. This
prevents a leaked session token from being traded for a permanent bypass.

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
| GET | `/sso/sso/oidc/:connectionId?orgId=:organizationId` | public | Start organization-scoped enterprise OIDC login; connection requires JWKS URI |
| GET | `/sso/sso/oidc/:connectionId/callback?orgId=:organizationId` | public | Enterprise OIDC callback; state binds the organization |

> ⚠️ Note the doubled `/sso/sso/oidc` segment — the OIDC enterprise routes declare
> `/sso/oidc/...` paths *and* are mounted under the `/sso` prefix. This is slated
> for normalization in a future minor release.

## SCIM 2.0 provisioning — `/scim/v2`

Each request is authorized by a **per-organization SCIM connection**, and every
read and write is scoped to that connection's organization. There is no global
SCIM configuration. A target that belongs to another organization is reported as
`404`, so the endpoint is not a tenant oracle.

Create and manage the bearer token through
[the SCIM connection API](#scim-connections--v1admin).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/scim/v2/Users` | List users. `filter=userName eq "…"`, `startIndex`, `count` |
| GET | `/scim/v2/Users/:userId` | Fetch user |
| POST | `/scim/v2/Users` | Provision or update a user (create-or-update) |
| PUT | `/scim/v2/Users/:userId` | Replace user |
| PATCH | `/scim/v2/Users/:userId` | Partial update (`active`, `name.*`, `userName`) |
| DELETE | `/scim/v2/Users/:userId` | Deprovision user |
| POST | `/scim/v2/Users/.search` | Search users (POST form of the list endpoint) |
| GET | `/scim/v2/Groups` | List groups. `filter=displayName\|externalId eq "…"` |
| GET | `/scim/v2/Groups/:groupId` | Fetch group with members |
| POST | `/scim/v2/Groups` | Create group |
| PUT | `/scim/v2/Groups/:groupId` | Replace group and its membership |
| PATCH | `/scim/v2/Groups/:groupId` | Partial update |
| DELETE | `/scim/v2/Groups/:groupId` | Delete group and its memberships |
| GET | `/scim/v2/Groups/:groupId/members` | List group members |
| POST | `/scim/v2/Groups/:groupId/members` | Add member(s) |
| DELETE | `/scim/v2/Groups/:groupId/members/:userId` | Remove a member |
| GET | `/scim/v2/ServiceProviderConfig` | Supported features |
| GET | `/scim/v2/ResourceTypes` | Resource type schema URIs |

### Deprovisioning and shared users

A user row is global, so a blanket deactivation would revoke that person's access
to *every* organization they belong to — which this credential is not authorized
to do. Deprovisioning therefore removes the organization's membership, and
deactivates the account only once no membership remains anywhere.

For the same reason SCIM refuses to change the global attributes of a user who
also belongs to another organization. It returns `409` with
`scimType: "mutability"`; remove the membership from this organization instead.

| Response | Meaning |
| --- | --- |
| `404` | Not found, or belongs to another organization |
| `409` `uniqueness` | A user with that `userName` already exists |
| `409` `mutability` | Platform owner, review-required account, shared user, or last organization owner |
| `401` | Missing, unknown, revoked, or expired credential |

Platform owners and accounts pending platform review are never modified through
SCIM.

---

## SCIM connections — `/v1/admin`

Every SCIM connection belongs to exactly one organization. Issuing, rotating, and
revoking a token is **owner-only**: a SCIM token provisions and deactivates
tenant users, so it must not be mintable by a mere admin or member.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/organizations/:id/scim-config` | sso read | Status, base URL, and the active connection |
| GET | `/organizations/:id/scim-connections` | sso read | All connections, including revoked |
| POST | `/organizations/:id/scim-connections` | **owner** | Create a connection; returns the token once |
| POST | `/organizations/:id/scim-connections/:connectionId/rotate` | **owner** | Issue a new token |
| DELETE | `/organizations/:id/scim-connections/:connectionId` | **owner** | Revoke immediately |

```bash
curl -X POST https://keystone.example.com/v1/admin/organizations/$ORG/scim-connections \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Okta","expiresInDays":365}'
```

The bearer token is returned **only** in the create and rotate responses. It is
stored as a SHA-256 digest and is not recoverable afterwards; listings show a
four-character hint instead.

Rotation invalidates the old token immediately by default. Pass
`rotationGraceSeconds` to keep the previous token valid for a window, which
avoids dropping in-flight provisioning — but it is not a revocation mechanism,
so do not use a grace window when rotating in response to a leak.

Set `expiresInDays` on creation to require rotation on a schedule.

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
| POST | `/v1/admin/platform/users/:id/account-review` | owner | Resolve a quarantined legacy account (`{ "active": true/false }`) |
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
| PUT | `/v1/admin/organizations/:id/service-accounts/:accountId/certificate` | org permission (`service_account:update`) | Bind or clear a client-certificate SHA-256 fingerprint. `409` if already bound to another account |
| POST | `/v1/admin/organizations/:id/service-accounts/:accountId/revoke` | org permission (`service_account:update`) | Revoke a service account. `409` if already revoked |
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
