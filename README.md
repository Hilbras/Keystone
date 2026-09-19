# Hilbras Keystone

> A provider-agnostic, API-first identity platform for Hilbras products and third-party applications.

Keystone is a **standalone identity platform**, not a wrapper around another identity system. It authenticates users, issues signed tokens, enforces authorization, audits every security decision, and federates identities from any OIDC provider.

---

## What Keystone becomes

- **Identity Provider (IdP)** — OIDC/OAuth2 provider with JWKS discovery.
- **Authentication Service** — email/password, social login, magic links, WebAuthn/Passkeys, TOTP, SMS OTP.
- **Authorization Engine** — RBAC/ABAC permissions with `/v1/authz/check`.
- **Token Authority** — short-lived JWT access tokens, rotating refresh tokens, opaque API keys.
- **Machine Identity Manager** — scoped, rotatable, auditable service credentials.
- **Federation Broker** — delegate login to Google, GitHub, Azure, Okta, Keycloak, Zitadel, or any OIDC provider and issue Keystone tokens.
- **Enterprise SSO** — SAML 2.0 and OIDC enterprise connectors with SCIM user provisioning.
- **Audit & Compliance** — immutable audit log, event bus, webhooks, and anomaly detection.
- **Workflow Platform** — configurable post-auth workflows (assign roles, create orgs, send email, fire webhooks).

---

## What's new in v1.5.0

- **Auth & infrastructure upgrades** — jose 6, ioredis 6, bullmq 6, @simplewebauthn/server 14, nodemailer 10. Updated KeyLike→CryptoKey for jose 6 and AuthenticatorTransportFuture→AuthenticatorTransport for simplewebauthn 14.

## What's new in v1.4.0

- **Fastify ecosystem upgrades** — fastify-plugin 6, @fastify/cookie 11, @fastify/cors 11, @fastify/static 10, @fastify/swagger-ui 6. All plugins updated to latest major versions with no code changes required.

## What's new in v1.3.0

- **Core tooling upgrades** — TypeScript 7, Zod 4, Drizzle ORM 0.45, Commander 15, Dotenv 18. Updated all `z.record()` calls for Zod 4 compatibility.

## What's new in v1.2.0

- **Dependency updates** — All root and frontend packages updated to latest safe patch/minor versions (fastify, argon2, otpauth, OpenTelemetry, autoprefixer, postcss, lucide-react, Playwright).

## What's new in v1.0.0

- **Simplified browser setup wizard** — choose a profile (Development, Docker Compose, Production), test PostgreSQL/Redis, create the owner account, and connect your first project without editing files.
- **Setup diagnostics & dry-run** — validate the full configuration before applying it, then run a health report after setup completes.
- **Mobile-first admin UI** — the dashboard and setup wizard are usable down to 375px widths, with touch-friendly controls and hash-routed tabs.
- **Security dashboard** — owners can view 24h logins, failed logins, active sessions, MFA adoption, and recent login activity.
- **Account lockout protection** — repeated failed logins temporarily lock accounts and emit security events.
- **Azure Key Vault secrets provider** — store JWT signing and encryption keys in Azure Key Vault in addition to the default database provider.
- **API key scopes & signed webhooks** — API keys carry granular scopes and audit webhook deliveries are signed with HMAC.
- **One-click project connection** — copy integration snippets for React, Next.js, Angular, Svelte, Vue, Django, Rails, Go, Python, and plain HTML.
- **End-to-end test suite** — Playwright tests cover the simple setup wizard and the post-setup security dashboard using an isolated `hilbras_test` database.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Consumers                                       │
│   Web App    Mobile    CLI    Microservice    External SaaS             │
└──────┬───────┬─────────┬──────┬──────────────┬──────────────────────────┘
       │       │         │      │              │
       ▼       ▼         ▼      ▼              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Public SDK Layer                                   │
