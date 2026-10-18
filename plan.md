# Hilbras Keystone

## Security Hardening, Architecture Stabilization & v1.6.0 → v3.0.0 Development Roadmap

**Current Version:** `1.6.0`
**Target Version:** `3.0.0`
**Project:** Hilbras Keystone
**Repository:** Hilbras/Keystone
**Package Registry:** npm
**Release Strategy:** Every phase produces a versioned GitHub Release and npm publication.

---

# 1. Roadmap Objectives

This roadmap takes Hilbras Keystone from the current `v1.6.0` release through a complete security, authorization, multi-tenancy, authentication, OAuth/OIDC, SCIM, infrastructure, testing, documentation, and release-quality hardening cycle.

The roadmap has five primary goals:

1. Eliminate all identified Critical and High security risks.
2. Strengthen Keystone's multi-tenant security model.
3. Harden authentication, MFA, OAuth/OIDC, SCIM, SAML, service accounts, and token handling.
4. Establish repeatable security testing and CI/CD security gates.
5. Establish a disciplined release process where every phase is independently versioned, documented, tested, published, and released.

The final `v3.0.0` release should represent a significantly hardened and stabilized Keystone architecture rather than simply a collection of patches.

---

# 2. Mandatory Release Rule

Every phase in this roadmap MUST follow the same release lifecycle.

For every version:

```text
Implementation
    ↓
Security Review
    ↓
Unit Tests
    ↓
Integration Tests
    ↓
Security / Regression Tests
    ↓
Typecheck
    ↓
Lint
    ↓
Build
    ↓
Dependency Audit
    ↓
Documentation Update
    ↓
README Version Update
    ↓
CHANGELOG Update
    ↓
Package Version Update
    ↓
Git Commit
    ↓
Git Tag
    ↓
GitHub Release
    ↓
npm Publish
    ↓
Post-release Verification
```

No phase is considered complete until all release artifacts have been updated.

---

# 3. Mandatory Documentation Updates

Every phase MUST review and update all documentation affected by the changes.

At minimum, review:

```text
README.md
CHANGELOG.md
package.json
package-lock.json
API documentation
Authentication documentation
OAuth/OIDC documentation
SCIM documentation
SAML documentation
MFA documentation
Organization / RBAC documentation
Deployment documentation
Environment variable documentation
Security documentation
Architecture documentation
Migration documentation
Examples
Configuration documentation
```

If a document does not require changes, verify that explicitly during the phase review.

Each release must update:

```text
Current Version
Latest Version
Installation Instructions
Configuration Examples
API Examples
Security Notes
Migration Notes
Breaking Changes
Known Limitations
```

---

# 4. Versioning Strategy

The roadmap uses the following version progression:

| Phase    | Version |
| -------- | ------: |
| Current  | `1.6.0` |
| Phase 1  | `1.7.0` |
| Phase 2  | `1.8.0` |
| Phase 3  | `1.9.0` |
| Phase 4  | `2.0.0` |
| Phase 5  | `2.1.0` |
| Phase 6  | `2.2.0` |
| Phase 7  | `2.3.0` |
| Phase 8  | `2.4.0` |
| Phase 9  | `2.5.0` |
| Phase 10 | `2.6.0` |
| Phase 11 | `2.7.0` |
| Phase 12 | `2.8.0` |
| Phase 13 | `2.9.0` |
| Final    | `3.0.0` |

Major version `2.0.0` will represent the first architectural/security hardening milestone.

Major version `3.0.0` will represent the final stabilized architecture after the complete roadmap.

---

# PHASE 1 — v1.7.0

# Critical Authorization & Privilege Escalation Fixes

## Objective

Eliminate the most dangerous authorization flaws identified during the security audit.

---

## 1. Organization Admin → Platform Owner Escalation

Audit finding:

An organization administrator can potentially manipulate the global `users.role` field through organization member management.

Current conceptual problem:

```text
Organization Role
    owner
    admin
    member

Global Platform Role
    owner
    user
```

These two authorization domains must never be interchangeable.

---

## Required Changes

Remove global platform role modification from organization member APIs.

Organization member APIs must only manipulate:

```text
organizationMembership.role
```

Allowed organization roles:

```text
owner
admin
member
```

Global platform roles must only be modified through a dedicated privileged endpoint.

