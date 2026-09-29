# Federation

Covers SEC-052, and the properties `src/tests/security/federation/connectors.test.ts`
holds for all six providers.

## Six providers, three implementations, and one that was missed

`listSupportedProviders()` returns `zitadel`, `google`, `github`, `azure`, `okta`
and `keycloak`. Four of those share the generic `OidcConnector`; `google` and
`zitadel` have their own. Before §4.3 the word "connector" appeared in three test
files, and none of them drove an exchange — they exercised the routes with a
stubbed connector, so the part that could be wrong was the part with no coverage:
signature verification, nonce binding, the algorithm pin, the expiry check, and
the email rules.

The suite now runs every one of the six against a **real OIDC provider**
(`src/tests/helpers/fakeOidcProvider.ts`) — a real discovery document, a real
JWKS, ID tokens signed with a real RSA key. `jwtVerify` in the connector does
actual work, so a rejected token is rejected for the reason it would be in
production rather than because a stub returned the wrong thing.

`ALLOW_PRIVATE_SSO_ENDPOINTS` is what makes the server reachable. The SSO endpoint
policy refuses loopback and private addresses as an SSRF control, so a test
provider is unreachable by design without that switch — which is the correct
default, and the reason the switch exists.

The provider list itself is asserted:

```ts
assert.deepEqual([...PROVIDERS].sort(),
  ["azure", "github", "google", "keycloak", "okta", "zitadel"],
  "the provider list changed; add the new one to this suite or the coverage claim is false");
```

A per-connector suite that silently stops covering a new connector is worse than
none, because it still reports green.

## SEC-052, high — Zitadel did not bind the token to the request

`ZitadelConnector` was the odd one out in three ways.

**The nonce was never sent and never checked.** `getAuthorizeUrl` had no `nonce`
parameter, `exchangeCode` took no options, and `verifyToken` took one argument. An
ID token minted for a *different* Zitadel login therefore verified correctly:

> `state` protects the callback against CSRF but says nothing about the **token**.
> Issuer, audience and signature are all still valid. Only the nonce proves the
> token belongs to the request that started.

The OIDC connector gained all three in 2.4.0, after SEC-020 — the Google connector
regressed on exactly this and was fixed. Zitadel never had it, and because no test
drove a Zitadel exchange, nothing said so. The Google fix did not propagate to the
connector next to it, which is the failure mode of fixing an instance rather than
a rule.

**No algorithm was pinned.** `jwtVerify` was called with no `algorithms`, so the
accepted algorithm was whatever the published JWKS happened to allow. That is the
algorithm-confusion surface, and `none` was not excluded either.

**No claims were required.** A token carrying no `exp` was accepted forever. For
an enterprise IdP whose tokens are long-lived by design, that is not
hypothetical.

The fix pins `["RS256", "ES256", "PS256"]`, requires `exp`, `iat`, `iss`, `aud`,
`sub`, and compares the nonce. It also moved the base URL from
`config.ZITADEL_DOMAIN` to the connector's own `cfg.issuer`, so Zitadel can be
pointed at a per-organization `identity_providers` row like every other provider.

And the **interface** changed, which is the part that stops it recurring:

```ts
verifyToken?(token: string, expectedNonce?: string): Promise<ExternalIdentity>;
```

`IdentityConnector.verifyToken` declared one argument, so a connector written from
the interface had no way to accept a nonce. The parameter's absence from the type
is why this one shipped without it while its neighbour was fixed.

### Verified by breaking it

Restoring the original Zitadel connector — global base URL, no nonce, no
algorithm pin, no required claims:

| | result |
|---|---|
| as shipped | 70 pass |
| Zitadel restored to its original behaviour | **59 pass, 11 fail** — all 11 Zitadel |

The other five providers are untouched by the break, which is what shows the
eleven are Zitadel's and not the suite's.

## What the suite holds for every provider

- the authorization URL carries `state`, `redirect_uri`, `client_id`,
  `response_type=code`, an `openid` scope, and the **nonce** (SEC-020, which has
  already regressed once);
- an exchange returns the identity the token carries, with `raw` claims kept;
- a token whose nonce is not the one sent is refused — **and a token with no nonce
  at all is refused too**, because an absent nonce is not a matching nonce;
- a token minted for a different `aud` is refused;
- a token from a different `iss` is refused;
- an expired token is refused, despite the five-second clock tolerance;
- `email_verified: false` is **reported** as false rather than assumed true, so the
  caller can decide whether to trust the upstream address;
- a token carrying no email is rejected outright;
- a token signed with a key the provider never published is refused — the check a
  stubbed `fetch` would skip entirely;
- `attributeMapping` is honoured.

Each rejection is matched against the claim `jose` actually names (`"aud"`,
`"iss"`, `"exp"`), not against a concept word. A regex like `/audience/i` would
have passed on an unrelated failure, and the assertion would have proved nothing.

## A silently ignored mapping key

`attributeMapping` is keyed by the *internal* claim names, so the obvious spelling
did not work:

```ts
// before
username: get("preferred_username") ? String(get("preferred_username")) : undefined
```

A mapping of `{ username: "login" }` — which is the field name in
`ExternalIdentity`, in every provider's configuration screen, and in the type
itself — was **silently ignored**, and the default value was returned instead. The
admin saving that mapping would see it accepted and would see no effect.

`username` is now consulted as a mapping key in its own right, with
`preferred_username` as the fallback. No security impact, so it is not in the
registry; it is recorded here because the failure mode is a configuration that
looks applied and is not.

## Linking a federated identity to a local account

A federated sign-in resolves an account by address. If that resolution also
*created* a link, anyone who could get an account at a permissive upstream
provider using somebody else's address would be signing in as that person — the
upstream's "this address is mine" would be treated as proof of an identity Keystone
has never seen.

The suite asserts both halves: an unknown upstream address creates no local
account, and an existing password-only account gains no identity row. And the
legitimate path still works — a user who signs in federated does get an identity
row, so the second sign-in finds the same account rather than making a second one.

The third test pins why `provider` is part of the lookup key. A `sub` is unique
only *within* a provider; two providers will both mint `12345`. The same `sub` at
`google` and `okta` is two identities, and the test asserts two rows.
