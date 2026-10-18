# Tokens and single-use credentials

Covers SEC-049, and the single-use claim that the other token findings depend on.

## Single use means one claim, not one row

Every credential in Keystone that is meant to be usable exactly once — a magic
link, a password reset, a one-time code, an email verification — is consumed by
the same function, `claimAndClassify` in
[`src/services/singleUse.ts`](../../src/services/singleUse.ts). It is a single
statement:

```sql
UPDATE <table>
   SET used_at = now()
 WHERE token_hash = $1
   AND expires_at > $2
   AND used_at IS NULL
RETURNING *
```

The `used_at IS NULL` is in the `WHERE` clause, not in a `SELECT` that ran
earlier. That is the entire difference. The racy shape is:

```text
SELECT ... WHERE used_at IS NULL      <- a read that hopes
UPDATE ... SET used_at = now()        <- and then a write
```

Two requests arriving together both pass the read before either writes it, both
write, and both are told the credential was valid. This is not a subtle window —
it is the width of two database round trips, which on a loaded server is
milliseconds and on a cold pool is tens.

`src/tests/security/tokens/single-use.test.ts` asserts the property directly,
including a "the racy pattern this replaced" case that demonstrates the failure on
purpose.

## Email verification was not one of them (SEC-049)

Until 3.4.0, `consumeVerificationToken` used the racy shape. It was the fourth
token type in the codebase and the only one not routed through `claimAndClassify`.

Nothing caught it, for two reasons that are worth naming because both are
general:

- **The flow had no test at all.** `emailVerification.ts` appeared once in the
  whole suite, in a list of rate-limit prefixes.
- **The obvious test would have passed anyway.** A sequential replay test — use
  the token, assert the second use is refused — passes against the broken
  implementation, because the second request arrives long after the first has
  written. The defect only appears when the requests overlap.

Measured against the old implementation: **2 of 8** simultaneous requests through
`GET /auth/email-verification/verify` were each told the token was valid. It was
not 8 of 8, because the connection pool serialises some of them, which is exactly
the kind of partial failure that makes a race look intermittent and therefore
unlikely.

The regression test is
[`src/tests/security/authentication/email-verification.test.ts`](../../src/tests/security/authentication/email-verification.test.ts),
and the concurrency case is the one that drives it out. Reinstating the
read-then-write implementation fails that test and nothing else in the suite.

## The practical impact was bounded, and that is not an argument for leaving it

Verifying an address is idempotent: a replayed token grants nothing the first
successful use did not already grant. So the severity is medium rather than high,
and it is recorded that way deliberately — inflating it would make the registry
less useful to whoever reads it next.

The reason it is still a finding is that **the stated property of the flow was
false**, and this shape is one people copy. A verification link captured in a
proxy log, a mail archive or a shared inbox could be replayed after the
legitimate user had already used it, and a reader of the old code would have
concluded that it could not. The same copy-paste would grant something on a flow
where consumption is not idempotent.

## Tokens are stored hashed

`generateVerificationToken` returns the value that is mailed and the digest that
is stored, and only the digest is persisted. A database dump is therefore useless
for verifying an account, resetting a password or signing in. The lifecycle suite
asserts this rather than assuming it: the stored column is 64 hex characters and
is the SHA-256 of the value that was returned, checked by re-deriving it.

## Which key verifies a token (the `kid` policy)

An access token's header may name a key id (`kid`). The policy is strict, and the
three cases are deliberately different:

| header | policy |
|---|---|
| `kid` names a key the server holds | verify against that key |
| `kid` names a key the server does not hold | **refuse**, with `unknown key id: …` |
| no `kid` at all | verify against the active key (legacy) |

The middle case is not a bypass — a token signed by another key still fails
signature verification — but it used to be indistinguishable from an ordinary
tampered token, so an operator rotating keys could not tell a rotation problem
from an attack. It is now refused for the reason it actually failed (SEC-076).

The last case is the documented compatibility allowance for tokens issued before
`kid` existed. It is about the **absence of a claim**, not about accepting any
signature: a no-`kid` token is still verified against the active key, so a foreign
signature fails there too.

The algorithm is never taken from the token header. Verification is handed the
RSA public key it holds and jose derives what that key can do, so `alg: none` and
an HS256 token keyed with that public key are both refused. That property is
pinned by `src/tests/security/tokens/strict-kid-extended.test.ts`, because it is
one refactor away from being lost — handing the key over as raw bytes, or
populating `algorithms` from the token's own header, would silently restore the
algorithm-confusion family.