Example conceptual separation:

```text
Organization Management
    ↓
Organization Membership Role

Platform Administration
    ↓
Global Platform Role
```

---

## 2. Platform Role Authorization

Create explicit authorization logic for platform-level role changes.

Requirements:

* Only platform owners may modify platform roles.
* Organization admins must never be able to modify global roles.
* Organization owners must never automatically receive platform-owner privileges.
* Membership roles must never be mapped directly to platform roles.
* All role transitions must be audited.

Add tests for:

```text
Organization Admin → Platform Owner
Organization Owner → Platform Owner
Organization Member → Platform Owner
Cross-Organization Role Escalation
Unauthorized Global Role Modification
```

All must fail appropriately.

---

## 3. Centralized Authorization Policy

Introduce a centralized authorization layer.

Instead of scattered checks:

```text
request.user.role === "owner"
```

use explicit policy functions.

Examples:

```text
requirePlatformRole()
requireOrganizationRole()
requirePermission()
requireResourceOwnership()
```

Authorization should clearly distinguish:

```text
Platform
Organization
Application
Resource
```

---

## 4. Audit Logging

Record:

* role changes
* membership changes
* permission changes
* failed authorization attempts
* platform role changes

Audit records should include:

```text
actor
target
organization
action
previous state
new state
timestamp
request metadata
```

---

## Testing

Add dedicated authorization regression tests.

Minimum coverage:

```text
Positive authorization tests
Negative authorization tests
Cross-tenant tests
Privilege escalation tests
Role boundary tests
```

---

## Release

Version:

```text
1.7.0
```

Update:

```text
README.md
CHANGELOG.md
Security documentation
RBAC documentation
API documentation
package.json
package-lock.json
```

Create:

```text
Git tag: v1.7.0
GitHub Release: v1.7.0
npm release: 1.7.0
```

---

# PHASE 2 — v1.8.0

# MFA / TOTP Security Rework

## Objective

Completely fix the current MFA enforcement problem.

---

# 1. Correct TOTP Verification

The current login flow must not pass the user ID as the TOTP secret.

Implement:

```text
User
 ↓
MFA configuration
 ↓
Encrypted TOTP secret
 ↓
Decrypt secret
 ↓
Verify TOTP
```

Never use:

```text
verifyTOTP(userId, code)
```

when the function expects the secret.

---

# 2. Mandatory MFA Enforcement

If MFA is enabled:

```text
Password valid
        ↓
MFA enabled?
   ┌────┴────┐
  No        Yes
  ↓          ↓
Token    MFA challenge
             ↓
        Verify factor
             ↓
           Token
```

A user with MFA enabled must never receive tokens before successfully completing MFA.

The following must be rejected:

```text
Password + no MFA code
Password + invalid MFA code
Password + expired MFA challenge
Password + reused MFA challenge
```

---

# 3. MFA Challenge Architecture

Introduce explicit authentication state:

```text
authenticated_password
requires_mfa
mfa_verified
authenticated
```

Do not issue normal access/refresh tokens while the user is in:

```text
requires_mfa
```

---

# 4. Token Login

Apply the same MFA rules to:

```text
/token-login
```

No alternate login flow may bypass MFA.

---

# 5. Backup Codes

Review:

* generation
* hashing
* single-use behavior
* expiration
* brute-force protection
* replay prevention

Use atomic consumption.

---

# 6. MFA Rate Limiting

Implement dedicated limits for:

```text
TOTP attempts
Backup code attempts
MFA challenges
Login attempts
```

---

# 7. MFA Security Tests

Add tests for:

```text
MFA enabled + missing code
MFA enabled + invalid code
MFA enabled + valid code
MFA disabled
Backup code reuse
Concurrent backup code consumption
TOTP replay
MFA challenge replay
Token issuance before MFA
/token-login MFA bypass
```

---

## Release

```text
v1.8.0
```

Update and publish all documentation and package artifacts.

Create GitHub Release and publish to npm.

---

# PHASE 3 — v1.9.0

# SCIM Multi-Tenant Security

## Objective

Make SCIM completely organization-scoped.

---

# 1. SCIM Connection Ownership

Every SCIM configuration must explicitly belong to:

```text
organizationId
```

Conceptually:

```text
SCIM Connection
      ↓
Organization
      ↓
SCIM Credential
      ↓
SCIM Resources
```

