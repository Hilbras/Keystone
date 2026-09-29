# WebAuthn

Covers SEC-050 and SEC-051. Both were found by §4.2 writing the first test that
drove a real ceremony, and both had been in the codebase since WebAuthn was added.

## The ceremony was impossible (SEC-050, high)

**Every passkey registration and every passkey sign-in returned 400
`Invalid challenge`.** The second factor could not be used at all.

The cause is a value that changed shape between being stored and being checked.
Keystone generated a challenge, stored it, and passed it into
`generateRegistrationOptions`:

```ts
const challenge = createChallenge(user.id);   // random base64url, stored under this
const options  = await generateRegistrationOptions({ ..., challenge });
// the route put options.challenge in the cookie
// the route looked the cookie up in the store on the way back
```

`@simplewebauthn/server` re-encodes a string challenge. From its
`generateRegistrationOptions`:

```js
let _challenge = challenge;
if (typeof _challenge === 'string') {
    _challenge = isoUint8Array.fromUTF8String(_challenge);
}
...
challenge: isoBase64URL.fromBuffer(_challenge),
```

So `options.challenge` is the base64url encoding of the **ASCII bytes** of the
string that went in — a different string, not a different encoding of the same
bytes. The store was keyed on one value and the cookie carried the other, and
`consumeChallenge` missed every single time.

Measured, before the fix:

```
createChallenge() returns  ekxKcGV5ZG9Eabcdefghijklmnop
options.challenge is       ZWt4S2NHVjVaRzlFYWJjZGVmZ2hpamtsbW5vcA
equal?                     false
```

The fix is not "encode it back" — it is to stop keeping two values. SimpleWebAuthn
generates the challenge, and `storeChallenge` is keyed on `options.challenge`
verbatim. There is no second copy to drift.

### Why it survived

The only WebAuthn test in the suite asserted a **refusal**:

```ts
// src/tests/security/mfa/mfa.test.ts
it("refuses to register a passkey for a TOTP account without the password", ...)
```

That refusal happens in `requireStepUp`, before the challenge is read. So the one
test that existed exercised the one path that does not depend on the challenge
working. A test that only checks the rejection of a feature never establishes that
the feature functions — which is the same shape as SEC-049's sequential-replay test
passing against a racy implementation.

## The store was per-process (SEC-051, high)

Challenges lived in a module-level `Map`. The documentation promises otherwise:

- `docs/DEPLOYMENT.md` — "Run multiple Keystone containers behind a load balancer."
- `docs/ARCHITECTURE.md` — "Support horizontal scaling through Redis-backed state."

A `Map` is per-process. A challenge minted on container A cannot be redeemed on
container B, so with two containers about half of all ceremonies fail — and only in
a multi-instance deployment. Development is a single process and always agrees
with itself, so this cannot be reproduced locally by any amount of trying.

The store is Redis now, with a five-minute TTL, and redemption is `GETDEL`:

```ts
const raw = await redis.getdel(keyFor(challenge));
```

One command, so two simultaneous ceremonies presenting the same challenge cannot
both win, and the winner is the same answer on every container.

A failed write **propagates**. The caller is about to hand the challenge to the
client; a write that is still in flight means the client can finish the ceremony
before the record exists, and a swallowed failure surfaces as `Invalid challenge`
on the next request with nothing in the logs. Both a `void`-ed write and a
`.catch(() => {})` were tried during the fix; the first caused exactly that
race and the second would hide the next one.

## What the suite asserts

`src/tests/security/mfa/webauthn.test.ts` drives the whole ceremony with a
software authenticator (`src/tests/helpers/softwareAuthenticator.ts`): real CBOR, a
real COSE ES256 key, a real ECDSA signature over `authData ‖ sha256(clientDataJSON)`,
checked by `@simplewebauthn/server` against the real stored public key. Nothing
mocks the verifier — "the route calls the service" is not the claim worth making
about a second factor.

Beyond the happy path:

- **A challenge is portable between processes.** A second import of the module
  with a cache-busting query string is a second copy of the module registry entry:
  fresh module state, same Redis. That is a second container. This test fails on an
  in-process store and passes on a shared one, with no change to the test.
- **A challenge is single-use across six simultaneous ceremonies** — `GETDEL`
  rather than `GET` then `DEL`, the same race `singleUse.ts` exists to remove.
- **A cloned authenticator is refused.** The signature is genuinely valid — it is
  the registered key — and the only signal is a sign counter that went backwards.
  A relying party that does not notice this accepts two assertions from a copied key.
- **A tampered assertion fails cryptographically.** One flipped byte in
  `authenticatorData`, which the signature covers.
- **A challenge is bound to the user it was issued for.** Alice's challenge cannot
  register a credential on Bob's account.
- **A service account cannot start a ceremony.** A machine authenticates with a key
  it already holds; letting one "register a passkey" is a way to mint a second
  factor with no second factor present.
- **A completed session still needs the password once TOTP is on.** A stolen access
  token must not be enough to add a factor.
- **A passkey on a deactivated account is refused.**
- **`/authenticate/options` does not reveal whether an address has a passkey.** The
  allow list differs — that is the point of the endpoint — but the response must
  succeed either way, because it is unauthenticated.
- **The TTL is five minutes**, asserted on Redis's own clock rather than by
  waiting.

### Both findings verified by breaking the fix

| restored behaviour | result |
|---|---|
| challenge stored under the pre-transform value (SEC-050) | **12 of 17 fail**, every ceremony `Invalid challenge` |
| store moved back to a `Map`, challenge still correct (SEC-051) | **2 of 17 fail** — the cross-instance and TTL cases; the ceremony itself works |
| as shipped | 17 pass |

The second row matters: it is what shows SEC-051 is a separate defect from
SEC-050, and not just the same symptom seen twice. A correct challenge store in
the wrong place breaks only multi-instance deployments.

## A near-miss worth recording

Two functions in this codebase are called `encryptSecret`, and they produce
different ciphertext formats:

- `services/secrets` — the pluggable provider, `async`, format `aes-256-gcm$…`
- `services/totp` — a local synchronous pair, format `v2.<iv>.<tag>.<ciphertext>`

`verifyUserTotpCode` decrypts with the **TOTP** one. A test that stores a secret
with the provider's `encryptSecret` produces a user whose every code is rejected,
and the symptom is indistinguishable from a wrong code. `mfa.test.ts` imports the
right one; the first version of the WebAuthn suite imported the wrong one and
produced a failing test that looked like a product bug. The fix is the comment on
the call site, because the two names will not be reconciled by this suite.