│            JS / React / Next.js / Python / CLI                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Hilbras Keystone                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              API-First Admin & Public APIs                      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │         Internal SDK (stable contracts)                         │   │
│  │  AuthenticationSdk │ IdentitySdk │ OrganizationSdk │ AuthzSdk   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │         Application Services (use cases / HTTP agnostic)        │   │
│  │  AuthenticationApplicationService │ OrganizationApplication... │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │         Domain Services (business rules)                        │   │
│  │  AuthenticationDomainService │ AuthorizationDomainService       │   │
│  │  IdentityDomainService       │ OrganizationDomainService        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │         Repositories (persistence abstraction)                  │   │
│  │  UserRepository │ OrganizationRepository │ ApplicationRepository │   │
│  │  IdentityRepository │ AuditRepository │ ApiKeyRepository         │   │
│  │  SamlConnectionRepository │ OidcConnectionRepository            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐      │   │
│  │   Identity   │  │   Token      │  │    Authorization     │      │   │
│  │   Connectors │  │   Service    │  │    Engine            │      │   │
│  └──────────────┘  ┌──────────────┘  └──────────────────────┘      │   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐      │   │
│  │ Versioned    │  │   Secrets    │  │   Workflow Engine    │      │   │
│  │ Event Bus    │  │   Provider   │  │   + Background Queue │      │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘      │   │
│  ┌────────────────────────────────────────────────────────────┐    │   │
│  │  DI Container │ Plugin Registry │ ConfigurationService     │    │   │
│  └────────────────────────────────────────────────────────────┘    │   │
│  ┌────────────────────────────────────────────────────────────┐    │   │
│  │  Security: Rate Limiting │ mTLS │ SAML │ SCIM │ WebAuthn  │    │   │
│  └────────────────────────────────────────────────────────────┘    │   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               ▼                    ▼                    ▼
          PostgreSQL            Redis              External providers
```

---

## Design principles

### 1. Connectors are pure provider adapters

Identity connectors know only how to talk to an external provider:

- Build authorization URLs
- Exchange codes for tokens
- Validate identity tokens
- Retrieve and normalize profile information

They do **not** create users, link identities, issue Keystone tokens, or manage sessions. Those responsibilities live in higher-level services such as `FederationService` and `AuthenticationService`. This keeps connectors small, reusable, and easy to test.

### 2. Layered architecture: Application → Domain → Repository

Routes delegate to an **Application Layer** that executes use cases, which in turn delegate to **Domain Services** that encode business rules. Domain services depend on **Repository interfaces**, not on SQL or ORM details.

```
Routes → Application Services → Domain Services → Repositories
```

This keeps business logic independent of HTTP and makes future transports (CLI, gRPC, workers, GraphQL) straightforward.

### 3. Everything important emits a versioned event

The audit event bus emits structured events such as `user_registered`, `user_login`, `oauth_callback`, `api_key_created`, and `authz_check`.

Every event carries a version:

```json
{
  "type": "user.login",
  "version": 1,
  "timestamp": "2026-07-13T00:00:00Z",
  "payload": {
    "userId": "...",
    "ip": "...",
    "metadata": {}
  }
}
```

Versioned events let subscribers evolve independently without breaking integrations.

### 4. Long-running work belongs in a background queue

The in-process event bus is a fast starting point, but actions such as sending emails, delivering webhooks, running analytics, and executing workflow steps should move to a background job queue. Keystone ships with a BullMQ-backed queue that is used automatically when Redis is available (`KEYSTONE_QUEUE_PROVIDER=""` or `bullmq`), falling back to an in-process queue for local development.

### 5. Secrets are pluggable

Secrets management is abstracted so Keystone can store and rotate keys in different backends:

- `DatabaseSecretsProvider` — default, stores keys in PostgreSQL
- `EnvironmentSecretsProvider` — read from env vars
- `AWS KMS Provider`, `HashiCorp Vault Provider`, `Azure Key Vault Provider` — enterprise options (via plugin or future built-in providers)

The default provider handles JWT signing keys, encryption keys, password hashes, API keys, and client secrets with rotation support. JWT keys are rotated with a 24-hour grace period so tokens signed with the previous key remain valid.

### 6. Built for a plugin architecture

Keystone is designed to be extended without touching core code. The plugin registry can register:

- Identity providers and authentication methods
- Email and SMS providers
- Custom workflow steps
- Analytics, billing, and custom authorization policies

Load plugins at startup via `KEYSTONE_PLUGINS=./plugins/my-plugin.js` or call `app.registerPlugin(plugin)` at runtime. Each plugin exports a `KeystonePlugin` object with optional `connectors`, `emailProvider`, `smsProvider`, and `workflowSteps`.

### 7. Internal SDK layer

Routes, CLI commands, workers, and scheduled jobs share a stable internal client layer instead of calling low-level services directly:

```ts
import { getSdk } from "./sdk/index.js";