---

# 2. Organization-Scoped User Operations

Every SCIM operation must enforce:

```text
credential.organizationId
```

against the target resource.

Operations include:

```text
GET /Users
POST /Users
GET /Users/:id
PUT /Users/:id
PATCH /Users/:id
DELETE /Users/:id
```

No SCIM request should be able to access global users without organization authorization.

---

# 3. Organization-Scoped Groups

Apply the same isolation to:

```text
Groups
Group Members
Membership Updates
Group Deletion
Group Search
```

---

# 4. Repository Security

Avoid global repository methods such as:

```text
findUser(id)
deleteUser(id)
updateUser(id)
```

for SCIM operations.

Use:

```text
findOrganizationUser(orgId, userId)
updateOrganizationUser(orgId, userId)
deleteOrganizationUser(orgId, userId)
```

---

# 5. Tenant Isolation Tests

Create automated tests proving:

```text
Organization A cannot read Organization B
Organization A cannot update Organization B
Organization A cannot delete Organization B
Organization A cannot modify Organization B groups
Organization A cannot access Organization B SCIM resources
```

---

# 6. SCIM Credential Rotation

Implement:

```text
credential rotation
credential revocation
credential hashing
credential expiration
audit logging
```

---

## Release

```text
v1.9.0
```

Full documentation + README + CHANGELOG + GitHub Release + npm publish.

---

# PHASE 4 — v2.0.0

# Security Architecture 2.0

## Objective

Introduce the hardened security architecture and mark the transition to Keystone 2.x.

This is a major release.

---

# 1. mTLS Trust Boundary Rework

Remove trust in arbitrary identity headers.

Dangerous patterns such as:

```text
x-service-account-id
x-forwarded-client-cert
x-client-cert-fingerprint
```

must never automatically establish identity from untrusted clients.

---

# 2. Trusted Proxy Model

Define explicit trusted proxy configuration.

Example concept:

```text
Internet
   ↓
Trusted Reverse Proxy
   ↓
Keystone
```

Only trusted infrastructure may inject client certificate identity headers.

Keystone must reject spoofed headers when the request does not originate from a trusted proxy.

---

# 3. Service Account Identity

Service account identity must originate from:

```text
validated certificate
OR
authenticated credential
```

Never from a client-controlled header.

---

# 4. Proxy Security

Implement:

```text
trusted proxy IP ranges
header stripping
header validation
certificate fingerprint validation
certificate chain validation
```

Document the deployment requirements.

---

# 5. Security Boundary Documentation

Create:

```text
docs/security/trust-boundaries.md
docs/security/proxy-security.md
docs/security/mtls.md
```

Include deployment diagrams and threat assumptions.

---

# 6. Breaking Changes

Document all mTLS behavior changes as breaking changes.

Migration instructions must be included.

---

## Release

```text
v2.0.0
```

Mandatory:

```text
GitHub Release
npm publish
Git tag
README update
CHANGELOG
Migration guide
Security documentation
API documentation
```

---

# PHASE 5 — v2.1.0

# Dependency Security & Supply Chain Hardening

## Objective

Eliminate known vulnerable dependencies and establish continuous dependency security.

---

# 1. Fastify

Upgrade Fastify to a secure version.

Target:

```text
Fastify >= 5.12.2
```

Prefer the latest compatible secure version available during implementation.

---

# 2. fast-uri

Upgrade to:

```text
fast-uri >= 3.1.7
```

Verify the resolved dependency tree after upgrading.

---

# 3. Dependency Audit

Run:

```text
npm audit
```

and additional dependency security tooling.

Check:

```text
direct dependencies
transitive dependencies
optional dependencies
development dependencies
Docker dependencies
OS packages
```

---

# 4. Lockfile Integrity

Regenerate:

```text
package-lock.json
```

Verify:

```text
package.json
package-lock.json
npm package metadata
```

all reference the same release version.

---

# 5. Supply Chain Controls

Introduce:

```text
Dependabot/Renovate
npm audit
OSV scanning
dependency review
SBOM generation
container scanning
license scanning
```

---

## Release

```text
v2.1.0
```

---

# PHASE 6 — v2.2.0

# Token Security & Atomic Consumption

## Objective

Eliminate race conditions in token handling.

