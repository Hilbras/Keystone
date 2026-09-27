# How Keystone works, and how to connect it to your program

A single document covering both halves: what Keystone actually does when a request
arrives, and the five ways to connect a program to it — with working code.

If you only need one thing, jump to [Choosing an integration](#choosing-an-integration).

---

## Contents

- [What Keystone is](#what-keystone-is)
- [How a request flows through Keystone](#how-a-request-flows-through-keystone)
  - [The plugin order is the security model](#the-plugin-order-is-the-security-model)
  - [How a caller is identified](#how-a-caller-is-identified)
  - [How tokens are issued](#how-tokens-are-issued)
  - [What every action produces](#what-every-action-produces)
- [Choosing an integration](#choosing-an-integration)
- [1. OIDC / OAuth 2.0 — any language, any framework](#1-oidc--oauth-20--any-language-any-framework)
- [2. Login form — host Keystone's own pages](#2-login-form--host-keystones-own-pages)
- [3. API keys — backend to backend](#3-api-keys--backend-to-backend)
- [4. Import the SDK — same process, typed](#4-import-the-sdk--same-process-typed)
- [5. SAML — for software that only speaks SAML](#5-saml--for-software-that-only-speaks-saml)
- [6. SCIM — provisioning users from an IdP](#6-scim--provisioning-users-from-an-idp)
- [7. Webhooks — Keystone calling you](#7-webhooks--keystone-calling-you)
- [Verifying a token yourself](#verifying-a-token-yourself)
- [Authorizing](#authorizing)
- [Connecting a framework you have not heard of](#connecting-a-framework-you-have-not-heard-of)
- [Common mistakes](#common-mistakes)
- [Where to go next](#where-to-go-next)

---

## What Keystone is

Keystone is an **identity server**. It owns users, credentials, sessions, tokens
and organization membership, and it answers one question for the rest of your
stack: *who is this, and are they allowed to do this?*

It is deliberately a **server, not a library you vendor**. The reason is the one
that matters for an identity provider: the security properties that are easy to
get wrong — password hashing, token rotation, replay detection, session
revocation, rate limiting — are exactly the properties that get wrong when each
application reimplements them. One implementation, used by everything, is the
control.

That does mean it is a **dependency with state**. It needs PostgreSQL and Redis,
it needs a signing key, and it is online when your app is online. Plan for it that
way from the start.

---

## How a request flows through Keystone

Keystone is a Fastify application. Understanding its plugin order is understanding
its security model, because Fastify hooks run in registration order and a guard
placed before the thing it guards is inert.

### The plugin order is the security model

```
1. requestLogger            structured logging, request id
2. headerSanitization  ◄──  strips client-supplied identity headers
3. swagger / swaggerUi       API documentation
4. cors                     origin policy, fails closed
5. cookie                   cookie parsing
6. auditPlugin              records state-changing actions
7. globalRateLimit          coarse per-address limit, on onRequest
8. appContext               request.state, audit helpers
9. auth                ◄──  identifies the caller
10. machinePrincipal   ◄──  rejects machine principals on human-only routes
11. permissions        ◄──  requirePermission / requireScopes
12. mtls               ◄──  certificate-bound service accounts
13. metrics
14. routes
```

Three things in that list are load-bearing:

**`headerSanitization` is first, before everything.** A client that sends
`x-user-id` or `x-service-account-id` has those headers *removed* before any
plugin or route can read them. If sanitization ran later, one plugin trusting
those headers would be an authentication bypass. The header a client controls is
never the header the server trusts.

**`auth` must come before `machinePrincipal`.** The guard that refuses
human-only operations to service accounts works by inspecting
`request.serviceAccount` — and only `auth` populates it. In the wrong order the
guard is present, exported, called, and silently permits everything. It is
enforced by a Semgrep rule precisely because no type checker or linter reports
this.

**`audit` records, it does not gate.** A write failure is logged rather than
thrown, because refusing to authenticate a user because the audit table is
unavailable is a worse outcome than a gap in the log. Which is exactly why a
silent audit failure is dangerous: the request succeeds, and an absent record is
indistinguishable from a request that never happened. (This was a real defect —
see SEC-046, where every service-account request produced no audit row at all.)

### How a caller is identified

Keystone resolves a caller in one of four ways. All of them end with a
`request.user`, so routes do not care which was used.

| Credential | How it is presented | Identified as |
| --- | --- | --- |
| **Session** | `keystone_session` cookie, or `Authorization: Bearer <access token>` | a user |
| **API key** | `Authorization: Bearer sk_…` on key-capable routes | a user, with narrowed scopes |
| **mTLS certificate** | client certificate on a trusted port | a service account bound to that certificate's fingerprint |
| **Opaque challenge** | the challenge string from a `requires_mfa` login | nothing yet — it is pre-token |

The mTLS path is worth understanding. A machine principal is represented
in-memory by a user object whose id is the sentinel `sa:<uuid>`, so routes that
expect `request.user` keep working without a matching user row. The identity is
derived from the **verified certificate**, and the certificate's fingerprint must
match the fingerprint stored against that service account. A valid certificate
from the same CA is not enough — possession of *any* certificate is not
authorization.

### How tokens are issued

Every path that mints a token goes through **one chokepoint**. Login, token
login, refresh, OAuth token exchange, SAML assertion, OIDC callback, SSO — all
of them. That is the whole reason MFA enforcement works: there is no second door.

```
password ──┐
magic link ─┤
SMS OTP ────┤
TOTP ───────┼──► token-issuance chokepoint ──► access token (JWT, RS256)
refresh ───┤                                          + refresh token (rotating)
SSO ───────┘
                     │
                     └─► MFA state checked here, not at login
```

Two token properties that matter when you integrate:

- **Access tokens are JWTs, signed RS256.** Verifiable without a network call.
  See [Verifying a token yourself](#verifying-a-token-yourself).
- **Refresh tokens rotate.** Every use returns a new refresh token and
  invalidates the old one. If you persist a refresh token, **replace it on every
  response** — a client that keeps presenting the old one gets treated as a
  replay, and Keystone revokes the account's remaining credentials. That is
  deliberate: a second presentation means the token leaked.

Session cookie names are client-scoped when you pass a `client_id`:
`app-<client_id>-session` and `app-<client_id>-session-refresh`.

### What every action produces

State-changing requests emit a **versioned event** (`user_login:v1`) that lands
in an immutable audit log. The same bus drives webhook delivery and anomaly
detection. Two things follow for you:

- You can read the audit log, and export it as CSV.
- You can subscribe to it with a webhook, signed.

See [Webhooks](#7-webhooks--keystone-calling-you).

---

## Choosing an integration

| Your program | Use | Why |
| --- | --- | --- |
| SPA, mobile, anything with a browser | **OIDC authorization code + PKCE** | No shared secret. Standard. Every language has a client. |
| Server-rendered web app | **OIDC**, or **host Keystone's login page** | Use the redirect flow; do not proxy passwords through your app. |
| Backend service, cron job, script | **API key** | A credential with explicit scopes, revocable, no user in the loop. |
| Same process, TypeScript | **Import the SDK** | Typed, no HTTP hop, no serialization. |
| Enterprise software that speaks only SAML | **SAML** | Keystone acts as the SP and brokers to your IdP. |
| Provisioning users/groups from an IdP | **SCIM** | Standard provisioning protocol. |
| You need Keystone to *call* you | **Webhook** | Signed HTTP callback. |
| Machine identity, server-to-server, no user | **mTLS service account** | Certificate-bound. |

**The one rule that matters most:** if a human types a password, let *Keystone*
handle it. Do not accept passwords in your app and forward them. Every integration
below does this — they are ordered by how much you should prefer them.

---

## 1. OIDC / OAuth 2.0 — any language, any framework

**Use this unless you have a reason not to.** It is a standard protocol, so any
OIDC client library works, and there is no Keystone-specific SDK to keep in sync.

### Discovery

Point your client at the discovery document and it configures itself:

```
GET https://keystone.example.com/.well-known/openid-configuration
GET https://keystone.example.com/.well-known/jwks.json
```

The discovery document advertises `authorization_endpoint`, `token_endpoint`,
`userinfo_endpoint`, and the supported `scopes` and `response_types`. Public
clients (SPAs, mobile) must use PKCE with `S256`; the authorization server
requires it.

### The flow

```
  browser                your app                Keystone
     │                      │                       │
     │  click "Sign in"    │                       │
     │ ────────────────────>│                       │
     │                      │  redirect + PKCE      │
     │<─────────────────────────────────────────────│
     │                      │                       │
     │  callback?code&state                       │
     │ ────────────────────>│                       │
     │                      │  POST /oauth2/token   │
     │                      │  (code + verifier)    │
     │                      │ ─────────────────────>│
     │                      │  access + refresh     │
     │                      │<─────────────────────│
     │                      │  GET /oauth2/userinfo │
     │                      │ ─────────────────────>│
     │                      │  user profile         │
     │                      │<─────────────────────│
```

### Any language

The pattern is identical everywhere; only the library differs. In every case:
redirect, exchange the code with the verifier, keep the refresh token, replace it
on every use.

**Node / TypeScript** — `openid-client`:

```ts
import * as client from "openid-client";

const config = await client.discovery(
  new URL("https://keystone.example.com"),
  "my-client-id",
  "my-client-secret"
);
```

**Python** — `authlib`:

```python
from authlib.integrations.flask_client import OAuth
oauth = OAuth()
oauth.register(
    name="keystone",
    client_id="my-client-id",
    client_secret="my-client-secret",
    server_metadata_url="https://keystone.example.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid profile email"},
)
```

**Go** — `coreos/go-oidc`:

```go
provider, err := oidc.NewProvider(ctx, "https://keystone.example.com")
config := &oauth2.Config{
    ClientID:     "my-client-id",
    ClientSecret: "my-client-secret",
    Endpoint:     provider.Endpoint(),
    Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
    RedirectURL:  "https://app.example.com/callback",
}
```

**Java / Kotlin** — `spring-boot-starter-oauth2-client`, with
`spring.security.oauth2.client.provider.keystone.issuer-uri` set to your Keystone
URL. Spring reads discovery itself.

**Ruby** — `omniauth-oidc`, **.NET** — `Microsoft.AspNetCore.Authentication.OpenIdConnect`,
**PHP** — `league/openid-connect-php`, **Rust** — `openidconnect`, **Swift** —
`AppAuth`, **Dart/Flutter** — `flutter_oidc`. All of them are configured with the
same three values: issuer URL, client id, client secret.

### A browser SPA

Public clients have no secret, so PKCE is what protects the code. Never put a
client secret in browser code.

```ts
// Generate a verifier and its S256 challenge, store the verifier in sessionStorage,
// then redirect:
const verifier = base64url(randomBytes(32));
sessionStorage.setItem("pkce_verifier", verifier);
const challenge = base64url(await sha256(verifier));
location.assign(
  `${issuer}/oauth2/authorize?` +
  new URLSearchParams({
    response_type: "code",
    client_id: "my-spa",
    redirect_uri: location.origin + "/callback",
    scope: "openid profile email",
    state: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
);
```

On the callback, exchange the code **with the verifier from sessionStorage**, then
verify the `nonce` in the ID token matches the one you sent. The nonce is what
stops a token minted for another session being replayed into yours.

> React and Vue helpers already exist: `@hilbras/keystone-react` and
> `@hilbras/keystone-vue`. See [docs/INTEGRATION.md](INTEGRATION.md).

### Check authorization

Once you know who the user is, ask Keystone what they may do. Do not reimplement
role logic in your app — that is the duplication this system exists to prevent.

```
POST /v1/authz/check
{ "userId": "...", "orgId": "...", "resource": "application", "action": "create" }
```

```ts
const { allowed } = await fetch(`${KEYSTONE}/v1/authz/check`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ orgId, resource: "application", action: "create" }),
}).then((r) => r.json());
```

---

## 2. Login form — host Keystone's own pages

If you want a login page but do not want to handle credentials, redirect to
Keystone's hosted flow. Your form is a button.

```
https://keystone.example.com/auth/login?client_id=<id>&redirect_uri=<url>
```

Keystone handles password, magic link, SMS OTP, TOTP, WebAuthn and SSO, and
returns to your `redirect_uri` with a session cookie scoped to that client.

This is the **recommended** shape for a custom login form, and
[docs/LOGIN_FORM_INTEGRATION.md](LOGIN_FORM_INTEGRATION.md) walks through
replacing form handlers with it.

**Do not** build a form that posts a password to your backend and forwards it to
Keystone. That reintroduces the exact problem Keystone solves: your app now holds
credentials, and your app's logs, error handlers and breach surface include them.

---

## 3. API keys — backend to backend

For a service acting as itself, with no user in the loop.

```bash
# Create a key against a user, with explicit scopes.
POST /auth/api-keys
{ "name": "billing-worker", "scopes": ["api_keys:read"] }
# -> { "key": "sk_...", ... }   shown once
```

```bash
curl https://keystone.example.com/auth/api-keys \
  -H "Authorization: Bearer sk_..."
```

Rules that catch people out:

- **Scopes are enforced and there is no wildcard.** Every scope is named. A key
  holding `api_keys:read` cannot read anything else. A `service_account` scope
  used to be a wildcard and was removed in 2.6.0.
- **Enforcement fails closed.** A request that reaches a scoped route without
  going through key authentication gets *no authority*, not *no restriction*.
- **Some operations are human-only.** `profile:*` and `mfa:manage` are refused to
  machine principals. A service account is a machine: no password, no second
  factor, no browser.
- Only key-capable routes accept a key. `app.authenticate` is JWT-only;
  `/auth/validate` is the general key-reachable route.
- Key creation is rate limited — minting a credential is an authentication event.

See [docs/security/scopes.md](security/scopes.md).

---

## 4. Import the SDK — same process, typed

If Keystone and your code are in the same Node process, import the SDK. No HTTP
hop, no serialization, full types.

```bash
npm install @hilbras/keystone
```

```ts
import { buildApp } from "@hilbras/keystone";

const app = await buildApp();
// Register your own routes on the same app, sharing the same auth plugins:
app.get("/api/orders", { preHandler: [app.authenticate] }, async (request) => {
  return { userId: request.user!.id };
});
await app.listen({ port: 3000 });
```

Mounting your routes on Keystone's app means you inherit the whole security
pipeline: header sanitization, authentication, permissions, mTLS, rate limiting
and audit. `request.user` is populated for you.

The internal service SDK, if you are extending Keystone itself:

```ts
import { getSdk } from "@hilbras/keystone/sdk";

const sdk = getSdk();
const result = await sdk.authentication.login({ email, password });
if (!result.success) return reply.status(401).json({ error: result.error.message });
const tokens = result.data;   // { accessToken, refreshToken, expiresAt, user }
```

Four namespaces: `authentication`, `identity`, `organization`, `authorization`.
Every call returns a `Result<T>` — `{ success: true, data }` or
`{ success: false, error }` — rather than throwing, so a denied call is a value
you must handle, not an exception you can forget.

> Importing the package opens the database pool. Call `app.close()` when done, or
> the process will not exit.

---

## 5. SAML — for software that only speaks SAML

Keystone acts as a **SAML service provider** and brokers to your enterprise IdP.
Users sign in at Keystone; the SAML software never sees a password.

1. Register the software's IdP details in Keystone (entity id, SSO URL, cert).
2. Give Keystone the SP entity id and ACS URL it should present.
3. Publish `GET /sso/saml/metadata/:connectionId` to the software, or paste the
   metadata.

Keystone validates the assertion against the connection's registered issuer,
audience, destination and conditions, and requires the assertion's `Issuer` even
when it falls outside the signed region — a gap that let an unsigned issuer
naming a trusted IdP sit alongside a signed assertion from another one (SEC-021).

See [docs/security/enterprise-sso.md](security/enterprise-sso.md) and
[docs/saml/](../src/routes/saml.ts).

---

## 6. SCIM — provisioning users from an IdP

For pushing users and groups from an IdP into Keystone.

```
GET    /scim/v2/Users
POST   /scim/v2/Users
GET    /scim/v2/Users/.search
GET    /scim/v2/Groups
```

Authenticate with the organization's SCIM token as a bearer credential. **That
token resolves to exactly one organization** and every repository call is scoped
to it — a SCIM credential used to be accepted globally, which let one tenant's
provisioning client read and write every tenant's users (SEC-006, critical).

Issuing, rotating and revoking a SCIM credential is **owner-only**: a SCIM token
provisions and deactivates tenant users, so an ordinary admin must not be able to
mint one.

See [src/routes/scim.ts](../src/routes/scim.ts).

---

## 7. Webhooks — Keystone calling you

For outbound notification, so you do not poll.

```
POST https://your-app.example.com/hooks/keystone
```

Deliveries are signed with a per-webhook secret, and the secret is stored
encrypted (AES-256-GCM) — it has to be recoverable, because Keystone signs with
it, so it cannot be hashed.

**Verify the signature.** An unverified webhook endpoint is an open door: anyone
who learns the URL can post forged events.

```
X-Keystone-Signature: sha256=<hmac of the raw body>
```

Compare with `timingSafeEqual`, against the **raw** request body — parsing and
re-serializing changes the bytes and breaks the comparison.

Rate limits are bounded and refusals carry `Retry-After`. See
[docs/security/configuration.md](security/configuration.md).

---

## Verifying a token yourself

An access token is a JWT signed RS256. You can verify it in-process with no call
to Keystone — which is what makes Keystone usable as a synchronous auth check on
a hot path.

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export async function requireUser(req, res, next) {
  try {
    const { payload } = await jwtVerify(req.headers.authorization.replace("Bearer ", ""), JWKS, {
      issuer: ISSUER,
      audience: process.env.CLIENT_ID,
    });
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}
```

The algorithm is fixed by the key set — never read the algorithm from the token's
own header. Inheriting the algorithm from the token is how "none" and
algorithm-confusion attacks get in, and it was one of this programme's findings
(SEC-019, high).

---

## Authorizing

Identification is not authorization. Once you know who the caller is, ask what
they may do — and ask Keystone, rather than encoding roles in your app.

| Primitive | Use for |
| --- | --- |
| `requireOrganizationRole(roles, {resource, action})` | org-scoped routes; checks membership in the **requested** org |
| `requirePlatformRole("owner")` | installation-wide administration |
| `app.requirePermission(resource, action)` | scoped permission, stronger than a role |
| `app.requireScopes(...)` | API key scopes, fails closed |
| `app.requireHumanPrincipal()` | refuse machine principals; **place after `app.authenticate`** |
| `POST /v1/authz/check` | deciding from another service |

**Where you put the check matters.** `requireOrganizationRole` resolves the
organization from `request.params.id` and checks membership there, not in the
caller's own organization — which is what makes it safe. Prefer a guard in
`preHandler` over an `if` inside the handler: a guard is applied by a reader of
the route definition, whereas a handler check is applied only by whoever remembers
it. There is one module in this codebase that does it the other way, and
[docs/API-REVIEW.md](API-REVIEW.md) records it.

---

## Connecting a framework you have not heard of

Every framework ultimately needs one of five things. Find which:

1. **Can it be an OIDC relying party?** → discovery URL. Done. This covers
   NextAuth, Auth0 SDKs, Spring Security, Passport,omniauth, ASP.NET, Rails
   omniauth_openid_connect, and most auth middleware written since 2016.
2. **Can it verify a JWT?** → the JWKS endpoint, plus `iss` and `aud` checks. This
   covers API gateways, Kong, Envoy, Traefik, nginx+jwt, and any language with a
   JWT library.
3. **Can it make HTTP calls with a bearer token?** → an API key, with scopes. This
   covers cron jobs, ETL, and anything script-shaped.
4. **Is it the same Node process?** → import the SDK.
5. **None of the above?** → put a thin adapter in front. A dozen lines that
   exchange a code and stash a session beats a bespoke auth implementation.

If the answer is "it needs a login form that posts a password to my server", use
[the hosted flow](#2-login-form--host-keystones-own-pages) instead.

---

## Common mistakes

| Mistake | What happens | Do instead |
| --- | --- | --- |
| Verifying a JWT without checking `aud` | A token minted for *your other* client is accepted | Always verify `issuer` **and** `audience` |
| Reading the algorithm from the token header | Algorithm-confusion / `none` | Let the JWKS decide |
| Keeping one refresh token and reusing it | Second use is treated as a replay; the account's credentials are revoked | Replace the refresh token on every response |
| Not checking the OIDC `nonce` | A token from another session can be replayed into yours | Verify the nonce |
| Accepting passwords in your own form | Your app now holds credentials, logs and breach surface | Redirect to the hosted flow |
| Encoding roles in your app | Role logic drifts from the source of truth | `POST /v1/authz/check` |
| Storing a key in browser code | Anyone can read it | PKCE with a public client, no secret |
| `requireHumanPrincipal()` before `app.authenticate` | Silently permits every machine principal | After authentication |
| Trusting `x-user-id` from the client | Complete authentication bypass | It is stripped; never read it |
| Verifying a webhook without `timingSafeEqual` | Signature comparison is bypassable | Constant-time, against the raw body |

---

## Where to go next

| I want to… | Read |
| --- | --- |
| Every endpoint and payload | [docs/API.md](API.md) |
| Endpoints by integration type | [docs/INTEGRATION.md](INTEGRATION.md) |
| Replace my login form | [docs/LOGIN_FORM_INTEGRATION.md](LOGIN_FORM_INTEGRATION.md) |
 | 
| How the pieces fit | [docs/ARCHITECTURE.md](ARCHITECTURE.md) |
| Roles and permissions | [docs/RBAC.md](RBAC.md) |
 | 
| Environment variables | [docs/DEPLOYMENT.md](DEPLOYMENT.md) |
 | 
| What was found and fixed | [docs/RE-AUDIT.md](RE-AUDIT.md), [docs/security/registry.md](security/registry.md) |
| Trust boundaries, rate limits, secrets | [docs/security/](security/) |
| Upgrading across versions | [docs/MIGRATION-2.4.md](MIGRATION-2.4.md) and the `CHANGELOG.md` |

Report a vulnerability through [`docs/SECURITY.md`](SECURITY.md) — not a public
issue.
