import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  ENCRYPTION_ALGORITHM,
  IV_LENGTH,
  LEGACY_ALGORITHM,
  decryptAtRest,
  encryptAtRest,
  isLegacyCiphertext,
} from "../../../services/secrets/cipher.js";

/**
 * The Azure Key Vault secrets provider's cipher. (SEC-059)
 *
 * **What was wrong.** Four of the five locally-encrypting providers used
 * AES-256-GCM. This one used AES-256-**CBC**, which is malleable and
 * unauthenticated: someone with write access to the stored ciphertext can flip
 * chosen plaintext bits without the key. Encrypting secrets at rest exists to
 * defend against exactly that position, and this provider did not.
 *
 * It was found while triaging `gcm-no-tag-length` — four *errors* demanding a
 * 12-byte auth tag, which is the **IV** length, and which would have weakened all
 * four GCM sites had it been obeyed. Asking the question the rule was actually
 * asking, "is the tag verified on decrypt?", turned up a provider with no tag at
 * all.
 *
 * **Why a migration and not a one-line change.** Changing the cipher invalidates
 * every already-encrypted value, and a secrets provider has no safe default for a
 * value it cannot read. So: read both, write GCM, and make the old format
 * *identifiable* — which is what the `aes-256-gcm$` prefix is for, and why it
 * matches the other four providers byte for byte.
 *
 * The tests that matter are the ones that fail if the authentication is removed.
 * A suite that only checks "encrypt then decrypt returns the plaintext" passes
 * equally well with CBC, which is why the tamper test is the centre of it.
 *
 * The provider is exercised without Azure, by driving the cipher directly against
 * a fixed key. Its `getEncryptionKey()` talks to the Key Vault HTTP API, which is
 * a reference stub; what is under test is the format and the authentication, and
 * both are local.
 */

// The implementation under test. **Imported, not copied** — the first version of
// this file duplicated the encrypt and decrypt logic, and a test of a copy cannot
// fail: reverting the provider to CBC left all nine tests green because the tests
// were not running the provider.
const KEY = crypto.randomBytes(32);

const encrypt = (plain: string): string => encryptAtRest(KEY, plain);
const decrypt = (cipherText: string): string => decryptAtRest(KEY, cipherText);