const sdk = getSdk();
const session = await sdk.authentication.login({ email, password });
const user = await sdk.identity.findUser(session.user.id);
const allowed = await sdk.authorization.hasPermission(role, resource, action);
const org = await sdk.organization.createOrganization(userId, { name: "Acme" });
```

The SDK exposes stable TypeScript interfaces (`AuthenticationSdk`, `IdentitySdk`, `OrganizationSdk`, `AuthorizationSdk`) while hiding the concrete application and domain service implementations.

---

## Advanced architecture patterns

### Dependency injection

A lightweight DI container wires repositories, domain services, and application services. The container is initialized when the app boots:

```ts
import { initializeContainer, getContainer } from "./di.js";

initializeContainer();
const users = getContainer().userRepository;
```

Services receive dependencies through constructors, making unit testing with mocked repositories straightforward.

### Repository abstraction

Domain services depend on repository interfaces such as `UserRepository`, `OrganizationRepository`, `ApplicationRepository`, `IdentityRepository`, `AuditRepository`, `PermissionRepository`, `ApiKeyRepository`, `SamlConnectionRepository`, and `OidcConnectionRepository`. Drizzle-based implementations live in `src/repositories/`, but the persistence layer can be swapped without touching business logic.

### Standardized results

Internal services return a uniform `Result<T>` type instead of throwing:

```ts
import { ok, err, type Result } from "./lib/result.js";