---

# 1. Refresh Token Rotation

Current conceptual problem:

```text
SELECT token
      ↓
Check valid
      ↓
REVOKE
      ↓
Create replacement
```

Two concurrent requests may both pass the validity check.

Replace with atomic consumption.

Example architecture:

```text
UPDATE refresh_tokens
SET revoked_at = NOW()
WHERE token_hash = ?
AND revoked_at IS NULL
RETURNING ...
```

Only one request may successfully consume the token.

---

# 2. One-Time Tokens

Apply the same pattern to:

```text
Magic Links
Password Reset Tokens
OTP Codes
Backup Codes
OAuth Authorization Codes
MFA Challenges
```

---

# 3. Replay Protection

Every single-use credential must have:

```text
expiration
single-use state
atomic consumption
replay detection
audit event
```

---

# 4. Concurrent Security Tests

Build tests that intentionally execute:

```text
10
50
100
```

concurrent requests using the same token.

Expected result:

```text
Exactly one successful consumption
```

---

## Release

```text
v2.2.0
```

---

# PHASE 7 — v2.3.0

# Session & Password Recovery Hardening

## Objective

Strengthen password recovery and session lifecycle security.

---

# 1. Password Reset

After successful password reset:

```text
Revoke all refresh tokens
Invalidate existing sessions
Invalidate outstanding recovery credentials
```

---

# 2. Session Revocation

Introduce centralized:

```text
revokeUserSessions()
revokeRefreshTokens()
revokeAuthenticationSessions()
```

---

# 3. Password Change

Apply appropriate session invalidation rules to:

```text
Password change
Password reset
Account recovery
Administrative password reset
```

---

# 4. Recovery Security

Ensure reset credentials are:

```text
cryptographically random
hashed at rest
single-use
short-lived
rate-limited
audited
```

---

# 5. Recovery Enumeration Protection

Prevent attackers from determining whether an email/account exists through password-reset responses.

---

## Release

```text
v2.3.0
```

---

# PHASE 8 — v2.4.0

# OAuth 2.0 / OIDC Security Hardening

## Objective

Strengthen OAuth/OIDC implementation against authorization and token abuse.

---

# 1. Authorization Code Atomic Consumption

Authorization codes must be consumed atomically.

---

# 2. PKCE

Enforce PKCE for:

```text
public clients
mobile clients
SPA clients
```

Prefer PKCE broadly wherever compatible with the architecture.

---

# 3. Scope Enforcement

Effective scopes must be calculated as:

```text
Registered Client Scopes
∩
Requested Scopes
∩
Organization Policy
∩
User Permissions
∩
Consent
```

Never trust arbitrary client-provided scope strings.

---

# 4. Redirect URI Validation

Implement strict redirect URI matching.

Do not allow:

```text
wildcard redirects
partial matching
unsafe normalization
open redirects
```

unless explicitly supported under a secure, documented policy.

---

# 5. OIDC Nonce

Implement strict nonce validation.

Add tests for:

```text
missing nonce
wrong nonce
reused nonce
expired nonce
valid nonce
```

---

# 6. ID Token Validation

Validate:

```text
issuer
audience
signature
expiration
issued-at
nonce
algorithm
key ID
```

---

# 7. Refresh Token Context

Persist and validate:

```text
organization
client
authentication context
scopes
consent
```

during refresh.

---

## Release

```text
v2.4.0
```

---

# PHASE 9 — v2.5.0

# Enterprise SSO / SAML / OIDC Hardening

## Objective

Harden enterprise identity federation.

---

# 1. Organization-Scoped SSO Membership

Membership checks must use:

```text
organizationId + userId
```

never only:

```text
userId
```

---

# 2. Atomic Membership Provisioning

Use a safe organization-scoped upsert.

Ensure:

```text
unique(orgId, userId)
```

---

# 3. OIDC Userinfo

Fix operator precedence and ensure configured endpoints are respected.

Explicitly test:

```text
custom userinfo endpoint
default userinfo endpoint
missing endpoint
invalid endpoint
```

---

# 4. SAML Security Suite

Create adversarial tests for:

```text
unsigned assertions
invalid signatures
wrong issuer
wrong audience
wrong destination
wrong ACS
expired assertion
NotBefore violation
NotOnOrAfter violation
InResponseTo mismatch
replay
RelayState tampering
XML signature wrapping
certificate rotation
```

