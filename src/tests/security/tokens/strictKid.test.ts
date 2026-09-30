import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, exportSPKI, importPKCS8, SignJWT, type JWTHeaderParameters } from "jose";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

/**
 * SEC-076 — an unknown `kid` silently fell back to the active signing key.
 *
 * The plan describes this as validation to add. **It is not a bypass**: a token
 * signed by any other key still fails signature verification, so an attacker
 * naming a `kid` this server does not hold gains nothing. What it *was* is a
 * diagnostic lie — a token from a retired key, a token from another issuer, and
 * a forged token with an invented `kid` all produced the same signature error as
 * an ordinary tampered token, so an operator rotating keys could not tell a
 * rotation problem from an attack.
 *
 * These cases sign real tokens with real keys, because the claim is about which
 * key the verifier *selects*, and a mocked verifier would not measure it.
 */
describe("JWT kid resolution is strict (SEC-076)", () => {
  let verifyAccessToken: typeof import("../../../services/tokens.js").verifyAccessToken;
  let loadSigningKeys: typeof import("../../../services/tokens.js").loadSigningKeys;

  /** Mirrors `issuer()` in tokens.ts, which is derived from configuration. */
  const issuer = () =>
    process.env.AUTH_API_PUBLIC_URL || `http://localhost:${process.env.PORT ?? 4001}`;

  before(async () => {
    if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
      const pair = await generateKeyPair("RS256", { extractable: true });
      process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
      process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
    }
    const tokens = await import("../../../services/tokens.js");
    verifyAccessToken = tokens.verifyAccessToken;
    loadSigningKeys = tokens.loadSigningKeys;
  });

  after(() => {
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
  });

  /** A token signed by a key this server has never heard of. */
  async function foreignToken(kid: string | undefined): Promise<string> {
    const rogue = await generateKeyPair("RS256", { extractable: true });
    const header: JWTHeaderParameters = { alg: "RS256", typ: "JWT" };
    if (kid !== undefined) header.kid = kid;
    return new SignJWT({ sub: "attacker", role: "owner" })
      .setProtectedHeader(header)
      .setIssuer(issuer())
      .setAudience("hilbras")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(rogue.privateKey);
  }

  /** The reason a token was refused, or "accepted". */
  const reasonFor = async (token: string): Promise<string> => {
    try {
      await verifyAccessToken(token);
      return "accepted";
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("accepts a token signed by the active key carrying its kid", async () => {
    await loadSigningKeys();
    // The positive control. Without it, a change that refused *everything*
    // would pass every negative case below.
    const signed = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "env" })
      .setIssuer(issuer())
      .setAudience("hilbras")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await importPKCS8(process.env.JWT_PRIVATE_KEY as string, "RS256"));
    const claims = await verifyAccessToken(signed);
    assert.equal(claims.sub, "u1");
  });

  it("refuses a token naming a kid the server does not hold", async () => {
    await loadSigningKeys();
    // Must be refused *for the stated reason*. A bare signature failure would
    // mean the fallback is still present and the diagnostic lie is still being
    // told.
    // Hoisted rather than awaited inside the assertion callback: the arrow passed
    // to `assert.rejects` is not async, so an `await` inside it does not compile.
    const rogue = await foreignToken("key-that-was-never-issued");
    await assert.rejects(
      () => verifyAccessToken(rogue),
      /unknown key id: key-that-was-never-issued/
    );
  });

  it("distinguishes an unknown kid from a tampered token on a KNOWN key", async () => {
    await loadSigningKeys();
    // The comparison that matters, and the one an earlier draft of this test got
    // wrong. It first built the "tampered" token by truncating a token that
    // carried an *unknown* kid, and asserted the two messages differed — which
    // they do not, and should not: the `kid` is in the header, so truncating the
    // signature leaves it intact and the unknown-kid check fires first.
    //
    // That precedence is correct. An unknown key is a more fundamental fact about
    // the token than a bad signature over it, and reporting the signature error
    // for a token whose signing key this server does not hold is the diagnostic
    // lie SEC-076 is about.
    //
    // So the honest contrast is: a token naming a key we do not hold, against a
    // token naming a key we DO hold whose signature does not verify.
    const unknownKid = await reasonFor(await foreignToken("another-unknown-kid"));

    // Signed by a foreign key but *claiming* a kid we hold: the key resolves, so
    // the failure is a signature failure. This is the token an operator sees
    // during an ordinary forgery or a tampering attempt.
    const forgedForKnownKey = await reasonFor(await foreignToken("env"));

    assert.match(unknownKid, /unknown key id: another-unknown-kid/);
    assert.doesNotMatch(
      forgedForKnownKey,
      /unknown key id/,
      "a token naming a held key must fail on the signature, not on the key id"
    );
    assert.notEqual(
      unknownKid,
      forgedForKnownKey,
      "an unknown kid and a bad signature on a known key must not be indistinguishable"
    );
  });

  it('resolves the environment provider\'s own "env" key id', async () => {
    // The regression this could plausibly cause: `loadSigningKeys` registers the
    // env-provided key under the id "env". If strict resolution consulted only
    // the database key table, every token in an env-configured deployment would
    // stop verifying — the loudest possible way to get this wrong.
    await loadSigningKeys();
    // Signed by a *foreign* key, so it must still be refused — the point is that
    // "env" resolves to a real key and therefore produces a signature failure
    // rather than an unknown-kid failure.
    const reason = await reasonFor(await foreignToken("env"));
    assert.doesNotMatch(reason, /unknown key id/, '"env" must resolve to a known key');
  });

  it("a token with no kid at all keeps the documented legacy behaviour", async () => {
    await loadSigningKeys();
    // The legacy allowance is about the *absence of a claim*, not about accepting
    // any signature: a no-kid token is still verified against the active key, so a
    // foreign signature fails — and it fails as a signature error, not as an
    // unknown-kid error, because no claim was made to be unable to honour.
    const reason = await reasonFor(await foreignToken(undefined));
    assert.notEqual(reason, "accepted", "a foreign signature must never verify");
    assert.doesNotMatch(
      reason,
      /unknown key id/,
      "a token with no kid must take the legacy path, not the strict-kid path"
    );
  });
});
