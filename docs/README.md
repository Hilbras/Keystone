# Hilbras Keystone Documentation

Complete documentation for the Hilbras Keystone identity platform.

## Start here

| Document | Purpose |
| --- | --- |
| [**How Keystone works, and how to connect it to your program**](HOW-KEYSTONE-WORKS.md) | The request lifecycle, and the five ways to integrate — with working code |
| [README](../README.md) | Feature overview, installation, quick start, configuration |
| [**Codebase analysis**](ANALYSIS-v3.0.1.md) | Measured engineering assessment at v3.0.1: scale, findings, what is strong |
| [**Roadmap v3.1.0 → v3.5.0**](ROADMAP-v3.1.0-v3.5.0.md) | The next five releases, each gated on a measurement |

## Getting started

| Document | Purpose |
| --- | --- |
| [Installation & deployment](DEPLOYMENT.md) | Docker Compose, Kubernetes, systemd, production hardening |
| [Performance tuning](PERFORMANCE.md) | Connection pools, caching, indexes, load-testing results |
| [Codebase analysis](ANALYSIS-v3.0.1.md) | Measured assessment: layering, error handling, data layer, test shape |
| [Roadmap v3.1.0 → v3.5.0](ROADMAP-v3.1.0-v3.5.0.md) | Five releases of measurement, correction and operability |

## Integrating

| Document | Purpose |
| --- | --- |
| [Integration guide](INTEGRATION.md) | Connect your apps: tokens, sessions, OAuth2/OIDC, by framework |
| [Login form integration](LOGIN_FORM_INTEGRATION.md) | Replace a custom login form with Keystone's hosted flow |

## Reference

| Document | Purpose |
| --- | --- |
| [HTTP API reference](API.md) | Every endpoint, grouped by area, with auth requirements |
| [Architecture](ARCHITECTURE.md) | Layered design, services, repositories, events, plugins |
| [RBAC and authorization](RBAC.md) | Platform/organization role boundaries and policy evaluation |

## Security

| Document | Purpose |
| --- | --- |
| [Security policy](../SECURITY.md) | How to report a vulnerability, supported versions, deployment checklist |
| [Security model](SECURITY.md) | Threat model, token lifecycle, storage, hardening checklist |
| [API security review](API-REVIEW.md) | Every route and the guard it carries |
| [Re-audit matrix](RE-AUDIT.md) | Every finding by category, generated and verified |
| [v1.6.0 re-audit](security/registry.md) | All 44 findings: issue, fix, regression test, documentation |

### Security topics

| Document | Purpose |
| --- | --- |
| [Trust boundaries](security/trust-boundaries.md) | What trusts what, and where identity comes from |
| [Proxy security](security/proxy-security.md) | Trusted proxies, `x-forwarded-for`, and why misconfiguration is expensive |
| [mTLS](security/mtls.md) | Certificate-bound service accounts |
| [Enterprise SSO](security/enterprise-sso.md) | SAML and OIDC connections, adversarial cases |
| [Scopes](security/scopes.md) | API key scopes, fail-closed enforcement, human-only operations |
| [Rate limiting](security/rate-limiting.md) | Budgets, keying, and the Redis-outage fallback |
| [Configuration and secrets](security/configuration.md) | Redaction, CORS, cookies, webhook secrets, the setup server |
| [Audit](security/audit.md) | Event versioning, abuse events, the CSV export |
| [Supply chain](security/supply-chain.md) | Scanners, the image finding no lockfile scanner could see |
| [Gate exceptions](security/registry-exceptions.md) | The only place a release gate may be waived |

## Migrating

| Document | Purpose |
| --- | --- |
| [v1.7](MIGRATION-1.7.md) | Authorization and role boundaries |
| [v1.8](MIGRATION-1.8.md) | MFA enforcement: new endpoints, response changes |
| [v1.9](MIGRATION-1.9.md) | SCIM tenancy: per-organization credentials |
| [v2.0](MIGRATION-2.0.md) | Trust boundaries, `KEYSTONE_TRUSTED_PROXIES`, encryption key |
| [v2.4](MIGRATION-2.4.md) | OAuth client authentication, strict redirect URIs, scopes |

`CHANGELOG.md` at the repository root carries the complete progression from 1.6.0.

## Reference material

| Document | Purpose |
| --- | --- |
| [Architecture decisions](adrs/) | Why the connectors, event bus, queue and hashing are what they are |
| [v1.7 release checklist](RELEASE-1.7.md) | What a release has to satisfy |
