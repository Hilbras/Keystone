# Configuration, secrets and deployment defaults

Covers SEC-026 through SEC-032.

## The configuration endpoint redacts by allowlist

The owner-only configuration endpoint previously matched a **denylist** of
secret-looking key names. Measured against the real configuration surface,
**12 of 24** secret-shaped keys were returned unredacted — including the signing
keys, so the endpoint disclosed the material used to sign tokens.

A denylist is the wrong shape here: it has to predict every name a secret might
take, and a new secret is unredacted until someone remembers to add it.
`EXPOSABLE_CONFIG_KEYS` in `src/services/configuration/profiles.ts` is an
allowlist, so a key that is not explicitly declared exposable is not returned.

## CORS fails closed

An unset or empty `ALLOWED_ORIGINS` was treated as *allow all*, combined with
credentialed requests. A misconfiguration therefore produced a wildcard CORS
policy that browsers actually enforce, rather than a closed one.

`isOriginAllowed` in `src/services/trustedProxies.ts` now fails closed on an
empty allowlist. The policy lives with the rest of the address logic so the
server and the tests share one implementation — an earlier version of these tests
asserted against a copy of the rule, which meant they passed whether or not the
server enforced it.

## Cookies are Secure by default in production

`COOKIE_SECURE` defaulted to `false`, so a production deployment that did not
set it issued session cookies over plaintext. It now defaults to `true` when
`NODE_ENV` is `production`.

## The setup server is not exposed

Three separate ways the first-run provisioning endpoint could be reached by
someone who should not have reached it:

- **Origin.** It was configured with `origin: true` and credentials enabled, so
  any page in the operator's browser could call it during setup. It is now
  restricted to the server's own address.
- **Interface.** It bound `0.0.0.0`, making the unauthenticated endpoint
  reachable from the network. It binds loopback by default;
  `KEYSTONE_SETUP_HOST` overrides, and it warns when bound to all interfaces.
- **The token.** The token granting initial owner access was printed to stdout,
  so it reached log aggregation and any log shipper — the credential intended to
  bootstrap trust was the one most widely distributed. Printing now requires an
  explicit `KEYSTONE_PRINT_SETUP_TOKEN`.

## Webhook secrets are encrypted at rest

Webhook secrets were stored as issued, so a database read, a backup or an admin
query returned material that lets an attacker forge delivery attempts signed as
this installation.

They are now stored as AES-256-GCM envelopes. They are **encrypted, not hashed**,
because Keystone signs outbound deliveries with the secret and must be able to
recover it. Legacy plaintext values are still readable and are rewritten on next
rotation.
