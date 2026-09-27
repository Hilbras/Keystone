# Hilbras Keystone

**Current version: `2.8.0`**

> A provider-agnostic, API-first identity platform for Hilbras products and third-party applications.

Keystone is a **standalone identity platform**, not a wrapper around another identity system. It authenticates users, issues signed tokens, enforces authorization, audits every security decision, and federates identities from any OIDC provider.

---

## What Keystone becomes

- **Identity Provider (IdP)** — OIDC/OAuth2 provider with JWKS discovery.
- **Authentication Service** — email/password with mandatory MFA enforcement, social login, magic links, WebAuthn/Passkeys, TOTP, SMS OTP.
- **Authorization Engine** — RBAC/ABAC permissions with `/v1/authz/check`.
- **Token Authority** — short-lived JWT access tokens, rotating refresh tokens, opaque API keys.
- **Machine Identity Manager** — scoped, rotatable, auditable service credentials.
- **Federation Broker** — delegate login to Google, GitHub, Azure, Okta, Keycloak, Zitadel, or any OIDC provider and issue Keystone tokens.
- **Enterprise SSO** — SAML 2.0 and OIDC enterprise connectors with SCIM user provisioning.
- **Audit & Compliance** — immutable audit log, event bus, webhooks, and anomaly detection.
- **Workflow Platform** — configurable post-auth workflows (organization-scoped notification, email, and webhook steps).

---

## What's new in v2.8.0

- **A Redis outage no longer removes rate limiting.** When Redis was unavailable every limiter returned "allowed" — so during an outage, `login`, `mfa/verify`, `sms-otp/verify`, and the OAuth token exchange had **no limit at all**. An outage is precisely when unlimited attempts are worth having. Sensitive endpoints now fall back to a bounded in-process budget.
- **MFA verification is limited per login attempt, not per address.** The budget key included the submitted email, which that endpoint does not carry, so *every* second-factor verification from one address shared a single budget of 20. An attacker got 20 guesses, but so did an office behind one NAT — one busy office could lock out every legitimate MFA login. The key now includes the challenge.
- **Second-factor management is limited per user, not per address.** Same problem on the TOTP routes: 10 attempts shared across everyone behind an address. Brute-forcing a code is per-account, so a per-user budget is the right unit.
- **Credential spraying is capped.** The login budget was keyed on address *and* submitted address, so it stopped repeated guesses at one account but did nothing against an attacker varying the address across a thousand accounts from one host. A second, address-keyed budget bounds that.
- **A refused request is now recorded.** A rate-limit trip previously left no trace — a 429 and nothing else — so sustained guessing at `login` or `mfa/verify` was invisible except in aggregate. `rate_limit_triggered` records the endpoint, the client address, and **which limiter decided**, so a degraded local control is distinguishable from a healthy distributed one.
- **Failed logins are audited.** `user_login_failed` existed in the event vocabulary and was never emitted, so password guessing left no record. Now emitted for both `/login` and `/token-login`, without a user id, since the submitted address may match no account.
- **A replayed refresh token is detected and answered.** A second presentation of a consumed refresh token was indistinguishable from an unknown one. It now emits `refresh_token_replayed` and revokes the account's remaining credentials, because a replay means the token leaked.
- **API key creation is rate limited** like any other authentication event.
- **16 tests** covering the emergency limiter, proxy spoofing, and the abuse events.

## What's new in v2.7.0

> **Behavioural.** CORS now fails closed: with no `ALLOWED_ORIGINS` configured, browser origins are **refused** in production rather than allowed. Session cookies also default to `Secure` in production. If you relied on either default, set them explicitly before upgrading.

