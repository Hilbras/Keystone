# Hilbras Keystone — Full Upgrade Roadmap

This document defines the phased upgrade path to turn Keystone into a production-grade, enterprise-ready identity platform.

Each phase builds on the previous one and is designed to be implemented, tested, and deployed independently.

---

## Phase 1 — Admin Dashboard CRUD

**Goal:** Make the admin dashboard a fully functional management interface.

- [ ] Organizations tab: create, edit, deactivate organizations.
- [ ] Applications tab: register/edit OAuth/OIDC applications, rotate secrets, manage redirect URIs and origins.
- [ ] Users tab: create users, edit roles, deactivate, resend verification.
- [ ] Roles & permissions tab: view and modify role-permission mappings.
- [ ] Audit logs tab: filters, pagination, export.
- [ ] Identity providers tab: enable/disable connectors, view callback URLs.

**Outcome:** Operators can manage the platform without touching the API directly.

---

## Phase 2 — Internal SDK & Service Layer Hardening

**Goal:** Stabilize internal contracts and reduce coupling.

- [ ] Introduce a lightweight DI container (e.g., `tsyringe` or custom).
- [ ] Split services into Application Services and Domain Services.
- [ ] Add repository interfaces (`UserRepository`, `OrgRepository`, etc.).
- [ ] Standardize `Result<T>` objects across all internal services.
- [ ] Introduce `ConfigurationService` for validated, environment-aware config.

**Outcome:** Code is testable, modular, and ready for plugin expansion.

---

## Phase 3 — Background Job Queue & Event Bus

**Goal:** Move long-running work out of request handlers.

- [ ] Default to BullMQ when Redis is available; keep in-process fallback.
- [ ] Emit versioned events from the Event Bus (`type`, `version`, `timestamp`, `payload`).
- [ ] Queue processors for email, webhooks, workflow runs, analytics exports.
- [ ] Add retry policies, dead-letter queues, and job monitoring endpoint.

**Outcome:** API latency stays low and reliability improves.

---

## Phase 4 — Secrets & Security Hardening

**Goal:** Protect keys, credentials, and tokens at rest and in transit.

- [ ] Abstract `SecretsProvider` with implementations:
  - `DatabaseSecretsProvider`
  - `EnvironmentSecretsProvider`
  - `HashiCorpVaultProvider`
  - `AwsKmsProvider`
  - `AzureKeyVaultProvider`
- [ ] Automatic key rotation for JWT signing keys and encryption keys.
- [ ] Secure storage for client secrets, API keys, and connector credentials.
- [ ] Enforce mTLS for internal service endpoints.
- [ ] Add password breach checking (HIBP) by default.

**Outcome:** Enterprise security baseline is met.

---

## Phase 5 — Plugin Architecture

**Goal:** Allow extending Keystone without modifying core code.

- [ ] Define plugin manifest format and lifecycle hooks.
- [ ] Plugin types:
  - Identity connectors
  - Authentication methods
  - Email/SMS providers
  - Workflow steps
  - Analytics integrations
  - Custom authorization policies
- [ ] `registerPlugin()` API and plugin discovery from `KEYSTONE_PLUGINS` env var.
- [ ] Plugin isolation (error boundaries, separate dependency loading).

**Outcome:** Third parties and internal teams can extend Keystone safely.

---

## Phase 6 — Feature Flags & Configuration Profiles

**Goal:** Enable safe, gradual rollouts and simpler deployments.

- [ ] Feature flag service with env-var and database-backed providers.
- [ ] Flags for: beta auth methods, experimental workflow engine, enterprise features.
- [ ] Configuration profiles: development, production, docker, docker-compose, kubernetes, high-availability.
- [ ] Dry-run configuration validation endpoint.

**Outcome:** Reduced deployment risk and better multi-environment support.

---

## Phase 7 — Enterprise Identity Protocols

**Goal:** Support enterprise federation and provisioning.

- [ ] Full SAML 2.0 SP flow with metadata endpoint.
- [ ] SCIM 2.0 server for user/group provisioning.
- [ ] OIDC enterprise connector with custom claim mapping.
- [ ] Directory sync scheduling and webhook notifications.

**Outcome:** Keystone integrates with enterprise IdPs and directories.

---

## Phase 8 — Observability & Operations

**Goal:** Make Keystone observable and operable in production.

- [ ] Structured JSON logging with configurable levels.
- [ ] OpenTelemetry traces and metrics (already partially in place).
- [ ] Health check endpoints per dependency (db, redis, queue).
- [ ] Diagnostic report endpoint and export.
- [ ] Helm chart and Kubernetes manifests.
- [ ] CI/CD GitHub Actions for test, build, and release.

**Outcome:** Production deployments are monitorable and maintainable.

---

## Phase 9 — Workflow & Automation Engine

**Goal:** Turn workflows into a first-class product feature.

- [ ] Visual workflow editor in the admin dashboard.
- [ ] Triggers: user.signup, user.login, org.created, role.changed, etc.
- [ ] Built-in actions: send email, call webhook, assign role, create org, run custom script.
- [ ] Workflow execution history and replay.

**Outcome:** Admins can automate onboarding and security flows without code.

---

## Phase 10 — Billing & Multi-tenancy

**Goal:** Support SaaS delivery of Keystone.

- [ ] Organization-scoped billing plans and quotas.
- [ ] Usage metering (MAU, API calls, audit log retention).
- [ ] Stripe integration for subscriptions.
- [ ] Tenant isolation hardening and data residency hints.

**Outcome:** Keystone can be offered as a managed service.

---

## Implementation Rules

1. Each phase must leave the codebase in a working, testable state.
2. All new code follows existing TypeScript/Fastify patterns.
3. Every phase includes tests and README/ROADMAP updates.
4. No phase introduces breaking changes to existing public APIs without a migration path.

---

## Current Status

- ✅ Functional setup wizard
- ✅ Functional admin dashboard (read-only)
- ✅ Google OIDC connector
- ✅ Docker Compose & systemd deployment artifacts
- 🔄 Phase 1 in progress
