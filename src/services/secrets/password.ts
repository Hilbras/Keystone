import crypto from "node:crypto";
import * as argon2 from "argon2";

// OWASP-recommended minimum parameters for argon2id (as of 2023).
const ARGON2_MEMORY_COST = 65536;
const ARGON2_TIME_COST = 3;
const ARGON2_PARALLELISM = 4;

// Legacy scrypt parameters used by early Keystone deployments.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function scryptPromise(
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) return reject(err);
      resolve(derived);
    });
  });
}

async function verifyScryptPassword(plain: string, hash: string): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length !== 6) return false;
  const [, nStr, rStr, pStr, saltB64, derivedB64] = parts;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(derivedB64, "base64url");
  const derived = await scryptPromise(plain, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Hash a password using argon2id. The encoded string contains the salt and
 * parameters, so verification does not need external storage.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: ARGON2_MEMORY_COST,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
  });
}

/**
 * Verify a password against an argon2id or legacy scrypt hash.
 */
export async function verifyPassword(
  plain: string,
  hash: string | null | undefined
): Promise<boolean> {
  if (!hash) return false;

  if (hash.startsWith("scrypt$")) {
    return verifyScryptPassword(plain, hash);
  }

  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