- **The admin config endpoint no longer leaks secrets** — redaction was a *denylist*, and it missed 12 of 24 secret-looking keys, including `SIGNING_KEY`, `JWT_SIGNING_KEY`, `SENDGRID_KEY`, `SAML_CERT`, `HMAC_KEY`, `KMS_KEY` and `DB_URL`. It is now an allowlist, so a key nobody has thought about is private by default rather than public.
- **CORS fails closed in production** — an empty `ALLOWED_ORIGINS` previously returned "allow", making an unset variable equivalent to permitting every origin on a server that sends credentialed cookies. It now refuses, and logs a warning at boot so a misconfiguration is visible before a browser is turned away.
- **The setup server no longer reflects any origin** — it creates the owner account and writes configuration, and was registered with `origin: true` plus credentials. Origins must now be listed, defaulting to its own loopback addresses.
- **The setup token is no longer printed to stdout** — it landed in container logs, journald, and whatever ships logs off the host, permanently, and is a full account-initialisation credential. It is now printed only on explicit `KEYSTONE_PRINT_SETUP_TOKEN=true`, and never in production.
- **Webhook signing secrets are encrypted at rest** — stored in plaintext, a database dump yielded a working signing key for every endpoint, letting an attacker forge deliveries the receiver would accept. Encrypted rather than hashed, because Keystone *signs* with the secret and so must be able to recover it. Existing plaintext rows keep working and upgrade on rotation.
- **Session cookies are `Secure` by default in production** — the default was `false`, so an operator who did not set it got cookies that would be sent over plain HTTP.
- **The setup server binds to loopback by default** — it inherited `0.0.0.0` from the main server, which is right for the main server and wrong for the one that creates the owner account.

## What's new in v2.6.0

- **API key scopes are now a real registry** — a single list of scope names with descriptions. A scope not in the registry cannot be granted, so there is no string a caller can invent, and a route that needs a scope names it from the list so enforcement cannot quietly drift out of date again.
- **Unknown scopes are refused, not dropped** — key creation previously stored whatever strings it was given. Silently discarding an unrecognised one hides a typo and leaves the caller believing they hold something they do not, so it now returns `400` listing what was rejected and what is allowed.
- **The `service_account` wildcard is gone** — the scope guard treated a key as holding *every* scope if its scope list merely contained the string `"service_account"`, and that string was client-suppliable at key creation. It is no longer a scope, and a key holding only it satisfies nothing.
- **The scope guard fails closed** — it previously returned early whenever `apiKeyScopes` was absent, which is indistinguishable from "this is a session", so a key that resolved without a scope list skipped the check entirely. It now keys off `apiKeyId`, which is set only when a machine credential authenticated.
- **Scopes are enforced** on key, session, and profile routes, so a key is limited to the operations its grant covers.
- **Profile and MFA scopes cannot be granted to a service account** — a machine's "profile" is a synthesized object with an id of `sa:<uuid>` that matches no user row, and it has no authenticator to enrol a second factor with.
- **A stated boundary for machine principals** — `requireHumanPrincipal` refuses a service account on TOTP, WebAuthn, SMS OTP, identity linking, consent, and userinfo routes, with an explicit `403` and an audit record, rather than relying on the synthetic principal happening to match no row.
- **Personal keys default to read-only** on the caller's own resources. The previous default, `api:read`, was not in any registry — a fair sign that nothing was checking it.

> **Note on reachability.** `app.authenticate` is JWT-only, so almost every route still refuses an API key outright. `GET /auth/validate` is the one route that accepts one, and it is where scope enforcement is observable end to end. What this release fixes is the enforcement machinery, so the next route to adopt key authentication inherits a real check.

## What's new in v2.5.0

- **The OIDC nonce now reaches the Google connector** — `GoogleConnector.exchangeCode` overrode the base method without forwarding its options, so the nonce added in 2.4.0 was silently discarded for the default provider. Every non-Google OIDC provider validated the nonce; Google, the most likely to be in use, did not.
- **The unsigned SAML `Issuer` is now validated** — the response-level `<saml:Issuer>` sits outside both signed regions, so rewriting it does not invalidate the signature, and nothing compared it to the registered IdP. An assertion could claim to come from a different identity provider. Keystone now checks it against the connection, as SAML 2.0 §2.5.1.5 requires. The assertion's own issuer is inside the signed region and was always covered.
- **`RelayState` verification returns false instead of throwing** — a malformed RelayState is a bad request an attacker fully controls, so it produced a 500 rather than a 400.
- **A missing userinfo endpoint is reported as unconfigured** — it was passed to the fetcher with a non-null assertion, surfacing a misleading "must be a valid URL" for a URL that was never set.
- **24 adversarial SAML tests** — tampered signatures, untrusted signing keys, rotated-out certificates, unsigned assertions, XML signature wrapping, issuer and audience substitution, destination and recipient prefix/superstring/case variants, expired and not-yet-valid assertions, `InResponseTo` mismatch, transaction replay, and five RelayState tampering scenarios.
- **[enterprise-sso.md](docs/security/enterprise-sso.md)** — SAML and OIDC setup, every check applied to an assertion or ID token, certificate rotation (and its lack of a grace period), endpoint SSRF policy, organization scoping, and recommendations.

