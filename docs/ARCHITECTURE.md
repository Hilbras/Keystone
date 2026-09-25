# Keystone Architecture

This document describes the high-level architecture of Hilbras Keystone and the conventions used across the codebase.

## Goals

- Be a standalone identity platform, not a wrapper around another IdP.
- Keep business logic independent of HTTP so the same code can be used by routes, CLI, workers, and future transports.
- Treat every provider as optional and replaceable.
- Emit auditable, versioned events for every security-relevant action.
- Support horizontal scaling through Redis-backed state and background queues.

## Layered architecture

```
Routes / CLI / Workers / Webhooks
        │
        ▼
Application Services (use cases, orchestration)
        │
        ▼
Domain Services (business rules)
        │
        ▼
Repositories (persistence abstraction)
        │
        ▼
PostgreSQL / Redis / External APIs
```

### Routes

Fastify routes are thin. They validate input, call application services or the internal SDK, and format responses. They contain no business logic.

### Application services

Application services coordinate domain services for a specific use case. Examples:

- `AuthenticationApplicationService` — login, register, refresh, logout flows.
- `OrganizationApplicationService` — create org, invite members, manage apps.

### Domain services

Domain services encode business rules and depend on repository interfaces:

- `AuthenticationDomainService`
- `AuthorizationDomainService`
- `IdentityDomainService`
- `OrganizationDomainService`

### Repositories

Repository interfaces (`UserRepository`, `OrganizationRepository`, etc.) hide persistence details. Drizzle ORM implementations live in `src/repositories/`.

## Authorization boundaries

Authorization is evaluated in two independent namespaces:

- **Platform:** `users.role` is limited to `owner` and `user`. Only the explicit platform-role use case and owner-only route may change it.
- **Organization:** `org_memberships.role` is limited to `owner`, `admin`, and `member`, and is always queried by `(organizationId, userId)`.

Route pre-handlers authenticate the actor and resolve organization membership from trusted database state. Application/domain services enforce actor/target role transitions and last-owner invariants. Client-controlled application or origin headers are context hints only and never establish membership or permission.

The internal identity update contract separates ordinary profile updates from platform-role changes. User-management HTTP responses use a redacted public projection. Role, membership, permission, and denied-authorization transitions emit versioned audit events.

## Dependency injection

`src/di.ts` wires the container. Services receive dependencies through constructors, making unit tests with mocked repositories easy. The container is exposed to Fastify as `app.container` and can be retrieved globally via `getContainer()`.

## Internal SDK

The SDK (`src/sdk/`) provides stable TypeScript contracts for the rest of the application:

```ts
const sdk = getSdk();
await sdk.authentication.login({ email, password });
await sdk.identity.findUser(userId);
await sdk.organization.createOrganization({ name: "Acme" });
```

Routes, CLI commands, workers, and workflows all consume the same SDK.

## Identity connectors

Connectors live in `src/services/connectors/` and are pure provider adapters. They only:

- Build authorization URLs.
- Exchange codes for tokens.
- Validate identity tokens.
- Retrieve and normalize profile data.

They do **not** create users, link identities, issue Keystone tokens, or manage sessions. Those responsibilities live in domain services.

Supported connectors include Google, GitHub, Azure AD, Okta, Keycloak, and Zitadel. Enterprise SAML connections are handled through `samlify` with signature validation.

## Event bus

Every security-relevant action emits a versioned event:

```json
{
  "type": "user.login",
  "version": 1,
  "timestamp": "2026-07-13T00:00:00Z",
  "payload": { "userId": "...", "ip": "..." }
}
```

Subscribers consume events for audit logging, webhooks, anomaly detection, analytics, and workflow triggers. Long-running work is dispatched to the background queue.

## Background queue

Keystone supports an in-process queue for local development and a BullMQ-backed queue for production. Set `KEYSTONE_QUEUE_PROVIDER=bullmq` or leave it empty when Redis is available. The queue runs email delivery, webhooks, and workflow actions asynchronously.

## Secrets management

The secrets provider abstraction supports multiple backends:

- `DatabaseSecretsProvider` (default)
- `EnvironmentSecretsProvider`
- Enterprise backends via plugins or future built-in providers

It handles JWT signing keys, encryption keys, password hashes, API keys, and client secrets. JWT signing keys are rotated with a 24-hour grace period; the JWKS endpoint publishes both the active and the expiring key so existing tokens remain valid.

## Rate limiting

A Redis-backed sliding-window rate limiter protects public endpoints. It uses an atomic Lua script and returns `429 Too Many Requests` with a `Retry-After` header. If Redis is unavailable it fails open so the service remains functional.

## Plugins

The plugin registry (`src/services/plugins/`) lets third-party code extend Keystone without modifying core:

- Identity providers and authentication methods
- Email and SMS providers
- Workflow steps
- Custom authorization policies

Load plugins at startup via `KEYSTONE_PLUGINS=./plugins/my-plugin.js`.

## Configuration and feature flags

`ConfigurationService` centralizes loading, defaults, validation, and environment-specific overrides. Feature flags can be toggled at runtime through `KEYSTONE_FEATURE_FLAGS`.