function findUser(id: string): Result<User> {
  if (!user) return err({ code: "NOT_FOUND", message: "User not found", statusCode: 404 });
  return ok(user);
}
```

This simplifies error handling and reduces duplicated try/catch logic.

### Configuration service

`ConfigurationService` centralizes loading, defaults, validation, and environment-specific overrides. Access runtime configuration through the container or via `config.get()`.

### Feature flags

Enable or disable functionality at runtime through `KEYSTONE_FEATURE_FLAGS`:

```bash
KEYSTONE_FEATURE_FLAGS=beta_oauth=true,experimental_workflows=false
```

Check flags in code:

```ts
const features = getContainer().features;
if (features.isEnabled("beta_oauth")) { /* ... */ }
```

---

## Stack

- **Runtime:** Fastify 5 + TypeScript
- **Database:** Drizzle ORM + `postgres`
- **Cache / rate limiting:** Redis (ioredis)
- **Tokens & JWKS:** `jose`
- **Validation:** `zod`
- **Password hashing:** `argon2id` with legacy `scrypt` verification
- **WebAuthn:** `@simplewebauthn/server`
- **Tracing:** OpenTelemetry

---

## Local development

### One-command setup (recommended)

From `Hilbras/Keystone`:

```bash
./install.sh       # installs backend + frontend deps + Playwright Chromium
```

Launch Keystone. `start.sh` will automatically start PostgreSQL and Redis via Docker if they are not already running. If no `.env` exists (or `DATABASE_URL` is missing), Keystone starts in **setup mode** and opens the browser wizard instead of the main API:

```bash
./start.sh         # starts backend/setup server + frontend together
```

The wizard guides you through:

1. Pasting the setup token printed in the server logs.
2. Choosing an environment profile (Development, Docker Compose, Production).
3. Configuring and testing PostgreSQL and Redis.
4. Setting public URLs and allowed origins (advanced mode).
5. Generating platform secrets (internal API key, encryption key).
6. Choosing and testing email and SMS providers (advanced mode).
7. Enabling optional identity connectors (advanced mode).
8. Creating the first owner account and connecting your first project.
9. Reviewing diagnostics and completing setup.

When finished, the wizard writes `.env`, runs migrations, creates the owner, and optionally restarts the server in normal API mode.

### Admin dashboard

After setup, the same UI at http://localhost:5173 becomes the **admin dashboard**. Log in with the owner email and password to view:

- **Overview** — API health and OIDC discovery endpoints.
- **Organizations** — all platform organizations.
- **Applications** — all registered OAuth/OIDC applications.
- **Connect Project** — copy integration snippets for React, Next.js, Angular, Svelte, Vue, Django, Rails, Go, Python, and HTML.
- **Users** — all platform users.
- **Security** — 24h logins, failed logins, active sessions, MFA adoption, and recent activity.
- **Audit Logs** — recent security events.
- **Workflows** — configurable post-automation flows.
- **Settings** — platform configuration and feature flags.

### Manual setup

If you prefer to manage each part separately:

1. Install backend dependencies: `npm install`
2. Install frontend dependencies: `cd frontend && npm install`
3. Start Postgres and Redis.
4. Copy `.env.example` to `.env` and fill in the required values:
   - `DATABASE_URL`
   - `REDIS_URL`
   - `AUTH_API_PUBLIC_URL`
   - `CLIENT_APP_URL`
   - `ALLOWED_ORIGINS`
   - `KEYSTONE_INTERNAL_API_KEY`
   - `KEYSTONE_ENCRYPTION_KEY` (optional in dev)
   - **Zitadel is optional.** If you want to use it, set `ZITADEL_DOMAIN`, `ZITADEL_CLIENT_ID`, and `ZITADEL_CLIENT_SECRET`.
   - To enable Google/GitHub/Azure/Okta/Keycloak federation, set their `*_CLIENT_ID` and `*_CLIENT_SECRET` variables.
5. Run migrations: `npm run db:migrate`
6. Start the backend: `npm run dev`
7. In another terminal, start the frontend: `cd frontend && npm run dev`

### Running integration tests locally

Start test services with Docker Compose:

```bash
docker compose -f docker-compose.test.yml up -d
npm test
```

### Build verification

Before committing or releasing, run the full build and type check:

```bash
npm run build:all
npm run typecheck:all
```

### Setup frontend E2E tests

The setup wizard and post-setup dashboard are tested with Playwright. The E2E suite uses an isolated `hilbras_test` database that is reset automatically before each run. From the project root:

```bash
npm run test:all
```

Or run only the backend tests or only the E2E tests:

```bash
npm test                         # backend tests
cd frontend && npm run test:e2e  # Playwright E2E tests
```

---

## Building for production

```bash
npm ci
npm run build
npm start
```

`npm run build` compiles TypeScript and copies migration SQL files into `dist/db/migrations` so they are available at runtime.

---

## Production deployment

### Docker Compose (recommended)

1. Copy and customize the environment file:

   ```bash
   cp .env.example .env
   # Edit .env with production secrets, URLs, and provider credentials.
   ```

2. Start the stack:

   ```bash
   docker compose up -d
   ```

   This launches PostgreSQL, Redis, and the Keystone API container with health checks and restart policies. On first run, set `KEYSTONE_SETUP_MODE=true` in `.env` and visit `http://localhost:4001/setup` to complete the browser wizard.

3. View logs:

   ```bash
   docker compose logs -f keystone
   ```

4. Restart after configuration changes:

   ```bash
   docker compose down && docker compose up -d
   ```

### systemd service

For hosts running Docker with systemd, install the provided unit file:

```bash
sudo cp scripts/keystone.service /etc/systemd/system/hilbras-keystone.service
sudo systemctl daemon-reload
sudo systemctl enable --now hilbras-keystone
```

Place the project files in `/opt/hilbras-keystone` and ensure `.env` is present there.

### Managed PostgreSQL / Redis

For high-availability deployments, replace the bundled `postgres` and `redis` services with managed instances and update `DATABASE_URL` and `REDIS_URL` accordingly. You can then run Keystone with a minimal compose file:

```yaml
services:
  keystone:
    build: .
    ports:
      - "4001:4001"
    env_file: .env
```

---