## What's new in v2.4.0

> **Breaking.** The `authorization_code` grant now requires client authentication. A client redeeming an authorization code must present its `client_secret`; requests without one now receive `401 invalid_client`. Clients that were relying on the grant working without a secret must send it.

- **The authorization code grant now authenticates the client** — it previously looked the client up and redeemed the code without ever checking a secret, so the code and its PKCE verifier were the only factors. This violates RFC 6749 §3.2.1 for confidential clients.
- **`javascript:` and `data:` are refused as redirect URIs** — validation was `z.string().url()`, which accepts anything the URL parser accepts, including script-bearing schemes. A redirect URI is a value Keystone puts in a `Location` header on its own origin, so an org admin could previously register one and hand any user who authorized their app a redirect toward script execution. Also rejects wildcards, fragments, embedded credentials, and plaintext HTTP to non-loopback hosts.
- **Public clients are supported and must use PKCE** — a `public` client type is issued no secret at all, rather than a secret it is expected to ignore, and a database constraint keeps the two halves of a client type consistent. PKCE is then mandatory for it, because client authentication is the only thing a secretless client cannot do.
- **Scopes are intersected, not trusted** — the effective set is registered ∩ requested ∩ consented. A scope outside the registration is refused with `invalid_scope` rather than silently dropped, so a client asking for more than it has is visible instead of quietly downgraded. An empty registration preserves existing behaviour.
- **OIDC federation sends and verifies a nonce** — `state` already proved the callback belonged to a login this browser started, but nothing bound the *ID token* to it. Any ID token the provider considered valid was accepted, including one minted for a different user or session.
- **ID token verification is stricter** — algorithms are pinned rather than inferred from key material, and `exp`, `iat`, `iss`, `aud`, `sub` are *required* rather than merely checked when present. A token with no expiry was previously accepted indefinitely.
- **Refresh tokens carry the granted scope set** — rotation preserves the authorization context instead of dropping it at the first refresh, and a refresh can narrow the grant but never widen it.

## What's new in v2.3.0

- **A password reset now actually logs the attacker out** — completing a reset changed the password but left every existing session and refresh token working. A reset is the standard response to a suspected compromise, so this defeated its own purpose: whoever prompted the reset kept their access. Sessions, refresh tokens, and outstanding recovery credentials are now all invalidated.
- **An intercepted earlier reset email is dead** — reset tokens issued alongside the one used are now spent, so someone who captured a previous reset email cannot complete it after the user has already recovered.
- **One revocation layer** — `revokeUserSessions`, `revokeRefreshTokens`, `revokeAuthenticationSessions`, and `revokeRecoveryCredentials` live in one place. Revocation was previously open-coded per call site, which is how the reset path came to omit it; the MFA-enable path now routes through the same function so the rule cannot drift.
- **Recovery is left intact** — resetting revokes access but does not lock the user out: they can immediately log in with the new password. Covered by a test.

> **Not revoked on reset:** API keys. They are separately issued, long-lived credentials belonging to integrations rather than to the person, and killing them silently breaks deployments. The residual gap — a key minted by an attacker who already held the password — is real; see [SECURITY.md](docs/SECURITY.md) for why key expiry is the right fix.

## What's new in v2.2.0

- **Magic links can no longer be redeemed twice at once** — consumption was a conditional `SELECT` followed by an *unconditional* `UPDATE`. Any number of parallel redemptions passed the check and every one of them logged in. The write is now the gate, so exactly one succeeds.
- **Password reset tokens are spent exactly once** — the same race meant parallel resets each wrote a different password, last writer winning. This was the most consequential of the three, since whoever won held the account.
- **SMS OTP codes are spent exactly once** — same shape, same fix.
- **Replays are reported, not just refused** — a credential presented after it was already used now emits `magic_link_replayed`, `sms_otp_replayed`, or `password_reset_token_replayed`, which reaches the audit log. Previously a replay was indistinguishable from a typo, so a leaked token coming back was invisible. An *expired* credential is deliberately not reported as a replay, since that is not a leak.
- **One shared primitive** — all consumption goes through a single atomic claim, so the pattern exists once rather than in three places that can drift.

## What's new in v2.1.0