---

# 5. Enterprise Configuration

Document:

```text
SAML setup
OIDC setup
certificate rotation
issuer configuration
audience configuration
ACS configuration
security recommendations
```

---

## Release

```text
v2.5.0
```

---

# PHASE 10 — v2.6.0

# Service Accounts, API Keys & Permission Scopes

## Objective

Harden machine-to-machine authentication.

---

# 1. Authentication Lifecycle

Correct lifecycle:

```text
Request
 ↓
Authenticate
 ↓
Resolve Organization
 ↓
Resolve Membership
 ↓
Resolve Service Account
 ↓
Authorize
 ↓
Execute
```

Authorization must never happen before required identity/context is available.

---

# 2. API Key Scope Registry

Create centralized scope definitions.

Example:

```text
users:read
users:write
organizations:read
organizations:write
tokens:read
tokens:revoke
webhooks:manage
```

---

# 3. Scope Intersection

Requested scopes must be constrained by:

```text
Allowed Service Account Scopes
∩
Organization Policy
∩
Application Permissions
```

---

# 4. API Key Security

Ensure:

```text
keys stored as hashes
prefix identifiers
expiration
rotation
revocation
last-used tracking
audit logs
scope enforcement
```

---

# 5. Service Account Security

Add:

```text
credential rotation
revocation
expiration
permission boundaries
audit logging
organization isolation
```

---

## Release

```text
v2.6.0
```

---

# PHASE 11 — v2.7.0

# Secrets, Configuration & Deployment Security

## Objective

Remove secret leakage and insecure deployment defaults.

---

# 1. Admin Configuration Endpoint

Never return raw secrets.

Sensitive values such as:

```text
DATABASE_URL
JWT private keys
SMTP passwords
Provider API keys
OAuth client secrets
Webhook secrets
```

must never be exposed through administrative configuration APIs.

Return:

```text
configured: true
masked value
metadata
rotation status
```

instead.

---

# 2. Setup Token Logging

Remove setup token logging.

Never write:

```text
setup token
password
private key
API secret
JWT secret
```

to logs.

---

# 3. Webhook Secrets

Prefer:

```text
encrypted-at-rest
```

if the plaintext secret must later be recovered.

Otherwise use:

```text
hash + one-time display
```

where architecture allows.

Add secret rotation.

---

# 4. Cookie Security

Production defaults:

```text
COOKIE_SECURE=true
HttpOnly=true
SameSite=Lax/Strict
```

Development may explicitly override these values.

---

# 5. CORS

Empty production origin configuration must not become:

```text
allow everything
```

Production must require explicit allowed origins.

---

# 6. Setup Server

Restrict setup server exposure.

Prefer:

```text
localhost
private interface
trusted admin network
```

over internet exposure.

Credentialed CORS must use a strict allowlist.

---

## Release

```text
v2.7.0
```

---

# PHASE 12 — v2.8.0

# Rate Limiting, Proxy Security & Abuse Prevention

## Objective

Make abuse protection resilient against Redis failures and proxy spoofing.

---

# 1. Redis Failure Behavior

Current behavior effectively allows requests when Redis is unavailable.

Implement:

```text
Distributed Redis limiter
+
Local emergency limiter
```

For security-sensitive endpoints.

---

# 2. Sensitive Endpoints

Apply strong limits to:

```text
login
register
password reset
magic links
MFA
OTP
token exchange
OAuth authorization
SCIM authentication
API key creation
```

---

# 3. X-Forwarded-For

Do not blindly trust:

```text
X-Forwarded-For
```

Configure Fastify `trustProxy` using explicit trusted networks.

Use the normalized:

```text
request.ip
```

after trusted proxy configuration.

---

# 4. Proxy Spoofing Tests

Test:

```text
spoofed XFF
multiple XFF values
direct access
trusted proxy access
untrusted proxy access
IPv4
IPv6
```

---

# 5. Abuse Monitoring

Introduce security events for:

```text
rate-limit triggered
authentication brute force
MFA brute force
token replay
invalid credentials
suspicious IP behavior
```

---

## Release

```text
v2.8.0
```

---

# PHASE 13 — v2.9.0

# Security Testing, CI/CD & Quality Gates

## Objective

