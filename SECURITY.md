# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report it privately through [GitHub Security Advisories](https://github.com/Hilbras/Keystone/security/advisories/new)
("Report a vulnerability"), which is private between you and the maintainers until
an advisory is published.

Please include what you can: the affected version, the endpoint or configuration,
the request you made, what you expected, and what happened. A reproduction is
ideal but not required.

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement | 3 working days |
| Triage and severity assessment | 7 working days |
| Fix or mitigation plan | 14 working days |
| Public advisory | With the fix, or 90 days after mitigation, whichever is first |

Severity is assessed on impact, not on the fact that something is broken.
Findings that require an already-compromised signing key or database access are
rated accordingly.

We will tell you when a report is declined and why, and we will credit you in the
advisory unless you prefer otherwise.

## Supported versions

| Version | Supported |
| --- | --- |
| 3.0.x | ✅ |
| 2.6.x | ✅ |
| < 2.6 | ❌ |

Fixes land on the current minor line. There is no LTS designation.

## Security model

The full model — authentication, token lifecycle, storage, trust boundaries,
hardening checklist — is in **[docs/SECURITY.md](docs/SECURITY.md)**.

The short version of what Keystone is defending:

- **Credentials never belong to your app.** Keystone owns password hashing, token
  rotation, replay detection, session revocation and rate limiting. A client that
  accepts passwords has taken all of that on.
- **Tokens are verifiable offline.** Access tokens are RS256 JWTs, so a hot path
  can authorize without a network call.
- **Identity comes from credentials, never from headers.** Client-supplied
  identity headers are stripped before any plugin can read them.
- **Tenant scope is structural.** Every organization-owned operation resolves the
  organization from the request and checks membership there.

## Findings and their regression tests

Every vulnerability found during the hardening programme is recorded in
**[docs/security/registry.md](docs/security/registry.md)** with the issue, the fix,
the test that fails without it, and the documentation.

That registry is machine-enforced. `npm run registry:check` fails if an entry names
a test that does not exist, if a security suite is claimed by no entry, or if a
mandatory attack class is uncovered — so deleting a regression test breaks the
build rather than quietly removing a control.

The [re-audit matrix](docs/RE-AUDIT.md) reports the same coverage by finding
category, with each cell verified against the repository when it is generated.

## Hardening your deployment

Before considering Keystone production-ready:

- [ ] TLS terminated at the proxy
- [ ] `KEYSTONE_TRUSTED_PROXIES` set to that proxy's CIDR — without it the client
      address is the proxy's, and every rate limit is shared across all users
- [ ] `COOKIE_SECURE=true` (the default in production)
- [ ] `ALLOWED_ORIGINS` set explicitly — it **fails closed**, so an empty value
      denies every origin
- [ ] `KEYSTONE_ENCRYPTION_KEY` set to a unique 32-byte secret
- [ ] PostgreSQL backups tested, and the audit log monitored
- [ ] `npm run registry:check` and `npm run reaudit:check` in your own CI

Details in [docs/security/](docs/security/).