- **Dependency tree is clean** — `npm audit` reports zero vulnerabilities across production *and* development trees, including a transitive `esbuild@0.18.20` that `drizzle-kit` was pinning. Resolved with an `overrides` entry rather than `audit fix --force`, which offered only a breaking downgrade of `drizzle-kit`.
- **Continuous dependency security** — Dependabot for npm, GitHub Actions, and Docker; OSV scanning as an advisory source independent of npm's; enforced `npm audit`; dependency review on pull requests; SBOM generation; container scanning; and a license gate restricted to permissive terms.
- **Release metadata is verified** — `npm run verify:release` fails the build on a version that disagrees between `package.json` and the lockfile, a missing or malformed license, or a missing `repository` field. Runs in CI and again before `npm publish`.
- **The container image no longer ships a vulnerable npm** — the runtime image carried 8 HIGH-severity advisories inherited from the base image's bundled `npm@10.9.9`, invisible to `npm audit` and OSV because they are not in the dependency tree. npm is now removed from the production stage, which the app never invokes, clearing all 8 and shrinking the image from 600 MB to 550 MB.
- **The package now declares its license** — `package.json` had no `license` field despite shipping an MIT `LICENSE` file, so the published package carried no machine-readable terms.

## What's new in v2.0.0

> **Breaking.** Two changes affect every deployment. `x-service-account-id` no
> longer authenticates on its own, and `x-forwarded-for` is no longer believed
> unless `KEYSTONE_TRUSTED_PROXIES` is set — behind a proxy with it unset, all
> clients share one rate-limit budget. Read
> [MIGRATION-2.0.md](docs/MIGRATION-2.0.md) before upgrading.

- **A service account cannot be named into existence** — `x-service-account-id` previously authenticated as any service account named in the header, with no certificate and no credential. Identity now comes only from a certificate bound to the account or an authenticated credential.
- **Certificates are bound to a fingerprint** — a service account authenticates by a client certificate whose SHA-256 fingerprint is bound to it, uniquely. A fingerprint can map to at most one account, and malformed values are rejected before they reach the database.
- **Client identity headers are stripped from untrusted peers** — an `onRequest` hook removes them before routing and authentication, so no route can read a spoofed identity by accident.
- **Rate limits can no longer be escaped** — the limiter previously read `x-forwarded-for` unconditionally, so any client could present a fresh address per request and never be limited. Keys come from the peer address unless a trusted proxy forwarded one.
- **`KEYSTONE_TRUSTED_PROXIES`** names the proxies permitted to set identity headers. Unset by default, which trusts nothing.
- **Service accounts can be revoked** — `POST /v1/admin/organizations/:id/service-accounts/:accountId/revoke` stops both certificate and API-key authentication.
- **Documented trust boundaries** — [trust-boundaries.md](docs/security/trust-boundaries.md), [proxy-security.md](docs/security/proxy-security.md), and [mtls.md](docs/security/mtls.md).

## What's new in v1.9.0

- **SCIM is organization-scoped** — every SCIM connection belongs to exactly one organization, and every user and group read and write is filtered by it. A cross-tenant target returns `404`, so the endpoint is not a tenant oracle.
- **SCIM credentials are per organization** — bearer tokens are stored only as a SHA-256 digest, resolved by that digest, and can be expired, rotated, and revoked. Issuing, rotating, and revoking is owner-only.
- **Deprovisioning no longer reaches outside the tenant** — removing a user removes that organization's membership, and deactivates the account only when no membership remains anywhere. Previously it disabled a shared account in every organization that user belonged to.
- **Real SCIM groups** — create, read, replace, patch, and delete groups, manage members, and search. Replaces the old synthetic role-bucket projection.
- **New SCIM surface** — `PATCH /Users/:id`, `Users/.search`, `ServiceProviderConfig`, `ResourceTypes`, and `filter`/`startIndex`/`count`. Unsupported filters are rejected rather than silently ignored.

> **Migration:** `SCIM_BEARER_TOKEN` and `SCIM_ORG_ID` are deprecated. If still set they are adopted once into a connection and then ignored — including after a revocation, so a restart cannot resurrect a credential you revoked. See [MIGRATION-1.9.md](docs/MIGRATION-1.9.md).

## What's new in v1.8.0