Make the security improvements permanent and prevent regressions.

---

# 1. Security Test Suite

Create dedicated suites:

```text
security/
├── authentication/
├── authorization/
├── mfa/
├── oauth/
├── oidc/
├── saml/
├── scim/
├── mtls/
├── sessions/
├── tokens/
├── tenant-isolation/
├── api-keys/
├── service-accounts/
└── configuration/
```

---

# 2. Mandatory Security Tests

The CI pipeline must test:

```text
Privilege escalation
MFA bypass
Tenant isolation
Token replay
OAuth attacks
SCIM cross-tenant access
mTLS spoofing
XFF spoofing
API scope escalation
Secret disclosure
Session persistence
Password reset session invalidation
```

---

# 3. Static Security Analysis

Introduce:

```text
CodeQL
Semgrep
Gitleaks
Dependency Review
OSV
npm audit
```

---

# 4. Container Security

Add:

```text
Trivy
SBOM
base image scanning
OS package scanning
secret scanning
```

---

# 5. Release Security Gate

A release must fail if:

```text
Critical vulnerability exists
High vulnerability exists without explicit exception
security tests fail
typecheck fails
build fails
dependency audit fails
secret scanning fails
```

Exceptions must be documented.

---

# 6. Regression Protection

Every previously discovered vulnerability must receive a permanent regression test.

Create a security regression registry:

```text
SEC-001
SEC-002
SEC-003
...
```

Each security issue must map to:

```text
issue
fix
test
documentation
release
```

---

## Release

```text
v2.9.0
```

---

# FINAL PHASE — v3.0.0

# Keystone Security & Architecture Stabilization

## Objective

Finalize Keystone 3.0 as the hardened, documented, tested, production-ready architecture.

---

# 1. Full Security Re-Audit

Repeat the complete audit from:

```text
v1.6.0
```

and verify every original finding.

Create a matrix:

| Finding                  | Original Severity | Fixed  | Regression Test | Documentation |
| ------------------------ | ----------------- | ------ | --------------- | ------------- |
| Privilege escalation     | Critical          | Yes/No | Yes/No          | Yes/No        |
| MFA bypass               | Critical          | Yes/No | Yes/No          | Yes/No        |
| SCIM isolation           | Critical          | Yes/No | Yes/No          | Yes/No        |
| mTLS trust               | Critical          | Yes/No | Yes/No          | Yes/No        |
| Fastify vulnerability    | High              | Yes/No | Yes/No          | Yes/No        |
| fast-uri vulnerabilities | High              | Yes/No | Yes/No          | Yes/No        |
| Rate limiting            | High              | Yes/No | Yes/No          | Yes/No        |
| Token races              | High              | Yes/No | Yes/No          | Yes/No        |
| Session invalidation     | High              | Yes/No | Yes/No          | Yes/No        |
| OAuth hardening          | Medium/High       | Yes/No | Yes/No          | Yes/No        |
| SAML hardening           | Medium            | Yes/No | Yes/No          | Yes/No        |
| Secrets                  | Medium            | Yes/No | Yes/No          | Yes/No        |
| CORS                     | Medium            | Yes/No | Yes/No          | Yes/No        |
| CI security              | Medium            | Yes/No | Yes/No          | Yes/No        |

No unresolved Critical issue should remain for the `3.0.0` release.

---

# 2. Architecture Review

Review:

```text
Authentication
Authorization
Organizations
RBAC
ABAC / permissions
OAuth
OIDC
SAML
SCIM
MFA
WebAuthn
Sessions
Tokens
API Keys
Service Accounts
Webhooks
Secrets
Configuration
Audit Logs
Rate Limiting
Redis
Database
Proxy / mTLS
```

---

# 3. Multi-Tenant Security Review

Prove that every organization-owned resource is scoped by:

```text
organizationId
```

Review all repositories and services for dangerous global queries.

Search for patterns such as:

```text
findById()
updateById()
deleteById()
findUser()
```

and verify whether organization context is required.

---

# 4. API Security Review

Review every endpoint for:

```text
Authentication
Authorization
Tenant isolation
Input validation
Output filtering
Rate limiting
Audit logging
Error handling
Sensitive data exposure
```

---

# 5. Dependency Review

Confirm all dependencies are secure.

Run:

```text
npm audit
```

