import crypto from "node:crypto";

/**
 * The one cipher every secrets provider writes with.
 *
 * Extracted from `azureKeyVault.ts` in 3.5.1, for two reasons.
 *
 * **The test needed real code.** The first version of the SEC-059 test suite
 * *copied* the encrypt and decrypt functions into the test file — and a test of a
 * copy cannot fail. Reverting the provider to CBC left the suite green, because
 * the suite was not exercising the provider at all. Four siblings doing it right
 * is evidence, not a control, and neither is a copy.
 *
 * **Five copies of a cipher format is five chances to diverge.** The other four
 * providers each had their own `encryptSecret`/`decryptSecret` with their own idea
 * of the layout. They happen to agree today, which is a fact about today.
 *
 * The format is self-describing — the algorithm is in the prefix — because a
 * ciphertext that says what it is can be migrated and one that does not can only
 * be guessed at. `database.ts`, `environment.ts` and `vault.ts` already write
 * exactly this; `azureKeyVault.ts` did not, and now does.
 *
 * ## The legacy format
 *
 * Before 3.5.1 `azureKeyVault.ts` wrote AES-256-**CBC** as `base64(iv):base64(ct)`.
 * CBC is malleable and unauthenticated, so anyone with write access to the stored
 * value can flip plaintext bits without the key — the position encrypting secrets
 * at rest exists to defend against.
 *
 * The legacy branch below still reads it, and that is deliberate: deleting it
 * would turn a security improvement into an outage, because every already-stored
 * value would become undecryptable and a secrets provider has no safe default for
 * a value it cannot read. Migration is the explicit operation
 * `npm run db:reencrypt-oidc-secrets`, not a side effect of reading.
 *
 * A read path should not silently rewrite storage, and this one does not.
 */

/** The algorithm new ciphertext is written with. */
export const ENCRYPTION_ALGORITHM = "aes-256-gcm";
/**
 * 16 bytes. WebCrypto mandates 12 for GCM, and 12 is also valid — Node's default
 * is 16 and it is what every provider in this repository has always used, so
 * changing it would invalidate existing values for no security gain. The
 * `gcm-no-tag-length` CodeQL rule asks for 12 on the grounds that 12 is the
 * required size; it is the IV length, and obeying it would weaken the tag.
 */
export const IV_LENGTH = 16;
/** 16 bytes — 128 bits, the strongest tag NIST SP 800-38D permits. */
export const AUTH_TAG_LENGTH = 16;
/**
 * Read-only. Needed solely to read values written before 3.5.1.
 *
 * `keystone-secrets-aead-only` in `.semgrep.yml` forbids a `createCipheriv` with
 * this algorithm anywhere under `src/services/secrets/`, and
 * `keystone-secrets-legacy-cbc-is-named` requires the one remaining
 * `createDecipheriv` to live in a function whose name says it is a migration. So
 * "we have finished migrating" is a mechanical property of the source, not a
 * thing to remember.
 */
export const LEGACY_ALGORITHM = "aes-256-cbc";

/** Whether a stored value is in the legacy unauthenticated format. */
export function isLegacyCiphertext(value: string): boolean {
  return !value.startsWith(`${ENCRYPTION_ALGORITHM}$`) && value.split(":").length === 2;
}

/** Encrypt for storage at rest. */
export function encryptAtRest(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTION_ALGORITHM}$${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

/**
 * Decrypt a value written by `encryptAtRest`, or by the pre-3.5.1 CBC code.
 *
 * Throws on a value in neither format, rather than guessing: a secrets provider
 * that silently returns the wrong bytes for an unrecognised value is worse than
 * one that refuses.
 */
export function decryptAtRest(key: Buffer, cipherText: string): string {
  if (cipherText.startsWith(`${ENCRYPTION_ALGORITHM}$`)) {
    const payload = Buffer.from(cipherText.slice(`${ENCRYPTION_ALGORITHM}$`.length), "base64url");
    if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error("Ciphertext is too short to contain an IV and an auth tag");
    }
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    // `final()` throws when the tag does not match, so a tampered value is
    // rejected here rather than returned as plausible garbage. This is the whole
    // difference between GCM and the CBC it replaces.
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
  }

  const parts = cipherText.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Unsupported cipher format: expected ${ENCRYPTION_ALGORITHM}$… or the legacy iv:ciphertext pair`
    );
  }
  const iv = Buffer.from(parts[0], "base64");
  const encrypted = Buffer.from(parts[1], "base64");
  const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf-8");
}