- **MFA is mandatory** — a user with TOTP enabled never receives a token before completing the second factor. Password authentication stops at `requires_mfa`; only `POST /auth/mfa/verify` completes the login.
- **One-time MFA challenges** — opaque, short-lived, stored only as a hash, single-use, with an attempt budget enforced in the database.
- **A single token-issuance chokepoint** — a token cannot be minted for an MFA-enabled user without a recorded factor, so no login path can bypass MFA by omission.
- **TOTP verified against the user's own secret**, and each time-step is accepted exactly once, so a captured code is rejected even against a freshly issued challenge.
- **Hardened backup codes** — 80 bits of entropy, keyed (peppered) hashing, expiry, and single-use consumption via a conditional update.
- **Step-up on factor changes** — enrolling, confirming, disabling, or regenerating TOTP codes requires the account password, so a leaked session token cannot take over an account's second factor.
- **Enabling MFA revokes existing sessions and refresh tokens**, and refresh rotation refuses sessions with no recorded factor.
- **TOTP secrets are encrypted with AES-256-GCM**; values written by earlier versions remain readable.

> **Migration:** `/auth/login` and `/auth/token-login` return `401` with `code: "MFA_REQUIRED"` and a challenge when MFA is required. Clients must render a code step and call `/auth/mfa/verify`. See [MIGRATION-1.8.md](docs/MIGRATION-1.8.md).

## What's new in v1.7.0

- **Authorization boundary hardening** — platform roles (`owner`/`user`) and organization roles (`owner`/`admin`/`member`) are now separate namespaces.
- **Dedicated platform-role API** — platform role changes use `PATCH /v1/admin/platform/users/:userId/role` and require a platform owner.
- **Tenant-safe workflows** — organization workflows can no longer assign global roles or add cross-organization memberships.
- **Secret-safe user responses** — administrative and organization user responses use a redacted public projection.
- **Authorization auditing** — role, membership, permission, and denied-authorization events include actor, target, organization, and transition metadata.

> **Migration:** organization user PATCH/DELETE endpoints no longer mutate global accounts. Use the platform user administration endpoint for account-wide changes and organization member endpoints for membership roles.

## What's new in v1.6.0

- **Frontend overhaul** — React 19, Vite 8, Tailwind 4 (config migrated from JS to CSS `@theme` directive), TypeScript 7. Removed autoprefixer, postcss, tailwindcss-animate in favor of Tailwind 4 built-in features.

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
| `KEYSTONE_TOTP_ENCRYPTION_KEY` | Encrypts TOTP secrets and keys the backup-code hash. Falls back to `KEYSTONE_INTERNAL_API_KEY`. Must be stable — changing it invalidates enrolled authenticators |
| `MFA_CHALLENGE_TTL_SECONDS` | Lifetime of a login MFA challenge (default `300`) |
| `MFA_MAX_ATTEMPTS` | Factor attempts per challenge before it is locked (default `5`) |
| `TOTP_BACKUP_CODE_TTL_SECONDS` | Backup-code lifetime (default `7776000`, 90 days) |
| `SCIM_ROTATION_GRACE_SECONDS` | Grace window for a rotated SCIM token. Defaults to `0`, so rotation revokes the previous token |
| `SCIM_RATE_LIMIT_MAX` / `SCIM_RATE_LIMIT_WINDOW_SECONDS` | Per-credential SCIM request budget |
| `SCIM_AUTH_FAILURE_MAX` / `SCIM_AUTH_FAILURE_WINDOW_SECONDS` | Budget for unauthenticated SCIM requests, applied before authentication |
| `KEYSTONE_TRUSTED_PROXIES` | Comma-separated proxy IPs / CIDRs allowed to set client-identity headers. **Unset means trust nothing** — forwarded headers are stripped and all clients share one rate-limit budget. Required when Keystone runs behind a reverse proxy |

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
| POST | `/auth/login` | Email/password login (sets session cookies; returns `401 MFA_REQUIRED` + a challenge when MFA is required) |
| POST | `/auth/token-login` | Email/password login for SPA/dashboard (returns bearer token) |
| POST | `/auth/mfa/verify` | Complete a login MFA challenge and receive tokens |
| POST | `/auth/logout` | Revoke session |
| GET | `/auth/me` | Current user |
| POST | `/auth/refresh` | Rotate refresh token |
| GET | `/auth/oauth/:provider` | Start OAuth login (google, github, azure, okta, keycloak, zitadel) |
| GET | `/auth/callback/:provider` | OAuth callback |
| POST | `/auth/forgot-password` | Request password reset |
| POST | `/auth/reset-password` | Complete password reset |
| POST/GET | `/auth/api-keys` | Create / list personal API keys |
| DELETE | `/auth/api-keys/:id` | Revoke a personal API key |
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
| POST | `/v1/admin/organizations/:id/invites` | Invite a member with an organization role |
| GET | `/v1/admin/organizations/:id/members` | List redacted organization members |
| PATCH/DELETE | `/v1/admin/organizations/:id/members/:userId` | Update/remove an organization membership role |
| GET | `/v1/admin/organizations/:id/users` | List redacted users in the organization |
| GET | `/v1/admin/organizations/:id/users/:userId` | Read a redacted organization user |
| PATCH | `/v1/admin/platform/users/:userId` | Update non-role platform user fields (**owner only**) |
| PATCH | `/v1/admin/platform/users/:userId/role` | Change a platform role (`owner`/`user`, **owner only**) |
| GET | `/v1/admin/permissions` | **Owner only** — list all permissions |
| GET/POST | `/v1/admin/roles/:role/permissions` | **Owner only** — list / assign role permissions |
| DELETE | `/v1/admin/roles/:role/permissions/:permissionId` | **Owner only** — remove a role permission |
| GET | `/v1/admin/organizations/:id/api-keys` | List org-scoped API keys |
| DELETE | `/v1/admin/organizations/:id/api-keys/:keyId` | Revoke an org-scoped API key |
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
| GET/POST | `/v1/admin/platform/webhooks` | **Owner only** — list / create webhooks |
| PATCH | `/v1/admin/platform/webhooks/:id` | **Owner only** — update a webhook |
| DELETE | `/v1/admin/platform/webhooks/:id` | **Owner only** — delete a webhook |
| POST | `/v1/admin/platform/webhooks/:id/rotate-secret` | **Owner only** — rotate webhook secret |
| GET/POST | `/v1/admin/organizations/:id/saml-connections` | SAML connection management |
| DELETE | `/v1/admin/organizations/:id/saml-connections/:connectionId` | Delete a SAML connection |
| GET | `/v1/admin/organizations/:id/saml-connections/:connectionId/metadata` | SAML SP metadata |
| GET/POST | `/v1/admin/organizations/:id/oidc-connections` | OIDC connection management |
| DELETE | `/v1/admin/organizations/:id/oidc-connections/:connectionId` | Delete an OIDC connection |

