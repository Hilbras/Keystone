# Enterprise SSO Configuration

How to configure SAML and OIDC federation, and what Keystone checks on every
assertion or token it accepts.

Related: [SECURITY.md](../SECURITY.md),
[trust-boundaries.md](./trust-boundaries.md).

---

## How federation fits together

```text
User  →  Keystone /auth/oauth/:provider  →  your IdP  →  callback  →  Keystone
User  →  Keystone /sso/saml/:connectionId →  your IdP →  ACS        →  Keystone
```

Keystone is the **relying party**. Your IdP asserts who the user is; Keystone
decides whether it believes them. Everything below is a check Keystone applies
on the way back.

A platform owner cannot sign in through tenant SSO, and an account flagged for
platform review cannot either.

---

## SAML setup

### What you register

| Field | Meaning | Notes |
| --- | --- | --- |
| `idpEntityId` | Your IdP's entity ID | **Must** match the `Issuer` in your assertions exactly |
| `idpSsoUrl` | Single sign-on endpoint | Where Keystone sends the `SAMLRequest` |
| `idpCertificate` | Your IdP's signing certificate, PEM | Used to verify every assertion |
| `spEntityId` | Keystone's entity ID | Returned in metadata; must equal your assertion `Audience` |
| `spAcsUrl` | Keystone's assertion consumer service URL | Must equal the assertion's `Destination` and `Recipient` |
| `attributeMapping` | Which attributes carry email and name | Falls back to a standard list |

### Obtaining Keystone's metadata

```bash
curl https://auth.example.com/sso/saml/:connectionId/metadata
```

Import that into your IdP as a service provider.

### What Keystone verifies on every assertion

| Check | Failure |
| --- | --- |
| Signature valid under `idpCertificate` | `SAML validation failed` |
| Assertion **and** message both signed | `SAML validation failed` |
| `Issuer` equals `idpEntityId` | `SAML issuer mismatch` |
| `Audience` contains `spEntityId` | `SAML audience mismatch` |
| `Destination` is exactly `spAcsUrl` | `SAML response destination mismatch` |
| Every `SubjectConfirmationData/@Recipient` is `spAcsUrl` | `SAML subject recipient mismatch` |
| `InResponseTo` matches the stored transaction's request ID | `SAML response request ID mismatch` |
| `NameID` matches the resolved external identity | `SAML subject mismatch` |
| `NotBefore` / `NotOnOrAfter` | rejected |
| RelayState HMAC valid | `Invalid RelayState` |
| Transaction cookie matches the transaction's browser nonce | `Invalid SAML transaction` |
| Transaction not already consumed | `SAML transaction already consumed` |
| Connection is active **and** belongs to the request's organization | `SAML connection not found` |

Matching is exact. A `Destination` of `https://…/acs/extra`, a different case, or
an added default port are all rejected — as is a `Recipient` that is a prefix or
superstring of the registered ACS.

### The unsigned Issuer

The response-level `<saml:Issuer>` sits **outside** both signed regions, so
rewriting it does not invalidate the signature. Keystone therefore compares it
to `idpEntityId` directly, as SAML 2.0 §2.5.1.5 requires for an unsigned issuer.

If you see `SAML issuer mismatch`, your IdP is emitting a different entity ID
than the one registered on the connection.

### Certificate rotation

Rotation is a configuration change, not an automatic rollover. To rotate:

1. Add the new certificate to your IdP so it begins signing with it, **keeping
   the old certificate trusted** for the overlap window.
2. Update `idpCertificate` on the connection to the new certificate.
3. Confirm logins succeed.
4. Remove the old certificate from your IdP.

Step 2 is the point of no return: once Keystone holds only the new certificate,
assertions signed under the old one are rejected. There is no grace period and no
support for two certificates at once. Rotate during a quiet period, or accept a
brief window where some users must retry.

---

## OIDC setup

### What you register