plus the configured supply-chain tools.

No known Critical/High vulnerability should remain without documented risk acceptance.

---

# 6. Performance Review

Review:

```text
N+1 queries
database indexes
Redis usage
authentication latency
token operations
SCIM bulk operations
organization queries
audit logging
rate limiting
```

---

# 7. Documentation Finalization

Update all documentation.

Required final documentation:

```text
README.md
CHANGELOG.md
SECURITY.md
CONTRIBUTING.md
ARCHITECTURE.md
API documentation
OAuth documentation
OIDC documentation
SAML documentation
SCIM documentation
MFA documentation
WebAuthn documentation
RBAC documentation
Organization documentation
Deployment documentation
Docker documentation
Environment documentation
Migration documentation
Security model documentation
Threat model
```

---

# 8. README Final Version

The README must clearly display:

```text
Hilbras Keystone
Version: 3.0.0
```

and include:

```text
Installation
Quick Start
Features
Authentication
Organizations
OAuth/OIDC
SAML
SCIM
MFA
WebAuthn
API Keys
Service Accounts
Security
Configuration
Deployment
Docker
Development
Testing
Contributing
License
```

---

# 9. CHANGELOG

The `CHANGELOG.md` must contain the complete progression:

```text
1.6.0
1.7.0
1.8.0
1.9.0
2.0.0
2.1.0
2.2.0
2.3.0
2.4.0
2.5.0
2.6.0
2.7.0
2.8.0
2.9.0
3.0.0
```

Each release must document:

```text
Added
Changed
Fixed
Security
Breaking Changes
Migration
Dependencies
```

---

# 10. Final Release Process

Before `v3.0.0`:

```text
Clean working tree
↓
All tests pass
↓
Security suite passes
↓
Dependency audit passes
↓
Secret scanning passes
↓
Container scanning passes
↓
Typecheck passes
↓
Lint passes
↓
Build passes
↓
Documentation verified
↓
Version verified
↓
CHANGELOG verified
↓
Git tag v3.0.0
↓
GitHub Release v3.0.0
↓
npm publish 3.0.0
↓
Install published package
↓
Run smoke tests against npm package
↓
Verify GitHub Release
↓
Verify npm package
↓
Post-release security verification
```

---

# 11. Version Consistency Requirement

For every release, the following must match:

```text
package.json
package-lock.json
README.md
CHANGELOG.md
Git tag
GitHub Release
npm package
```

Example for `v2.4.0`:

```text
package.json          → 2.4.0
package-lock.json     → 2.4.0
README.md             → 2.4.0
CHANGELOG.md          → 2.4.0
Git tag               → v2.4.0
GitHub Release        → v2.4.0
npm                   → 2.4.0
```

No release may be considered complete if these values disagree.

---

# 12. Git Release Convention

Use a consistent commit format.

Examples:

```text
security(auth): harden MFA enforcement
security(authz): prevent organization role escalation
security(scim): enforce organization isolation
security(mtls): harden certificate trust boundary
security(tokens): make refresh rotation atomic
security(oauth): enforce PKCE and scope boundaries
security(config): prevent secret disclosure
security(rate-limit): add fail-safe protection
```

Release commit:

```text
chore(release): v1.7.0
```

Git tags:

```text
v1.7.0
v1.8.0
v1.9.0
v2.0.0
...
v3.0.0
```

---

# 13. GitHub Release Requirements

Every version must have a GitHub Release.

Each release must contain:

```text
Release version
Release summary
Security changes
Features
Bug fixes
Breaking changes
Migration instructions
Dependency changes
Documentation changes
Testing status
Known limitations
```

Security fixes should clearly identify whether they address:

```text
Critical
High
Medium
Low
```

security findings.

Do not expose sensitive exploit details that would unnecessarily help attackers before affected deployments are upgraded.

---

# 14. npm Release Requirements

Every version must be published to npm after GitHub release validation.

Before publishing:

```text
npm pack
```

Inspect package contents.

Ensure:

```text
No secrets
No .env files
No private certificates
No development credentials
No unnecessary source files
No temporary files
No test secrets
```

Then publish the exact release version.

After publishing:

```text
npm install <package>@<version>
```

and run a smoke test against the published package.

---

# 15. Final v3.0.0 Acceptance Criteria

Keystone `3.0.0` is complete only when:

### Security

```text
Critical findings = 0
Known unresolved High findings = 0
```

unless an explicitly documented risk exception exists.

### Authentication

```text
MFA enforced
TOTP correct
WebAuthn hardened
Recovery hardened
Session revocation implemented
```

### Authorization

```text
No organization → platform privilege escalation
Centralized authorization
Strict role boundaries
Strict scope enforcement
```

### Multi-Tenancy

```text
Organization isolation verified
SCIM organization scoped
SSO organization scoped
Repository access audited
```

### OAuth/OIDC

```text
PKCE
strict redirect URI
scope enforcement
nonce validation
authorization code atomic consumption
refresh token rotation
```

### Enterprise Identity

```text
SAML adversarial tests
OIDC security tests
certificate rotation
organization-scoped provisioning
```

### Infrastructure

```text
mTLS trust hardened
trusted proxy configuration
XFF protection
Redis fail-safe rate limiting
secure CORS
secure cookies
```

### Secrets

```text
No secret disclosure
No secret logging
Webhook secret protection
Secure configuration API
Secure setup process
```

### Supply Chain

```text
Dependency scanning
SBOM
Container scanning
Secret scanning
CodeQL/SAST
Automated security gates
```

### Documentation

```text
README updated
CHANGELOG updated
API docs updated
Security docs updated
Migration docs updated
Architecture docs updated
```

### Release

```text
Git tag v3.0.0
GitHub Release v3.0.0
npm package 3.0.0
Published package smoke-tested
```

---

# 16. Final Roadmap

```text
v1.6.0
│
├── v1.7.0
│   └── Critical Authorization & Privilege Escalation
│
├── v1.8.0
│   └── MFA / TOTP Security Rework
│
├── v1.9.0
│   └── SCIM Multi-Tenant Security
│
├── v2.0.0
│   └── Security Architecture 2.0 / mTLS
│
├── v2.1.0
│   └── Dependency & Supply Chain Security
│
├── v2.2.0
│   └── Token Atomicity & Replay Protection
│
├── v2.3.0
│   └── Sessions & Password Recovery
│
├── v2.4.0
│   └── OAuth 2.0 / OIDC Hardening
│
├── v2.5.0
│   └── Enterprise SSO / SAML / OIDC
│
├── v2.6.0
│   └── Service Accounts / API Keys / Scopes
│
├── v2.7.0
│   └── Secrets / Configuration / Deployment
│
├── v2.8.0
│   └── Rate Limiting / Proxy / Abuse Prevention
│
├── v2.9.0
│   └── Security Testing / CI/CD Gates
│
└── v3.0.0
    └── Final Security & Architecture Stabilization
```

---

# 17. Non-Negotiable Rule for Every Phase

Every phase must finish with:

```text
CODE
+
TESTS
+
SECURITY REVIEW
+
DOCUMENTATION
+
README VERSION
+
CHANGELOG
+
PACKAGE VERSION
+
LOCKFILE
+
GIT COMMIT
+
GIT TAG
+
GITHUB RELEASE
+
NPM RELEASE
+
POST-RELEASE VERIFICATION
```

A phase is **not complete** simply because the code works.

The phase is complete only when the implementation, tests, security validation, documentation, version metadata, GitHub release, and npm publication are all synchronized.

---

# Final Target

**Hilbras Keystone v3.0.0**

The target architecture is:

```text
                     HILBRAS KEYSTONE 3.0
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
 Authentication          Authorization         Multi-Tenancy
        │                     │                     │
   MFA / TOTP             RBAC / Scopes        Organizations
   WebAuthn               Policies             SCIM
   Sessions               API Keys             Enterprise SSO
   Recovery               Service Accounts     SAML / OIDC
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │
                     OAuth 2.0 / OIDC
                              │
                     Secure Token Layer
                              │
              ┌───────────────┼───────────────┐
              │               │               │
           Security       Audit Logs       Rate Limits
              │               │               │
              └───────────────┼───────────────┘
                              │
                     Secure Infrastructure
                              │
             mTLS / Proxy / Redis / Database
                              │
                     CI/CD Security Gates
                              │
               Tests / SAST / SCA / SBOM
```

The `v3.0.0` release should therefore be treated as the completion of a full security and architecture hardening cycle, not merely a version bump.