### Enterprise SSO

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sso/saml/:connectionId` | Start SAML SSO login (requires `?orgId=`) |
| POST | `/sso/saml/acs` | SAML assertion consumer service |
| GET | `/sso/saml/:connectionId/metadata` | SAML SP metadata (requires `?orgId=`) |
| GET | `/sso/sso/oidc/:connectionId` | Start enterprise OIDC SSO login (requires `?orgId=`) |
| GET | `/sso/sso/oidc/:connectionId/callback` | Enterprise OIDC callback (requires `?orgId=`) |

> **Note:** the doubled `/sso/sso/oidc` segment is real, not a typo. The OIDC
> enterprise routes declare `/sso/oidc/...` *and* are mounted under the `/sso`
> prefix. SAML is mounted the same way but declares `/saml/...`, so it resolves
> cleanly to `/sso/saml/...`. Changing the OIDC path would break existing
> deployments, so it is scheduled for a future minor release.

### SCIM Provisioning

Every request is authorized by a per-organization SCIM connection and scoped to
that organization. Cross-tenant targets return `404`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/scim/v2/Users` | List users (filter, pagination) |
| GET | `/scim/v2/Users/:userId` | Get user by ID |
| POST | `/scim/v2/Users` | Provision or update a user |
| PUT | `/scim/v2/Users/:userId` | Replace user |
| PATCH | `/scim/v2/Users/:userId` | Partial update |
| DELETE | `/scim/v2/Users/:userId` | Deprovision user |
| POST | `/scim/v2/Users/.search` | Search users |
| GET | `/scim/v2/Groups` | List groups (filter) |
| GET | `/scim/v2/Groups/:groupId` | Get group by ID |
| POST | `/scim/v2/Groups` | Create group |
| PUT/PATCH/DELETE | `/scim/v2/Groups/:groupId` | Manage group |
| GET/POST | `/scim/v2/Groups/:groupId/members` | Manage group members |
| GET | `/scim/v2/ServiceProviderConfig` | Supported features |

