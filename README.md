# Hilbras Keystone

**Version: 3.0.1**

An identity and access platform: authentication, authorization, multi-tenancy,
OAuth 2.0 / OIDC, SAML, SCIM, MFA, WebAuthn, API keys, service accounts, and an
immutable audit log.

Keystone is a **server**, not a library you vendor. The security properties that
are easy to get wrong — password hashing, token rotation, replay detection,
session revocation, rate limiting — are exactly the ones that go wrong when every
application reimplements them. One implementation, used by everything, is the
control.

**Start here → [docs/HOW-KEYSTONE-WORKS.md](docs/HOW-KEYSTONE-WORKS.md)** — how a
request flows through Keystone, and the five ways to connect a program to it, with
working code in every language.

---

## Contents

- [Installation](#installation) · [Quick Start](#quick-start) · [Features](#features)
- [Authentication](#authentication) · [Organizations](#organizations) · [OAuth/OIDC](#oauthoid)
- [SAML](#saml) · [SCIM](#scim) · [MFA](#mfa) · [WebAuthn](#webauthn)
- [API Keys](#api-keys) · [Service Accounts](#service-accounts)
- [Security](#security) · [Configuration](#configuration)
- [Deployment](#deployment) · [Docker](#docker) · [Development](#development)
- [Testing](#testing) · [Contributing](#contributing) · [License](#license)

---

## Installation

Requires **Node.js 22+**, **PostgreSQL 16+** and **Redis 7+**.

```bash
npm install -g @hilbras/keystone

keystone init          # generate keys and a starter .env
keystone migrate       # create the schema
keystone config:validate
keystone user:create --role owner --email you@example.com
keystone start         # or: keystone serve
```

The setup wizard does the same thing interactively:

```bash
keystone setup         # binds loopback only; KEYSTONE_SETUP_HOST to override
```

Or run it in a container — see [Docker](#docker).

## Quick Start

**Your application is a client.** Let Keystone handle credentials, then ask it who
the user is.

```bash
# 1. Register an application
curl -X POST https://keystone.example.com/v1/admin/organizations \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"My App","redirectUris":["https://app.example.com/callback"]}'
```

```
# 2. Send the user here
https://keystone.example.com/auth/login?client_id=<id>&redirect_uri=https://app.example.com/callback

# 3. Your callback exchanges the code, then verifies the access token
```

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(new URL("https://keystone.example.com/.well-known/jwks.json"));

export async function requireUser(req, res, next) {
  try {
    const { payload } = await jwtVerify(
      req.headers.authorization.replace("Bearer ", ""),
      JWKS,
      { issuer: "https://keystone.example.com", audience: process.env.CLIENT_ID }
    );
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}
```

## Features

| | |
| --- | --- |
| **Authentication** | Password (argon2id), magic link, SMS OTP, TOTP, backup codes, WebAuthn/passkeys, social & enterprise SSO |
| **Authorization** | RBAC and scoped permissions, enforced server-side, decidable over HTTP |
| **Multi-tenancy** | Organizations, memberships, roles, organization-scoped resources |
| **OAuth 2.0 / OIDC** | Authorization code + PKCE, refresh rotation, discovery, JWKS, userinfo, nonce |
| **Enterprise SSO** | SAML SP, OIDC enterprise connections, organization-scoped |
| **Provisioning** | SCIM 2.0 for users and groups |
| **Machine identity** | API keys with enforced scopes, mTLS service accounts |
| **Audit** | Immutable, versioned events, CSV export, signed webhooks |
| **Operations** | Prometheus metrics, OpenTelemetry tracing, health/readiness probes, background jobs |

## Authentication

Every path that mints a token passes through **one chokepoint**, so a second factor
cannot be bypassed by choosing a different login route.

Methods: password, magic link, SMS OTP, TOTP with backup codes, WebAuthn, and
federated sign-in through external identity providers.

A login that requires a second factor returns `401` with `MFA_REQUIRED` and an
opaque challenge; complete it at `POST /auth/mfa/verify`. The challenge is the only
credential at that point — no token exists yet.

MFA is **enforced by default** where a user has it enabled: session refresh,
OAuth token exchange and SSO all re-check it.

→ [docs/LOGIN_FORM_INTEGRATION.md](docs/LOGIN_FORM_INTEGRATION.md) ·
[docs/HOW-KEYSTONE-WORKS.md](docs/HOW-KEYSTONE-WORKS.md#how-tokens-are-issued)

## Organizations

An organization is the tenant boundary. Users hold a membership with a role —
`owner`, `admin` or `member` — and every organization-owned resource is scoped to
one.

```bash
POST   /v1/admin/organizations
GET    /v1/admin/organizations
GET    /v1/admin/organizations/:id
GET    /v1/admin/organizations/:id/members
POST   /v1/admin/organizations/:id/members/:userId      # role change: owner-only
GET    /v1/admin/organizations/:id/users
```

`requireOrganizationRole` resolves the organization from the request and checks
membership **there**, not in the caller's own organization — which is what makes
cross-tenant access a structural impossibility rather than a thing to remember.

→ [docs/RBAC.md](docs/RBAC.md)

## OAuth/OIDC

A standards-compliant provider. Any OIDC client library works — no Keystone-specific
SDK required.

```
GET  /.well-known/openid-configuration     discovery
GET  /.well-known/jwks.json                 signing keys
GET  /oauth2/authorize                      authorization endpoint
POST /oauth2/token                          token endpoint
GET  /oauth2/userinfo                       profile
```

- **PKCE with `S256` is required for public clients** (SPAs, mobile).
- **Client authentication is mandatory** on every grant for confidential clients.
- **Only `https` redirect URIs are registrable** (plus `http` for loopback).
  `javascript:` and `data:` are rejected.
- **A nonce is generated and verified** on every authorization request.
- **The ID token algorithm comes from the connector configuration**, never from
  the token's own header, and `exp` and `iat` are required.
- **Refresh tokens rotate** on every use. Persist the new one; presenting a spent
  token is treated as a replay.

→ [docs/INTEGRATION.md](docs/INTEGRATION.md#1-web--spa-oidc-authorization-code--pkce)

## SAML

Keystone acts as a SAML **service provider** and brokers to your enterprise IdP,
so users sign in at Keystone and the SAML software never sees a password.

- Register the IdP's entity id, SSO URL and certificate.
- Publish `GET /sso/saml/metadata/:connectionId` or paste the metadata.
- Assertions are validated against the configured issuer, audience, destination
  and conditions — including an `Issuer` outside the signed region.

Endpoint URLs are checked against an address policy that refuses loopback,
private, link-local, carrier-grade NAT and benchmarking ranges, so a connection
cannot be pointed at your internal network.

→ [docs/security/enterprise-sso.md](docs/security/enterprise-sso.md)

## SCIM

Standard provisioning, for pushing users and groups from an IdP.

```
GET    /scim/v2/Users
POST   /scim/v2/Users
GET    /scim/v2/Users/.search
GET    /scim/v2/Groups
```

Authenticate with the organization's SCIM token as a bearer credential. **That
token resolves to exactly one organization** and every query is scoped to it.
Issuing, rotating and revoking a SCIM credential is owner-only.

→ [src/routes/scim.ts](src/routes/scim.ts)

## MFA

TOTP (RFC 6238) with single-use backup codes.

```
POST /auth/totp/enroll        requires password step-up
POST /auth/totp/verify        confirms the code
POST /auth/totp/backup        regenerate backup codes
POST /auth/totp/disable       requires password step-up
```

- A code is accepted **once**; reuse across challenges is refused.
- Codes are rate limited **per user**, so one busy office behind a single NAT
  cannot lock out everyone's second factor.
- Enabling MFA **invalidates sessions issued before it** — an attacker holding a
  pre-enrolment session loses access when you turn it on.
- Factor management is refused to machine principals.

→ [docs/security/trust-boundaries.md](docs/security/trust-boundaries.md)

## WebAuthn

Passkeys as a second factor.

```
POST /auth/webauthn/register/options
POST /auth/webauthn/register/verify
POST /auth/webauthn/authenticate/options
POST /auth/webauthn/authenticate/verify
```

## API Keys

For a service acting as itself.

```bash
curl -X POST https://keystone.example.com/auth/api-keys \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"billing-worker","scopes":["api_keys:read"]}'
# -> { "key": "sk_...", }   shown once
```

- **Scopes are enforced, and there is no wildcard.** Every scope is named. A
  `service_account` scope used to behave as a wildcard and was removed in 2.6.0.
- **Enforcement fails closed.** Reaching a scoped route without key authentication
  means *no authority*, not *no restriction*.
- **Creation is rate limited**, and the plaintext key is shown exactly once.

→ [docs/security/scopes.md](docs/security/scopes.md)

## Service Accounts

Machine identity without a user, for server-to-server and mTLS.

```bash
POST /v1/admin/organizations/:id/service-accounts
POST /v1/admin/organizations/:id/service-accounts/:accountId/api-keys
POST /v1/admin/organizations/:id/service-accounts/:accountId/certificate
POST /v1/admin/organizations/:id/service-accounts/:accountId/revoke
```

With a certificate bound, a machine principal is identified by the **verified
certificate whose fingerprint matches the stored binding** — possession of any
certificate from the same CA is not authorization.

`profile:*` and `mfa:manage` are refused to machine principals: those operations
need a person present.

## Security

46 findings across the hardening programme, each with a permanent regression test
and machine-verified coverage. **Zero unresolved Critical.**

| Area | Control |
| --- | --- |
| Passwords | argon2id, breach-list checking, lockout |
| Tokens | RS256 JWTs, rotating refresh tokens, replay detection |
| Sessions | Revoked on password reset and on MFA enablement |
| Trust boundary | Client-supplied identity headers stripped before any plugin reads them; `x-forwarded-for` honoured only from configured networks |
| Rate limiting | Bounded local budget when Redis is unavailable — an outage does not remove the control |
| Secrets | Redaction is an allowlist; webhook secrets encrypted at rest; the setup token is never logged |
| Cookies | `Secure` by default in production |
| CORS | Fails closed on an empty allowlist |
| Audit | Every action recorded, including API-key and mTLS requests |
| Supply chain | Signed npm provenance, SBOM, Trivy, OSV, CodeQL, Semgrep, Gitleaks |

**Report a vulnerability through [docs/SECURITY.md](docs/SECURITY.md)** — not a
public issue.

→ [docs/RE-AUDIT.md](docs/RE-AUDIT.md) ·
[docs/security/registry.md](docs/security/registry.md)

## Configuration

Environment-based and read-only. The required set:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/keystone
REDIS_URL=redis://localhost:6379
JWT_PRIVATE_KEY=...            # PEM, or a path via keystone keys:create
JWT_PUBLIC_KEY=...
COOKIE_NAME=keystone
COOKIE_SECURE=true             # defaults true when NODE_ENV=production
COOKIE_SAME_SITE=lax
HOST=0.0.0.0
PORT=3000
```

Frequently adjusted:

| Variable | Default | Notes |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | — | **Fails closed.** Empty denies every origin |
| `KEYSTONE_ENCRYPTION_KEY` | — | 32 bytes hex. Required for secrets at rest |
| `RATE_LIMIT_ATTEMPTS` / `RATE_LIMIT_WINDOW_SECONDS` | `5` / `900` | Per credential, per operation |
| `GLOBAL_RATE_LIMIT_MAX` / `GLOBAL_RATE_LIMIT_WINDOW` | `100` / `60` | Per client address |
| `ACCOUNT_LOCKOUT_THRESHOLD` / `..._DURATION_SECONDS` | — | Brute-force response |
| `HIBP_CHECK_ENABLED` | — | Password breach-list checking |
| `EMAIL_PROVIDER` / `EMAIL_FROM` | — | Magic links and verification |
| `KEYSTONE_TRUSTED_PROXIES` | — | CIDRs whose forwarding headers are honoured |
| `KEYSTONE_SECRETS_PROVIDER` | — | `env`, `database` or `vault` |
| `KEYSTONE_QUEUE_PROVIDER` | — | `in-process` or `bullmq` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OpenTelemetry export |

`keystone config:validate` reports the required set and what is missing.

**The configuration API redacts by allowlist.** A key not declared exposable is
not returned — a denylist missed half the secret-shaped keys, including the
signing keys.

## Deployment

- Single instance, or several behind a load balancer (sessions and rate limits
  live in Redis, so they are shared).
- PostgreSQL 16+ and Redis 7+ must be reachable; both are required.
- Terminate TLS at the proxy, then set `KEYSTONE_TRUSTED_PROXIES` to that proxy's
  CIDR. **Without it, the client address is the proxy's** and every rate limit is
  shared across all users.
- `GET /health` and `GET /ready` for probes; `GET /metrics` for Prometheus.
- Back up PostgreSQL. The audit log is append-only by design, not by policy.

→ [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) ·
[docs/security/proxy-security.md](docs/security/proxy-security.md)

## Docker

```bash
docker build -t keystone .
docker run -p 3000:3000 --env-file .env keystone
```

The runtime image does **not** bundle npm — including it shipped eight
high-severity advisories that no lockfile-based scanner could see, because those
scanners read `package.json`, not the image. Published as
`ghcr.io/hilbras/keystone` with a build provenance attestation.

## Development

```bash
git clone https://github.com/Hilbras/Keystone && cd Keystone
npm install
npm run dev            # watch mode
npm run build          # clean, then compile
```

Layout: `src/routes` (HTTP only) → `src/services/application` (use cases) →
`src/services/domain` (business rules) → `src/repositories` (persistence).
Routes must not contain business logic or import the database directly.

→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[AGENTS.md](AGENTS.md)

## Testing

```bash
npm test                 # 451 tests
npm run test:security    # 402 of them the security suite
npm run lint
npm run typecheck
npm run verify:release
npm run registry:check  # every finding's test must exist
npm run reaudit:check   # every matrix claim must verify
npm run review:api       # every route's guards
```

Needs PostgreSQL and Redis:

```bash
docker run -d --name keystone-pg -p 5432:5432 \
  -e POSTGRES_USER=hilbras -e POSTGRES_PASSWORD=hilbras -e POSTGRES_DB=hilbras \
  postgres:16-alpine
docker run -d --name keystone-redis -p 6379:6379 redis:7-alpine

export DATABASE_URL=postgresql://hilbras:hilbras@localhost:5432/hilbras
export REDIS_URL=redis://localhost:6379
```

→ [docs/API-REVIEW.md](docs/API-REVIEW.md)

## Contributing

Issues and pull requests are welcome. For anything touching authentication,
authorization or tenant scoping, read [AGENTS.md](AGENTS.md) first — it documents
the layering and the conventions this codebase holds to.

Every change needs a test that fails without it. If you fix a vulnerability, add
a registry entry: `npm run registry:check` enforces that each one names a test
that exists.

→ [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)

## License

**MIT** — see [LICENSE](LICENSE).
