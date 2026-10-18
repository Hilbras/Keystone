import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportPKCS8, exportSPKI, importPKCS8, SignJWT, type JWTHeaderParameters } from "jose";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");

/**
 * §1.4 — the strict-`kid` work (SEC-076) covers an unknown key id and the
 * no-`kid` legacy path. What it did not cover is the two ways a token can try to
 * talk the verifier out of the key it should use: naming an algorithm in its own
 * header, or reusing the public key as an HMAC secret.
 *
 * Both are the classic JWT confusion family — the token supplies the algorithm
 * and the verifier obliges. Neither works here, because verification is performed
 * against an RSA `CryptoKey` and jose refuses a header that asks for something
 * that key cannot do. That is a property worth pinning: it is one refactor away
 * from being lost if the key is ever handed over as raw bytes, or if `algorithms`
 * is ever populated from the token's own header.
 */
describe("the verifier refuses tokens that choose their own algorithm (§1.4)", () => {
  let verifyAccessToken: typeof import("../../../services/tokens.js").verifyAccessToken;
  let loadSigningKeys: typeof import("../../../services/tokens.js").loadSigningKeys;

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
    await loadSigningKeys();
  });

  after(() => {
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
  });

  const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

  const reasonFor = async (token: string): Promise<string> => {
    try {
      await verifyAccessToken(token);
      return "accepted";
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("accepts the honest token, as a positive control", async () => {
    // Without this, a change that rejected everything would satisfy every
    // negative case below.
    const signed = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "env" })
      .setIssuer(issuer())
      .setAudience("hilbras")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await importPKCS8(process.env.JWT_PRIVATE_KEY as string, "RS256"));
    assert.equal((await verifyAccessToken(signed)).sub, "u1");
  });

  it("refuses a token that asks for `alg: none`", async () => {
    // The token is assembled by hand because `none` cannot be produced by a signer.
    // It carries a *known* kid, so the refusal must come from verification and not
    // from key resolution — otherwise this would pass for the wrong reason.
    const header: JWTHeaderParameters = { alg: "none", typ: "JWT", kid: "env" };
    const payload = {
      sub: "attacker",
      iss: issuer(),
      aud: "hilbras",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const unsigned = `${base64url(header)}.${base64url(payload)}.`;

    const reason = await reasonFor(unsigned);
    assert.notEqual(reason, "accepted", "an unsigned token must never verify");
    assert.doesNotMatch(reason, /unknown key id/, '"env" is a key this server holds');
  });

  it("refuses an HS256 token that reuses the public key as an HMAC secret", async () => {
    // The confusion attack: the verifier is holding an RSA public key, and this
    // token claims the same signature should be checked as HMAC keyed by that
    // public value — which an attacker also has. It only works if the verifier
    // trusts the header's `alg`.
    const forged = await new SignJWT({ sub: "attacker", role: "owner" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: "env" })
      .setIssuer(issuer())
      .setAudience("hilbras")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_PUBLIC_KEY as string));

    const reason = await reasonFor(forged);
    assert.notEqual(reason, "accepted", "an HS256 token must not verify against an RSA key");
    assert.doesNotMatch(reason, /unknown key id/, '"env" resolves, so this must fail on the algorithm');
  });

  it("takes the algorithm from the key it holds, not from the token header", () => {
    // The structural half, and the reason the two cases above hold: verification
    // is handed the key, and jose derives what that key can do. If `algorithms`
    // were ever set from `decodeProtectedHeader(token).alg`, the header would be
    // back in charge and the cases above would begin to depend on jose's defaults
    // rather than on this code.
    const source = readFileSync(path.join(projectRoot, "dist", "services", "tokens.js"), "utf8");
    assert.match(
      source,
      /jwtVerify\(token,\s*publicKey/,
      "verification must pass the held key so the allowed algorithms come from it"
    );
    assert.doesNotMatch(
      source,
      /algorithms:\s*\[[^\]]*header\.alg/,
      "the token header must never supply the algorithm allowlist"
    );
  });
});