Bearer tokens are created, rotated, and revoked per organization under
`/v1/admin/organizations/:id/scim-connections` (owner-only). The token is shown
once and stored only as a digest.

### MFA & Security

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/mfa/verify` | Complete a login MFA challenge and receive tokens |
| POST | `/auth/totp/enroll` | Begin TOTP enrollment (requires `password`) |
| POST | `/auth/totp/verify` | Confirm enrollment (requires `password` + `code`); revokes existing sessions |
| POST | `/auth/totp/disable` | Disable TOTP MFA (requires `password` + `code`) |
| POST | `/auth/totp/backup` | Regenerate backup codes (requires `password` + `code`) |
| POST | `/auth/totp/backup/verify` | Consume a backup code; never establishes a session |
| POST | `/auth/sms-otp/send` | Send SMS OTP |
| POST | `/auth/sms-otp/verify` | Verify SMS OTP |
| POST | `/auth/magic-link/send` | Send magic link |
| GET | `/auth/magic-link/verify` | Verify magic link |
| POST | `/auth/email-verification/send` | Send verification email |
| POST | `/auth/email-verification/request` | Request verification email |
| GET | `/auth/email-verification/verify` | Verify email token |
| GET | `/auth/webauthn/register/options` | WebAuthn creation options |
| POST | `/auth/webauthn/register/verify` | Register a WebAuthn credential |
| POST | `/auth/webauthn/authenticate/options` | WebAuthn assertion options |
| POST | `/auth/webauthn/authenticate/verify` | Authenticate and establish a session |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/sessions` | List active sessions |
| DELETE | `/auth/sessions/:id` | Revoke session |
| POST | `/auth/sessions/revoke-all` | Revoke all sessions |

### Workflows

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/admin/workflows?orgId=...` | List organization-scoped workflows |
| POST | `/v1/admin/workflows` | Create a workflow with safe steps and an `orgId` |
| GET | `/v1/admin/workflows/:id` | Get a workflow |
| DELETE | `/v1/admin/workflows/:id` | Delete a workflow |
| GET | `/v1/admin/workflows/:id/runs` | List workflow runs |

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

# Create a local platform user (use --role owner for a platform owner)
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
- Platform roles (`owner`, `user`) are never interchangeable with organization roles (`owner`, `admin`, `member`).
- Only platform owners can change platform roles; organization member APIs cannot mutate global users.
- User responses use a redacted public projection and never include password hashes, TOTP secrets, or sensitive metadata.
- All workflow operations require organization membership and reject authorization-mutating tenant steps.
- XML output (SAML metadata) is escaped to prevent injection.
- Rate limit nonces use cryptographically secure random bytes.
- Internal implementation details are not exposed in API responses.
- Input validation uses Zod schemas on all routes.
- Error messages are sanitized in production mode.
- **MFA is enforced before token issuance.** An account with TOTP enabled cannot receive a token until a second factor is verified, and the check happens at a single chokepoint rather than per route.
- TOTP secrets are stored encrypted with AES-256-GCM; backup codes are stored as a keyed, peppered hash, expire, and can only be consumed once.
- Changing how an account proves its identity — enrolling, confirming, disabling TOTP, or registering a passkey — requires the account password in addition to a valid session.
- **SCIM credentials are per organization.** Tokens are stored only as a digest, and every SCIM read and write is scoped to the credential's organization. A cross-tenant target is reported as not found.
- SCIM deprovisioning never reaches outside the caller's organization, and cannot remove the last owner of an organization.
- SCIM credential creation, rotation, and revocation are restricted to organization owners.

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
| [v1.8 migration guide](docs/MIGRATION-1.8.md) | Mandatory MFA: new endpoints, response changes, upgrade steps |
| [v1.9 migration guide](docs/MIGRATION-1.9.md) | SCIM tenancy: per-organization credentials, deprovisioning semantics, upgrade steps |
| [Performance](docs/PERFORMANCE.md) | Tuning and load-testing notes |
| [Contributing](docs/CONTRIBUTING.md) | Dev environment and PR process |
| [Roadmap](docs/ROADMAP.md) | Planned work |
| [ADRs](docs/adrs/) | Architecture decision records |
| [Changelog](CHANGELOG.md) | Release history |

The running API also serves interactive docs at `/documentation` (Swagger UI).

---

## License

MIT — Hilbras engineering. See [LICENSE](LICENSE).
