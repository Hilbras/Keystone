# Hilbras Keystone Documentation

Complete documentation for the Hilbras Keystone identity platform.

## Getting started

| Document | Purpose |
| --- | --- |
| [README](../README.md) | Feature overview, quick start, environment reference |
| [Installation & deployment](DEPLOYMENT.md) | Docker Compose, Kubernetes, systemd, production hardening |
| [Integration guide](INTEGRATION.md) | Connect your apps: tokens, sessions, OAuth2/OIDC, drop-in widget |

## Reference

| Document | Purpose |
| --- | --- |
| [HTTP API reference](API.md) | Every endpoint, grouped by area, with auth requirements |
| [Architecture](ARCHITECTURE.md) | Layered design, services, repositories, events, plugins |
| [Performance tuning](PERFORMANCE.md) | Connection pools, caching, indexes, load-testing results |
| [Security model](SECURITY.md) | Threat model, token lifecycle, storage, hardening checklist |
| [RBAC and authorization](RBAC.md) | Platform/organization role boundaries, policy evaluation, and migration |
| [v1.7 migration guide](MIGRATION-1.7.md) | Upgrade steps and breaking authorization changes |
| [v1.8 migration guide](MIGRATION-1.8.md) | MFA enforcement: new endpoints, response changes, and upgrade steps |
| [v1.9 migration guide](MIGRATION-1.9.md) | SCIM tenancy: per-organization credentials, deprovisioning semantics, and upgrade steps |
| [v1.7 release checklist](RELEASE-1.7.md) | Local gates, dependency/lint blockers, and publication steps |

## Contributing

| Document | Purpose |
| --- | --- |
| [Contributing guide](CONTRIBUTING.md) | Dev environment, branch and commit conventions, PR process |
| [Code of Conduct](../CODE_OF_CONDUCT.md) | Community standards and enforcement |
| [Changelog](../CHANGELOG.md) | Release history (Keep a Changelog format) |
| [Security policy](../.github/SECURITY.md) | How to report vulnerabilities |
| [Roadmap](ROADMAP.md) | Planned work and priorities |

## Architecture decision records

| ADR | Decision |
| --- | --- |
| [001 — Identity connectors as adapters](adrs/001-identity-connectors-as-adapters.md) | Provider-agnostic connector interface |
| [002 — Versioned event bus](adrs/002-versioned-event-bus.md) | Event envelope versioning strategy |
| [003 — BullMQ for background work](adrs/003-bullmq-for-background-work.md) | Queue technology choice |
| [004 — argon2id password hashing](adrs/004-argon2id-password-hashing.md) | Password hashing parameters |

## Guides by example

| Example | Demonstrates |
| --- | --- |
| [Drop-in login widget](../examples/drop-in-login/README.md) | Zero-build HTML integration via `/sdk/keystone-dropin.js` |
| [HTML drop-in](../examples/html-dropin/README.md) | Plain HTML pages with hosted UI |
| [React SPA](../examples/react-spa/README.md) | Token-based SPA with refresh rotation |
| [Login form (React)](../examples/login-form-react/README.md) | Custom-branded login against `/auth/*` |
| [SDK package](../packages/keystone-sdk/README.md) | `@hilbras/keystone-sdk` builds and SRI usage |
