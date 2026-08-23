# Hilbras Keystone — Agent Guide

This document explains the architecture and conventions used in Keystone so agents (and humans) can navigate and extend the codebase consistently.

## Project overview

Keystone is a standalone identity platform. It provides:

- User authentication (password, OAuth, magic links, WebAuthn, TOTP, SMS OTP)
- Identity federation via OIDC connectors (Google, GitHub, Azure, Okta, Keycloak, Zitadel)
- Token issuance and validation (JWT access tokens, rotating refresh tokens, API keys)
- Authorization (RBAC/ABAC via `/v1/authz/check`)
- Organization and application management
- Audit logging, event bus, workflows, and background job processing

## Technology stack

- **Runtime:** Node.js 22, Fastify 5, TypeScript (ES modules)
- **Database:** PostgreSQL 16, Drizzle ORM, `postgres` driver
- **Cache / Queue:** Redis (ioredis), BullMQ optional
- **Tokens:** `jose`, RSA key pairs
- **Password hashing:** argon2id

## Directory layout

```
src/
  index.ts           # Application bootstrap, route registration, server start
  config.ts          # Environment-based configuration (read-only)
  container.ts       # DI container interface and global resolver
  di.ts              # Container factory and service wiring
  sdk/               # Internal SDK layer (stable contracts)
  routes/            # HTTP route handlers (Fastify plugins)
  services/
    application/     # Application services (use cases, HTTP agnostic)
    domain/          # Domain services (business rules)
    connectors/      # Identity provider adapters
    events/          # Event bus and subscribers
    queue/           # Background job queue abstraction
    secrets/         # Secrets provider abstraction
    plugins/         # Plugin registry and types
    workflows/       # Workflow engine
  repositories/      # Repository interfaces + Drizzle implementations
  db/                # Schema, migrations, seed scripts
  plugins/           # Fastify plugins (auth, audit, rate limit, etc.)
  lib/               # Shared utilities (Result<T>, errors)
frontend/            # React + Vite setup wizard and admin dashboard
```

## Layered architecture

Keystone follows a layered architecture:

```
Routes
  ↓
Application Services
  ↓
Domain Services
  ↓
Repositories
  ↓
Database / External providers
```

### Routes (`src/routes/`)

- Responsible only for HTTP concerns: parsing input, authentication, calling application services, returning responses.
- Must **not** contain business logic.
- Prefer using `request.server.container` or the SDK to access services.

### Application Services (`src/services/application/`)

- Execute use cases and orchestrate domain services.
- Return `Result<T>` objects instead of throwing.
- Are HTTP-agnostic and could be reused by CLI, workers, or gRPC.

### Domain Services (`src/services/domain/`)

- Encode business rules and invariants.
- Depend on repository interfaces, not concrete implementations.
- Return `Result<T>` or throw only for unrecoverable errors.

### Repositories (`src/repositories/`)

- Abstract persistence. Domain services depend on repository interfaces.
- Implementations live in `src/repositories/*.ts` (Drizzle-specific).
- Add new repository interfaces in `src/repositories/types.ts`.

## Dependency injection

Keystone uses a lightweight DI container defined in `src/container.ts` and built in `src/di.ts`.

Register a new dependency:

1. Add the interface to `Container` in `src/container.ts`.
2. Instantiate it in `buildContainer()` in `src/di.ts`.
3. Access it via `app.container.<name>` in routes or `resolve("<name>")` elsewhere.

Example:

```ts
const { userRepository } = app.container;
const user = await userRepository.findById(id);
```

## Result type

All internal service calls return `Result<T>` from `src/lib/result.ts`:

```ts
export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: KeystoneError };
```

Use helpers:

```ts
import { ok, err, errFromMessage } from "../lib/result.js";

if (!user) {
  return errFromMessage("NOT_FOUND", "User not found", 404);
}
return ok(user);
```

Routes should translate `Result<T>` failures into appropriate HTTP responses.

## Events and audit

Important actions emit events via `src/services/events/bus.ts`. Subscribers handle:

- Writing audit logs
- Sending webhooks
- Anomaly detection

Events are versioned. Include a version in every event:

```ts
emit({ type: "user.login", version: 1, payload: { userId } });
```

## Adding a feature

1. **Repository:** Define the interface in `src/repositories/types.ts` and implement it.
2. **Container:** Register the implementation in `src/di.ts`.
3. **Domain:** Add or update a domain service with business rules.
4. **Application:** Add an application service use case.
5. **SDK:** Expose the operation in `src/sdk/index.ts` if it should be reusable.
6. **Routes:** Add HTTP endpoints in `src/routes/`.
7. **Tests:** Add unit or integration tests.
8. **Docs:** Update `README.md` or this file if conventions change.

## Conventions

- Use ES modules (`"type": "module"`).
- Prefer explicit `import type` for type-only imports.
- Keep files focused; one route file per domain is fine.
- Do not add business logic to connectors or repositories.
- All secrets and credentials belong in the secrets provider or environment config.