## Key environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `AUTH_API_PUBLIC_URL` | Public URL used for discovery and redirects |
| `CLIENT_APP_URL` | Default redirect URL after login |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins |
| `KEYSTONE_INTERNAL_API_KEY` | Secret for service-to-service calls |
| `KEYSTONE_ENCRYPTION_KEY` | Master key for encrypted secrets (optional in dev) |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | RSA key pair for signing tokens (optional in dev) |
| `ZITADEL_DOMAIN` | Zitadel instance domain (optional connector) |
| `ZITADEL_CLIENT_ID` / `ZITADEL_CLIENT_SECRET` | Zitadel OIDC app credentials |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google connector credentials |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub connector credentials |
| `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | Azure connector credentials |
| `OKTA_ISSUER` / `OKTA_CLIENT_ID` / `OKTA_CLIENT_SECRET` | Okta connector credentials |
| `KEYCLOAK_ISSUER` / `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_CLIENT_SECRET` | Keycloak connector credentials |
| `EMAIL_PROVIDER` | `none`, `console`, `smtp`, `sendgrid`, or `mailgun` |
| `EMAIL_FROM` | Default sender address |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | SMTP settings |
| `SENDGRID_API_KEY` | SendGrid API key |
| `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` | Mailgun settings |
| `SMS_PROVIDER` | `none`, `console`, or `twilio` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` / `TWILIO_MESSAGING_SERVICE_SID` | Twilio settings |
| `AUDIT_WEBHOOK_URL` | Webhook destination for audit events |
| `AUDIT_CONSOLE_EXPORT` | `true` to log audit events to console |
| `KEYSTONE_SEED_OWNER_EMAIL` | Default owner email for seeded organization |
| `KEYSTONE_SEED_OWNER_PASSWORD` | Password for the seed owner |
| `KEYSTONE_SECRETS_PROVIDER` | `database` (default) or `environment` |
| `AZURE_KEY_VAULT_URL` | Azure Key Vault URL for the `azure-key-vault` secrets provider |
| `AZURE_KEY_VAULT_TENANT_ID` / `AZURE_KEY_VAULT_CLIENT_ID` / `AZURE_KEY_VAULT_CLIENT_SECRET` | Azure service principal credentials |
| `KEYSTONE_QUEUE_PROVIDER` | `in-process`, `bullmq`, or empty to auto-select when Redis is available |
| `KEYSTONE_PLUGINS` | Comma-separated module paths of plugins to load at startup |
| `KEYSTONE_FEATURE_FLAGS` | Comma-separated `flag=true|false` runtime feature toggles |

---

## Integrating with your projects

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for complete examples covering:

- React / Next.js / SPAs (OIDC + PKCE)
- Backend services and microservices (API keys)
- Python / FastAPI token verification
- Mobile apps (system browser + custom URL scheme)
- CLI scripts
- Federation through external IdPs

If you already have a login/signup page with email/password and Google login and just want to wire it up, start with [`docs/LOGIN_FORM_INTEGRATION.md`](docs/LOGIN_FORM_INTEGRATION.md) or load the one-line CDN script from `http://localhost:4001/sdk/keystone-dropin.js`.

For production deployment with HTTPS and a custom domain, see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