/** The legacy CBC form, as the provider wrote it before 3.5.1. */
function encryptLegacyCbc(plain: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(LEGACY_ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  return `${iv.toString("base64")}:${encrypted.toString("base64")}`;
}

/** Flip one bit of the ciphertext body, leaving the IV and tag alone. */
function tamperWithBody(cipherText: string, byteOffsetFromEnd = 1): string {
  const prefix = `${ENCRYPTION_ALGORITHM}$`;
  const payload = Buffer.from(cipherText.slice(prefix.length), "base64url");
  payload[payload.length - byteOffsetFromEnd] ^= 0x01;
  return prefix + payload.toString("base64url");
}

describe("the Azure Key Vault secrets provider's cipher (SEC-059)", () => {
  it("writes the same format as every other provider, so the value is identifiable", () => {
    const value = encrypt("a client secret");
    assert.ok(
      value.startsWith("aes-256-gcm$"),
      `expected the algorithm in the prefix, got ${JSON.stringify(value.slice(0, 24))}`
    );
    // The other four providers use `aes-256-gcm$<base64url>`. If this diverges,
    // `db:reencrypt-oidc-secrets` cannot tell the formats apart.
    assert.match(value, /^aes-256-gcm\$[A-Za-z0-9_-]+$/);
  });

  it("round-trips", () => {
    for (const plain of ["", "x", "a client secret", "🔐 unicode ünïcødé", "x".repeat(4096)]) {
      assert.equal(decrypt(encrypt(plain)), plain, `round trip failed for ${JSON.stringify(plain.slice(0, 20))}`);
    }
  });

  it("rejects a tampered ciphertext body, which is the whole point of the change", () => {
    // The test the old implementation could not pass. CBC has no auth tag, so a
    // flipped bit produces *plausible garbage* rather than an error — or, for
    // structured plaintext, a controlled change. This asserts the GCM behaviour:
    // refuse.
    const original = encrypt("role=admin;org=acme");
    const tampered = tamperWithBody(original);

    assert.notEqual(tampered, original);
    assert.throws(
      () => decrypt(tampered),
      /unable to authenticate|bad decrypt|unsupported state/i,
      "a tampered ciphertext must be rejected, not returned"
    );
  });

  it("rejects a tampered auth tag", () => {
    const original = encrypt("role=admin;org=acme");
    const prefix = `${ENCRYPTION_ALGORITHM}$`;
    const payload = Buffer.from(original.slice(prefix.length), "base64url");
    // The tag sits at IV_LENGTH, so flip a bit there.
    payload[IV_LENGTH] ^= 0x01;
    assert.throws(() => decrypt(prefix + payload.toString("base64url")));
  });

  it("rejects a tampered IV", () => {
    const original = encrypt("role=admin;org=acme");
    const prefix = `${ENCRYPTION_ALGORITHM}$`;
    const payload = Buffer.from(original.slice(prefix.length), "base64url");
    payload[0] ^= 0x01;
    assert.throws(() => decrypt(prefix + payload.toString("base64url")));
  });

  it("rejects ciphertext too short to hold an IV and a tag", () => {
    // Without this, a truncated value would silently index past the end and
    // produce a decipher that fails with a confusing message — or, worse, one
    // that succeeds.
    const truncated = `${ENCRYPTION_ALGORITHM}$${Buffer.alloc(8).toString("base64url")}`;
    assert.throws(() => decrypt(truncated), /too short/);
  });

  it("still reads the legacy CBC format, or existing values become undecryptable", () => {
    // The migration's whole point. Deleting this branch turns a security
    // improvement into an outage.
    for (const plain of ["old client secret", "old totp seed", "🔐"]) {
      const legacy = encryptLegacyCbc(plain);
      assert.ok(!legacy.startsWith("aes-256-gcm$"), "the legacy format must be distinguishable");
      assert.equal(decrypt(legacy), plain, "a legacy value must still decrypt");
    }
  });

  it("refuses a value that is neither format, rather than guessing", () => {
    for (const bad of ["", "not-base64-at-all", "a:b:c", "::", "one:two:three"]) {
      assert.throws(() => decrypt(bad), /Unsupported cipher format/, `should refuse ${JSON.stringify(bad)}`);
    }
  });

  it("cannot be confused with the legacy format: a GCM value never reaches the CBC branch", () => {
    // If the two formats could overlap, a value could be routed to the wrong
    // algorithm — which fails, but confusingly, and a migration that
    // misclassifies a value is worse than one that refuses.
    //
    // The structural guarantee: `base64url` uses the URL-safe alphabet, which
    // contains no colon, so a GCM value cannot split into the two parts the
    // legacy branch requires. That is what makes the prefix check load-bearing
    // rather than a convention.
    for (const plain of ["secret", "a:b", "", "x".repeat(500)]) {
      const gcm = encrypt(plain);
      assert.ok(
        !gcm.includes(":"),
        `a GCM value must contain no colon, or the legacy branch could match it: ${gcm.slice(0, 40)}`
      );
      assert.equal(
        gcm.split(":").length,
        1,
        "the legacy branch requires exactly two colon-separated parts, so length 1 can never match it"
      );
    }
  });

  it("identifies a legacy value without decrypting it", () => {
    // The migration needs to tell the two apart from the stored value alone, and
    // `db:reencrypt-oidc-secrets` skips anything that already looks encrypted — so
    // a value that is misidentified here is a value that never gets migrated.
    assert.equal(isLegacyCiphertext(encryptLegacyCbc("old")), true);
    assert.equal(isLegacyCiphertext(encrypt("new")), false);
    assert.equal(isLegacyCiphertext("nonsense"), false);
    assert.equal(isLegacyCiphertext("a:b:c"), false);
  });
});

