# Migrating to Keystone 2.4.0

Keystone 2.4.0 hardens the OAuth 2.0 / OIDC implementation. The most important
change is that **the `authorization_code` grant now authenticates the client**,
which is a breaking change for any integration that was not sending its secret.

Review this page before upgrading a production deployment.

---

## 1. The authorization code grant requires a client secret

**Breaking.**

In 2.3.x the `authorization_code` grant looked the application up by
`client_id` and redeemed the code without ever checking a client secret. RFC
6749 §3.2.1 requires a confidential client to authenticate at the token
endpoint, so the code and its PKCE verifier were the only factors protecting the
exchange.

From 2.4.0, a confidential client must present its `client_secret`:

```bash
# Before — accepted
curl -X POST https://auth.example.com/oauth2/token \
  -d grant_type=authorization_code -d code=... -d client_id=... -d redirect_uri=... -d code_verifier=...

# After — 401 invalid_client
# After — accepted
curl -X POST https://auth.example.com/oauth2/token \
  -d grant_type=authorization_code -d code=... -d client_id=... -d client_secret=... \
  -d redirect_uri=... -d code_verifier=...
```

The secret may be sent in the body or via HTTP Basic authentication, as before.

### What to do

Add `client_secret` to your token request. If you are using Keystone's own SDK
or drop-in, no change is needed — they already send it.

### Public clients

A client registered as `public` is **not** required to send a secret, because it
has none. PKCE is mandatory for such a client at both `/authorize` and
`/token`; a request without `code_challenge` is refused with
`invalid_request`, and one without `code_verifier` with the same.

Existing applications are unaffected: they are all `confidential` and keep
their secrets.

---

## 2. Redirect URI registration is stricter

**Potentially breaking** if you registered any of the rejected forms.

Registration was validated with `z.string().url()`, which accepts anything the
URL parser accepts. Now rejected:

| Rejected | Why |
| --- | --- |
| `javascript:`, `data:`, `vbscript:`, `blob:`, `file:` | Would execute script or inline a document on the auth domain |
| `https://*.example.com/cb`, any URI containing `*` | Can never match exactly; registered in the belief that it works |
| `https://example.com/cb#token` | Fragments are never sent to the server, so an exact match can never succeed |
| `https://user:pass@example.com/cb` | Embedded credentials are a phishing primitive |
| `http://example.com/cb` | Plaintext HTTP downgrade. Still allowed on loopback for development |

### What to do

Check every registered redirect URI. If one is a wildcard, register each
callback explicitly. If one uses plaintext HTTP against a real host, move it to
HTTPS.

**A validation that used to pass will now fail.** For example, registering
`javascript:alert(1)` returned 201 before and returns 400 now, with a message
naming the reason.

Matching itself is unchanged and remains exact string comparison — no prefix
matching, no normalization, no case folding. This was already the behaviour; it
is now enforced through one shared helper so registration-time and use-time
rules cannot drift.

---

## 3. Scope requests are validated against a registration

**New, opt-in.** Applications with no registered scopes are unaffected.

The effective scope set is now:

```text
registered scopes  ∩  requested scopes  ∩  consented scopes
```

A scope outside the registration is **refused** with `invalid_scope`, not
silently dropped:

```json
{ "error": "invalid_scope", "error_description": "Scope \"admin:all\" is not available to this client" }
```

An empty `allowed_scopes` means "unrestricted", which preserves the previous
behaviour for every existing application.

### What to do

Nothing, unless you want the extra control. To adopt it:

```http
PATCH /v1/admin/organizations/:orgId/applications/:appId

{ "allowedScopes": ["openid", "profile", "email", "api:read"] }
```

From then on, requesting a scope outside that list is refused rather than
granted. Scope names may contain letters, digits, `.`, `_`, `:`, `*`, and `-`.

---

## 4. OIDC federation now sends and verifies a nonce

**Behavioural, no configuration needed.** Relevant only if you operate an
external OIDC or SAML identity provider that Keystone federates with.

Keystone now generates a nonce per authorization request, stores it in an
httpOnly `oauth_nonce` cookie, sends it to the provider, and requires the
returned ID token to carry the same value.

If your identity provider does not echo the nonce into its ID token,
federated logins will fail with a nonce mismatch. Well-behaved providers —
anything implementing OpenID Connect Discovery, which requires nonce support when
a nonce is sent — echo it correctly.

Two related changes to ID token verification: the algorithm set is now pinned
(RS256, ES256, PS256) and `exp`, `iat`, `iss`, `aud`, `sub` are required rather
than validated only when present. A provider issuing tokens without an `iat` or
without a `sub` will now be refused.

---

## 5. Refresh tokens carry their granted scopes

**New column, no action required.**

`refresh_tokens.scopes` records the scope set granted at the authorization step,
and rotation carries it forward. Previously the context was dropped at the first
refresh.

A refresh may narrow the grant but never widen it: the stored set is
authoritative, and nothing a caller supplies at the token endpoint can extend it.

---

## New API surface

| Field / parameter | Where | Notes |
| --- | --- | --- |
| `clientType` | `POST`/`PATCH` application | `"confidential"` (default) or `"public"`. A public client is issued no secret |
| `allowedScopes` | `POST`/`PATCH` application | Registration of requestable scopes. Empty means unrestricted |
| `clientSecret` | `POST` application response | Now `null` for a public client |

## Migration order

The database migration (`0016`, `0017`) is additive: `client_secret_hash`
becomes nullable, and `client_type`, `allowed_scopes`, and
`refresh_tokens.scopes` are added with defaults. Existing rows are unaffected —
every existing application stays `confidential` with its secret intact.

- [ ] Add `client_secret` to every authorization-code token request
- [ ] Audit registered redirect URIs against the new rules
- [ ] Optionally register `allowedScopes` on your applications
- [ ] Confirm your external identity provider echoes the OIDC nonce and issues `iat` and `sub`
- [ ] Run the database migrations (automatic on startup)
- [ ] Watch for `invalid_client` at the token endpoint and `invalid_scope` at `/authorize`

## Rolling back

The migration is additive and every new column is nullable or has a default, so
rolling back to 2.3.x leaves them in place and unused. Nothing needs undoing
manually.

The application rollback is straightforward, but 2.3.x reintroduces both the
missing client authentication and the `javascript:` redirect URI acceptance.
Prefer fixing the integration forward.