If Keystone feels slow or uses a lot of memory during development, see [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

## Endpoints

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Email/password signup (local password hashing) |
| POST | `/auth/login` | Email/password login (sets session cookies) |
| POST | `/auth/token-login` | Email/password login for SPA/dashboard (returns bearer token) |
| POST | `/auth/logout` | Revoke session |
| GET | `/auth/me` | Current user |
| POST | `/auth/refresh` | Rotate refresh token |
| GET | `/auth/oauth/:provider` | Start OAuth login (google, github, azure, okta, keycloak, zitadel) |
| GET | `/auth/callback/:provider` | OAuth callback |
| POST | `/auth/forgot-password` | Request password reset |
| POST | `/auth/reset-password` | Complete password reset |
| POST/GET/DELETE | `/auth/api-keys` | Personal API keys |
| GET | `/auth/validate` | Internal token/API-key validation |

### Federation

| Method | Path | Description |
|--------|------|-------------|
| GET | `/federation/providers` | List supported federation providers |
| GET | `/federation/:provider/start` | Start broker login through an external IdP |
| GET | `/federation/:provider/callback` | Broker callback; issues Keystone tokens |
| POST | `/federation/link` | Link an external identity to the current user |
| GET | `/federation/identities` | List linked external identities |

### OAuth2 / OIDC

| Method | Path | Description |
|--------|------|-------------|
| GET | `/oauth2/authorize` | Authorization endpoint (PKCE required) |
| POST | `/oauth2/token` | Token endpoint |
| GET | `/oauth2/userinfo` | UserInfo endpoint |
| POST | `/oauth2/revoke` | Token revocation |
| POST | `/oauth2/consent` | Grant or revoke consent |

### Admin (API-first)

| Method | Path | Description |
|--------|------|-------------|
| POST/GET | `/v1/admin/organizations` | Create / list organizations for the current user |
| GET | `/v1/admin/organizations/:id` | Organization details |
| POST/GET | `/v1/admin/organizations/:id/applications` | Create / list apps |
| PATCH | `/v1/admin/organizations/:id/applications/:appId` | Update app |
| POST/GET | `/v1/admin/organizations/:id/invites` | Invite / list invites |
| GET | `/v1/admin/organizations/:id/members` | List members |
| PATCH/DELETE | `/v1/admin/organizations/:id/members/:userId` | Update / remove member |
| GET | `/v1/admin/organizations/:id/users` | List users in org |
| GET/PATCH/DELETE | `/v1/admin/organizations/:id/users/:userId` | Manage user |
| GET | `/v1/admin/permissions` | **Owner only** — list all permissions |
| GET/POST/DELETE | `/v1/admin/roles/:role/permissions` | **Owner only** — manage role permissions |
| GET/DELETE | `/v1/admin/organizations/:id/api-keys` | Org-scoped API keys |
| GET | `/v1/admin/organizations/:id/audit-logs` | Paginated audit logs |
| GET | `/v1/admin/platform/users` | **Owner only** — list all users |
| GET | `/v1/admin/platform/organizations` | **Owner only** — list all organizations |
| GET | `/v1/admin/platform/applications` | **Owner only** — list all applications |
| GET | `/v1/admin/platform/audit-logs` | **Owner only** — list recent audit logs |
| GET | `/v1/admin/platform/audit-logs/export` | **Owner only** — export audit logs |
| GET | `/v1/admin/platform/metrics/usage` | **Owner only** — platform usage metrics |
| GET | `/v1/admin/platform/queue` | **Owner only** — queue stats |
| GET | `/v1/admin/platform/queue/failed` | **Owner only** — failed jobs |
| POST | `/v1/admin/platform/queue/failed/:id/retry` | **Owner only** — retry failed job |
| POST | `/v1/admin/platform/queue/retry-all` | **Owner only** — retry all failed jobs |
| GET/POST/PATCH/DELETE | `/v1/admin/platform/webhooks` | **Owner only** — webhook management |
| POST | `/v1/admin/platform/webhooks/:id/rotate-secret` | **Owner only** — rotate webhook secret |
| GET/POST/DELETE | `/v1/admin/organizations/:id/saml-connections` | SAML connection management |
| GET | `/v1/admin/organizations/:id/saml-connections/:connectionId/metadata` | SAML SP metadata |
| GET/POST/DELETE | `/v1/admin/organizations/:id/oidc-connections` | OIDC connection management |

### Enterprise SSO

| Method | Path | Description |
|--------|------|-------------|
| GET | `/saml/:connectionId` | Start SAML SSO login |
| POST | `/saml/acs` | SAML assertion consumer service |
| GET | `/saml/:connectionId/metadata` | SAML SP metadata |
| GET | `/sso/oidc/:connectionId` | Start enterprise OIDC SSO login |
| GET | `/sso/oidc/:connectionId/callback` | Enterprise OIDC callback |

### SCIM Provisioning

| Method | Path | Description |
|--------|------|-------------|
| GET | `/scim/v2/Users` | List all users (SCIM) |
| GET | `/scim/v2/Users/:userId` | Get user by ID (SCIM) |
| POST | `/scim/v2/Users` | Create user (SCIM) |
| PUT | `/scim/v2/Users/:userId` | Update user (SCIM) |
| DELETE | `/scim/v2/Users/:userId` | Delete user (SCIM) |
| GET | `/scim/v2/Groups` | List groups (SCIM) |
| GET | `/scim/v2/Groups/:groupId` | Get group by ID (SCIM) |

### MFA & Security

| Method | Path | Description |
|--------|------|-------------|
| POST | `/totp/enroll` | Enroll TOTP MFA |
| POST | `/totp/verify` | Verify TOTP code |
| POST | `/totp/disable` | Disable TOTP MFA |
| POST | `/totp/backup` | Verify backup code |
| POST | `/sms-otp/send` | Send SMS OTP |
| POST | `/sms-otp/verify` | Verify SMS OTP |
| POST | `/magic-link/send` | Send magic link |
| GET | `/magic-link/verify` | Verify magic link |
| POST | `/email-verification/send` | Send verification email |
| POST | `/email-verification/request` | Request verification email |
| GET | `/email-verification/verify` | Verify email token |
| POST | `/webauthn/register` | Register WebAuthn credential |
| POST | `/webauthn/authenticate` | Authenticate with WebAuthn |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions` | List active sessions |
| DELETE | `/sessions/:id` | Revoke session |
| POST | `/sessions/revoke-all` | Revoke all sessions |

### Workflows

| Method | Path | Description |
|--------|------|-------------|
| GET | `/workflows` | List workflows (requires orgId) |
| POST | `/workflows` | Create workflow |
| GET | `/workflows/:id` | Get workflow |
| DELETE | `/workflows/:id` | Delete workflow |
| GET | `/workflows/:id/runs` | List workflow runs |

### Discovery

| Method | Path | Description |
|--------|------|-------------|
| GET | `/.well-known/openid-configuration` | OIDC discovery document |
| GET | `/.well-known/jwks.json` | Public keys for token verification |
| GET | `/health` | Health check |
| GET | `/metrics` | Prometheus metrics |
| GET | `/documentation` | OpenAPI/Swagger UI |

---

## CLI

```bash
# Rotate the active JWT signing key
npx keystone secrets:rotate

# Generate a JWT key pair for env vars
npx keystone keys:create

# List active JWT signing keys
npx keystone keys:list

# Run migrations
npx keystone migrate

# Validate required configuration
npx keystone config:validate

# Create the first platform owner
npx keystone user:create --email admin@example.com --password 'Str0ngP@ss!' --role owner

# Create an organization from the command line
npx keystone org:create --name "Acme" --owner-email admin@example.com
```

---

## Security non-negotiables

- Passwords are never stored in plaintext (argon2id with OWASP parameters).
- Tokens and secrets are hashed at rest (SHA-256).
- JWTs are signed with RS256 and keys are rotatable with 24-hour grace period.
- Rate limiting is applied to all sensitive endpoints (login, register, password reset, magic links, SMS OTP, email verification, org creation).
- Every authentication decision is audited.
- Cookies use `HttpOnly`, `Secure`, and `SameSite`.
- OAuth2 public clients must use PKCE.
- All admin endpoints require owner or role-based authorization.
- All workflow operations require organization membership.
- XML output (SAML metadata) is escaped to prevent injection.
- Rate limit nonces use cryptographically secure random bytes.
- Internal implementation details are not exposed in API responses.
- Input validation uses Zod schemas on all routes.
- Error messages are sanitized in production mode.

---

## Documentation

Full documentation lives in [`docs/`](docs/README.md):

| Document | Purpose |
| --- | --- |
| [API reference](docs/API.md) | Every HTTP endpoint with auth requirements |
| [Architecture](docs/ARCHITECTURE.md) | Layered design, services, events, plugins |
| [Deployment](docs/DEPLOYMENT.md) | Docker Compose, Kubernetes, systemd, hardening |
| [Integration guide](docs/INTEGRATION.md) | Connect your apps to Keystone |
| [Security model](docs/SECURITY.md) | Threat model and hardening checklist |
| [Performance](docs/PERFORMANCE.md) | Tuning and load-testing notes |
| [Contributing](docs/CONTRIBUTING.md) | Dev environment and PR process |
| [Roadmap](docs/ROADMAP.md) | Planned work |
| [ADRs](docs/adrs/) | Architecture decision records |
| [Changelog](CHANGELOG.md) | Release history |

The running API also serves interactive docs at `/documentation` (Swagger UI).

---

## License

MIT — Hilbras engineering. See [LICENSE](LICENSE).