| Field | Meaning |
| --- | --- |
| `clientId` / `clientSecret` | Your OAuth client credentials |
| `issuer` | Expected `iss` claim. Compared exactly. |
| `authorizationEndpoint`, `tokenEndpoint`, `jwksUri` | Endpoints, or supply `discoveryUrl` and let Keystone resolve them |
| `userinfoEndpoint` | Optional. Used to enrich a profile, never to establish identity. |
| `attributeMapping` | Maps IdP claims to Keystone fields |

### What Keystone verifies on every ID token

| Check | Enforcement |
| --- | --- |
| Signature | Verified against the JWKS, fetched through the SSRF policy |
| `iss` | Must equal the configured issuer |
| `aud` | Must contain the configured client ID |
| `alg` | Pinned to RS256, ES256, or PS256 — inferred from the key material is not trusted |
| `exp`, `iat`, `iss`, `aud`, `sub` | **Required**, not merely checked when present |
| `nonce` | Must equal the value sent in the authorization request |

A token with no `exp` is rejected rather than treated as never-expiring.

### The nonce

Keystone generates a random nonce per authorization request, keeps it in an
httpOnly `oauth_nonce` cookie, sends it to your IdP, and requires the returned
ID token to echo it.

Your IdP **must** echo the nonce. If it does not, federation fails with a nonce
mismatch. Any provider implementing OpenID Connect Discovery does this correctly.

A callback arriving with no `oauth_nonce` cookie is rejected outright — it did
not come from a flow this browser started.

> The `nonce` option must survive any connector that overrides `exchangeCode`.
> `GoogleConnector` did not forward it until 2.5.0, which silently disabled nonce
> validation for the default provider.

### Endpoint policy

All federation endpoints go through one policy:

- HTTPS required in production. HTTP is permitted outside production so a
  developer can use a local IdP.
- Loopback and private ranges refused unless `ALLOW_PRIVATE_SSO_ENDPOINTS` is
  set. This is what stops an IdP URL being pointed at `169.254.169.254` or an
  internal service.
- No embedded credentials.
- Redirects are not followed, and the resolved address is pinned, so a DNS answer
  that changes mid-request cannot redirect the fetch.

`ALLOW_PRIVATE_SSO_ENDPOINTS` disables the private-address rule. It exists for
development and for genuinely internal IdPs. Enabling it in production means an
SSRF target inside your network becomes reachable from a configuration value.

---

## Organization scoping

A membership is identified by **organization and user together**, never the user
alone. One person can belong to several organizations with a different role in
each, and no lookup made during federation can see another organization's
membership.

Membership rows carry a unique constraint on `(org_id, user_id)`, and provisioning
inserts with `ON CONFLICT DO NOTHING`, so two simultaneous logins cannot create
duplicate memberships.

An **existing** user cannot be adopted by a new connection just because their
email matches. They must be invited first, or linked explicitly. Otherwise any
IdP that can assert an email address could take over an account it does not own.

Connections are resolved by `(connectionId, orgId)`, so a connection belonging to
one tenant cannot be used to complete a login initiated in another.

---

## Security recommendations

1. **Require signed assertions.** Keystone does. If your IdP offers a choice,
   turn on signed assertions and message signing.
2. **Short assertion lifetimes.** Minutes, not hours. `NotOnOrAfter` is enforced.
3. **Do not reuse assertions across users.** Each login is bound to a
   single-use transaction.
4. **Treat the ACS URL as fixed.** Register the exact URL Keystone gives you. No
   wildcards, no fragments.
5. **Keep `ALLOW_PRIVATE_SSO_ENDPOINTS` off in production** unless your IdP is
   genuinely internal, and understand what turning it on permits.
6. **Prefer OIDC over SAML** where you have the choice: it has fewer moving parts
   and its validation is stricter by default.
7. **Rotate certificates deliberately.** There is no dual-certificate support and
   no grace period.
8. **Watch the audit log** for `saml_sso_login`, `saml_connection_created`, and
   `unauthorized_access`. The last one fires on a cross-organization connection
   attempt.
