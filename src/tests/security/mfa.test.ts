import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { TOTP, Secret } from "otpauth";
import type { FastifyInstance } from "fastify";
import type { User } from "../../db/schema.js";
import type { UserRepository } from "../../repositories/types.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "mfa-test-internal-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// Keep MFA windows short so expiry behaviour is observable in tests.
process.env.MFA_CHALLENGE_TTL_SECONDS ||= "300";
process.env.MFA_MAX_ATTEMPTS ||= "5";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../db/index.js");
const {
  users,
  refreshTokens,
  userSessions,
  mfaChallenges,
  totpBackupCodes,
} = await import("../../db/schema.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { config } = await import("../../config.js");
const { getSdk } = await import("../../sdk/index.js");
const {
  encryptSecret,
  decryptSecret,
  generateBackupCodes,
  generateSecret,
  storeBackupCodes,
  validateTotpCode,
  verifyBackupCode,
  verifyUserTotpCode,
  hashBackupCode,
} = await import("../../services/totp.js");
const { hashMfaChallenge, isMfaChallengeUsable } = await import("../../services/mfa.js");

let app: FastifyInstance;
let userRepository: UserRepository;

const PASSWORD = "correct-horse-battery-staple";

function totpFor(secret: string, at = Date.now()): string {
  return new TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp: at });
}

/** Create a user with a password and optionally an enrolled, enabled TOTP factor. */
async function createMfaUser(options: { totp?: boolean } = {}): Promise<{ user: User; secret?: string; backupCodes: string[] }> {
  const id = crypto.randomUUID().slice(0, 8);
  const { hashPassword } = await import("../../services/secrets/index.js");
  const user = await userRepository.create({
    email: `mfa-${id}@example.com`,
    username: `mfa-${id}`,
    name: `MFA ${id}`,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
  });

  if (!options.totp) return { user, backupCodes: [] };

  const secret = generateSecret();
  const { codes, hashes } = generateBackupCodes();
  await userRepository.setTotpSecret(user.id, encryptSecret(secret));
  await storeBackupCodes(user.id, hashes);
  await userRepository.enableTotp(user.id);

  return { user: (await userRepository.findById(user.id))!, secret, backupCodes: codes };
}

async function login(email: string, password: string, url = "/auth/login") {
  return app.inject({ method: "POST", url, payload: { email, password } });
}

function countRows(table: typeof refreshTokens, userId: string) {
  return db.select().from(table).where(eq(table.userId, userId));
}

function countSessions(userId: string) {
  return db.select().from(userSessions).where(eq(userSessions.userId, userId));
}

before(async () => {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../db/migrations") });
  await loadSigningKeys();
  app = await buildApp();
  userRepository = app.container.userRepository;
});

after(async () => {
  await app?.close();
  const { closeDb } = await import("../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("TOTP secret handling", () => {
  it("round-trips a secret through authenticated encryption", () => {
    const secret = generateSecret();
    const encrypted = encryptSecret(secret);
    assert.notEqual(encrypted, secret);
    assert.ok(encrypted.startsWith("v2."), "new secrets must use the authenticated format");
    assert.equal(decryptSecret(encrypted), secret);
  });

  it("still decrypts legacy AES-CBC secrets written before v2", () => {
    // Prevents locking out authenticators that enrolled before the upgrade.
    // Prevents locking out authenticators that enrolled before the upgrade.
    const raw = config.TOTP_ENCRYPTION_KEY || config.INTERNAL_API_KEY;
    const legacyKey =
      raw && raw.length >= 32
        ? Buffer.from(raw.slice(0, 32))
        : crypto.createHash("sha256").update(raw || "keystone-totp-default").digest();

    const plaintext = "JBSWY3DPEHPK3PXP";
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", legacyKey, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const legacy = `${iv.toString("base64url")}:${data.toString("base64url")}`;

    assert.equal(decryptSecret(legacy), plaintext);
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const encrypted = encryptSecret(generateSecret());
    const parts = encrypted.split(".");
    const bytes = Buffer.from(parts[3], "base64url");
    bytes[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], bytes.toString("base64url")].join(".");
    assert.throws(() => decryptSecret(tampered));
  });

  it("rejects malformed codes before touching otpauth", () => {
    const secret = generateSecret();
    for (const bad of ["", "abcdef", "12345", "1234567", "12 456"]) {
      assert.equal(validateTotpCode(secret, bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});

describe("User-aware TOTP verification", () => {
  it("verifies against the user's own decrypted secret, not the user id", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const code = totpFor(secret!);

    const result = await verifyUserTotpCode(user, code);
    assert.equal(result.valid, true);
    assert.equal(typeof result.counter, "number");
  });

  it("rejects a user id passed where a secret is expected", () => {
    // The pre-1.8 bug: verifyTOTP(user.id, code) can never succeed.
    const userId = crypto.randomUUID();
    assert.equal(validateTotpCode(userId, "123456"), null);
  });

  it("rejects codes for users without an enabled factor", async () => {
    const { user } = await createMfaUser();
    assert.deepEqual(await verifyUserTotpCode(user, "123456"), { valid: false });
  });

  it("blocks TOTP replay: the same time-step is accepted only once", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const code = totpFor(secret!);

    const first = await verifyUserTotpCode(user, code);
    assert.equal(first.valid, true, "the first use of a time-step must succeed");

    const second = await verifyUserTotpCode(user, code);
    assert.equal(second.valid, false, "a replayed time-step must be refused");

    // The next time-step still works, so this is replay protection rather
    // than a lockout. One step ahead is inside the default acceptance window.
    const later = totpFor(secret!, Date.now() + 30_000);
    assert.equal((await verifyUserTotpCode(user, later)).valid, true);

    // An older step is also refused: the counter only ever moves forward.
    const older = totpFor(secret!, Date.now() - 30_000);
    assert.equal((await verifyUserTotpCode(user, older)).valid, false);
  });
});

describe("Backup codes", () => {
  it("generates high-entropy, expiring, uniquely-hashed codes", async () => {
    const { user, backupCodes } = await createMfaUser({ totp: true });
    assert.equal(backupCodes.length, 10);
    for (const code of backupCodes) {
      assert.match(code, /^[0-9A-F]{5}(-[0-9A-F]{5}){3}$/, "expected 20 hex chars of entropy");
    }
    assert.equal(new Set(backupCodes).size, backupCodes.length);

    const rows = await db
      .select()
      .from(totpBackupCodes)
      .where(eq(totpBackupCodes.userId, user.id));
    assert.equal(rows.length, 10);
    for (const row of rows) {
      assert.ok(row.expiresAt > new Date(), "backup codes must have a future expiry");
      assert.ok(!backupCodes.includes(row.codeHash), "codes must be stored hashed");
    }
  });

  it("is case- and separator-insensitive when consumed", async () => {
    const { user, backupCodes } = await createMfaUser({ totp: true });
    const scrambled = backupCodes[0].replace(/-/g, " ").toLowerCase();
    assert.equal(await verifyBackupCode(user.id, scrambled), true);
  });

  it("consumes each backup code exactly once", async () => {
    const { user, backupCodes } = await createMfaUser({ totp: true });
    assert.equal(await verifyBackupCode(user.id, backupCodes[1]), true);
    assert.equal(await verifyBackupCode(user.id, backupCodes[1]), false, "reused backup code must fail");
  });

  it("allows exactly one winner under concurrent consumption", async () => {
    const { user, backupCodes } = await createMfaUser({ totp: true });
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => verifyBackupCode(user.id, backupCodes[2]))
    );
    assert.equal(attempts.filter(Boolean).length, 1, "exactly one concurrent use may succeed");
  });

  it("rejects expired backup codes", async () => {
    const { user, backupCodes } = await createMfaUser({ totp: true });
    await db
      .update(totpBackupCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(totpBackupCodes.userId, user.id));
    assert.equal(await verifyBackupCode(user.id, backupCodes[0]), false);
  });

  it("keys the stored hash instead of using a bare digest", async () => {
    const normalized = "AAAAABBBBBCCCCCDDDDD";
    const hashed = hashBackupCode("AAAAA-BBBBB-CCCCC-DDDDD");

    // A keyed digest: not a plain SHA-256, so a database dump cannot be
    // brute-forced offline.
    assert.notEqual(hashed, crypto.createHash("sha256").update(normalized).digest("hex"));
    assert.match(hashed, /^[0-9a-f]{64}$/);

    // Normalization is applied before hashing, so separators and case do not
    // create distinct stored values.
    assert.equal(hashBackupCode("aaaaa-bbbbb-ccccc-ddddd"), hashed);
    assert.notEqual(hashBackupCode("AAAAA-BBBBB-CCCCC-DDDDE"), hashed);
  });
});

describe("Password login with MFA enabled", () => {
  it("returns a challenge and issues no tokens for /login", async () => {
    const { user } = await createMfaUser({ totp: true });

    const res = await login(user.email, PASSWORD);
    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.code, "MFA_REQUIRED");
    assert.equal(body.mfaRequired, true);
    assert.ok(body.challenge && body.challenge.length >= 32);
    assert.ok(!("accessToken" in body));
    assert.ok(!("refreshToken" in body));
    assert.ok(!("user" in body));
    assert.deepEqual(sessionCookieNames(res), [], "no session cookie may be set before MFA");

    // Nothing was persisted as a session.
    assert.equal((await countRows(refreshTokens, user.id)).length, 0);
    assert.equal((await countSessions(user.id)).length, 0);
  });

  it("returns a challenge and issues no tokens for /token-login", async () => {
    const { user } = await createMfaUser({ totp: true });

    const res = await login(user.email, PASSWORD, "/auth/token-login");
    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.code, "MFA_REQUIRED");
    assert.ok(!("accessToken" in body));
    assert.equal((await countRows(refreshTokens, user.id)).length, 0);
  });

  it("still issues tokens directly when MFA is disabled", async () => {
    const { user } = await createMfaUser();

    const res = await login(user.email, PASSWORD);
    assert.equal(res.statusCode, 200);
    assert.equal((await countRows(refreshTokens, user.id)).length, 1);
  });

  it("does not accept an inline code in the password request", async () => {
    const { user, secret } = await createMfaUser({ totp: true });

    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: PASSWORD, totp_code: totpFor(secret!) },
    });

    // The removed `totp_code` field must not short-circuit the challenge.
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "MFA_REQUIRED");
    assert.ok(res.json().challenge);
    assert.ok(!("accessToken" in res.json()));
    assert.equal((await countRows(refreshTokens, user.id)).length, 0);
  });

  it("rejects a wrong password without creating a challenge", async () => {
    const { user } = await createMfaUser({ totp: true });
    const res = await login(user.email, "not-the-password");
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "INVALID_CREDENTIALS");

    const challenges = await db.select().from(mfaChallenges).where(eq(mfaChallenges.userId, user.id));
    assert.equal(challenges.length, 0);
  });
});

describe("MFA challenge completion", () => {
  async function startChallenge(user: User, url = "/auth/login") {
    const res = await login(user.email, PASSWORD, url);
    assert.equal(res.statusCode, 401);
    return res.json().challenge as string;
  }

  it("completes with a valid TOTP code and issues a bound token", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = await startChallenge(user);

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!), factor: "totp" },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.accessToken, "an access token is issued only after the second factor");
    assert.ok(body.refreshToken);
    assert.equal(body.factor, "totp");
    assert.equal(body.user.id, user.id);

    const claims = JSON.parse(
      Buffer.from(body.accessToken.split(".")[1], "base64url").toString("utf8")
    );
    assert.equal(claims.mfa_verified, true);
    assert.equal(claims.mfa_factor, "totp");

    const rows = await countRows(refreshTokens, user.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mfaFactor, "totp", "the session records how MFA was satisfied");
  });

  it("completes with a valid backup code", async () => {
    const { user, backupCodes } = await createMfaUser({ totp: true });
    const challenge = await startChallenge(user);

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: backupCodes[0] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().factor, "backup_code");

    // A backup code is single use, including across sessions.
    assert.equal(await verifyBackupCode(user.id, backupCodes[0]), false);
  });

  it("rejects an invalid code without issuing anything", async () => {
    const { user } = await createMfaUser({ totp: true });
    const challenge = await startChallenge(user);

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: "000000" },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "MFA_INVALID_CODE");
    assert.equal((await countRows(refreshTokens, user.id)).length, 0);
  });

  it("rejects an unknown challenge", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge: crypto.randomBytes(32).toString("base64url"), code: "123456" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "MFA_CHALLENGE_INVALID");
  });

  it("rejects a consumed challenge (replay)", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = await startChallenge(user);
    const payload = { challenge, code: totpFor(secret!), factor: "totp" };

    const first = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload });
    assert.equal(second.statusCode, 401);
    assert.equal(second.json().code, "MFA_CHALLENGE_REPLAYED");
    assert.ok(!second.json().accessToken);
    assert.equal((await countRows(refreshTokens, user.id)).length, 1, "replay must not mint a second session");
  });

  it("rejects an expired challenge", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = await startChallenge(user);
    await db
      .update(mfaChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mfaChallenges.challengeHash, hashMfaChallenge(challenge)));

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!) },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "MFA_CHALLENGE_EXPIRED");
    assert.equal((await countRows(refreshTokens, user.id)).length, 0);
  });

  it("locks the challenge and the account after repeated factor failures", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = await startChallenge(user);

    // The account lockout threshold is 5, so the fifth factor failure is
    // rejected as a lockout rather than another invalid code.
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/mfa/verify",
        payload: { challenge, code: "000000" },
      });
      assert.equal(res.statusCode, 401, `attempt ${attempt + 1}`);
      assert.equal(res.json().code, "MFA_INVALID_CODE");
    }

    const tripping = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: "000000" },
    });
    assert.equal(tripping.statusCode, 403);
    assert.equal(tripping.json().code, "ACCOUNT_LOCKED");

    // The challenge is dead: even the correct code can no longer complete it.
    const locked = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!, Date.now() + 30_000) },
    });
    assert.notEqual(locked.statusCode, 200, "the challenge must not recover");
    assert.equal((await countRows(refreshTokens, user.id)).length, 0);

    const row = (await db.select().from(mfaChallenges).where(eq(mfaChallenges.userId, user.id)))[0];
    assert.equal(row.status, "failed", "the challenge is marked failed, not merely counted");
  });

  it("refuses to reuse a TOTP code across two separate challenges", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const code = totpFor(secret!);

    const first = await startChallenge(user);
    const ok1 = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge: first, code },
    });
    assert.equal(ok1.statusCode, 200);

    const second = await startChallenge(user);
    const reused = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge: second, code },
    });
    assert.equal(reused.statusCode, 401, "a captured code must not work twice");
    assert.equal((await countRows(refreshTokens, user.id)).length, 1);
  });

  it("allows exactly one winner when a challenge is completed concurrently", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = await startChallenge(user);
    const payload = { challenge, code: totpFor(secret!), factor: "totp" };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => app.inject({ method: "POST", url: "/auth/mfa/verify", payload }))
    );
    const successes = results.filter((r) => r.statusCode === 200);
    assert.equal(successes.length, 1);
    assert.equal((await countRows(refreshTokens, user.id)).length, 1);
  });

  it("single-use challenge: two different valid factors still yield one session", async () => {
    // Both factors are independently valid, so neither the TOTP counter nor the
    // backup-code uniqueness constraint can be what limits this to one winner —
    // only the challenge's conditional consume can.
    const { user, secret, backupCodes } = await createMfaUser({ totp: true });
    const challenge = await startChallenge(user);

    const results = await Promise.all([
      app.inject({
        method: "POST",
        url: "/auth/mfa/verify",
        payload: { challenge, code: totpFor(secret!), factor: "totp" },
      }),
      app.inject({
        method: "POST",
        url: "/auth/mfa/verify",
        payload: { challenge, code: backupCodes[3], factor: "backup_code" },
      }),
    ]);

    const successes = results.filter((r) => r.statusCode === 200);
    assert.equal(successes.length, 1, "the challenge must admit exactly one completion");
    assert.equal((await countRows(refreshTokens, user.id)).length, 1);

    const losers = results.filter((r) => r.statusCode !== 200);
    for (const loser of losers) {
      assert.ok(
        ["MFA_CHALLENGE_REPLAYED", "MFA_INVALID_CODE"].includes(loser.json().code),
        `unexpected loser code: ${loser.json().code}`
      );
    }
  });

  it("supersedes a previous challenge when a new password step starts", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const stale = await startChallenge(user);
    await startChallenge(user);

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge: stale, code: totpFor(secret!) },
    });
    assert.equal(res.statusCode, 401);
    assert.equal((await countRows(refreshTokens, user.id)).length, 0);
  });

  it("returns tokens in the body for the token_login flow", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = await startChallenge(user, "/auth/token-login");

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!) },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().accessToken);
    assert.ok(res.json().refreshToken);
  });
});

describe("MFA and refresh sessions", () => {
  it("refuses to rotate a session that was created before MFA was enabled", async () => {
    const { user } = await createMfaUser();
    const { createTokenSet, rotateRefreshToken } = await import("../../services/tokens.js");

    const legacy = await createTokenSet(user, "127.0.0.1", "mfa-test");
    assert.ok(legacy.refreshToken);
    const [row] = await countRows(refreshTokens, user.id);
    assert.equal(row!.mfaFactor ?? null, null, "a non-MFA session records no factor");

    // Sanity check: the token really does rotate while MFA is off. Without this
    // the negative assertion below could pass for the wrong reason.
    const beforeEnable = await rotateRefreshToken(legacy.refreshToken, "127.0.0.1", "mfa-test");
    assert.ok(beforeEnable, "a non-MFA session must be able to rotate");

    // Now the user enables MFA. The rotated session stays unrevoked, so the
    // only thing that can refuse it is the missing recorded factor.
    await userRepository.enableTotp(user.id);
    const rotatedHash = crypto.createHash("sha256").update(beforeEnable.refreshToken).digest("hex");
    const stillLive = await db
      .select({ revokedAt: refreshTokens.revokedAt, mfaFactor: refreshTokens.mfaFactor })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, rotatedHash));
    assert.equal(stillLive.length, 1);
    assert.equal(stillLive[0].revokedAt, null, "the session must still be unrevoked");
    assert.equal(stillLive[0].mfaFactor, null, "and must still carry no factor");

    assert.equal(
      await rotateRefreshToken(beforeEnable!.refreshToken, "127.0.0.1", "mfa-test"),
      null,
      "a session with no recorded factor must not be able to keep rotating"
    );
  });

  it("allows an MFA-verified session to rotate", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = (await login(user.email, PASSWORD)).json().challenge;
    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!) },
    });
    assert.equal(res.statusCode, 200);

    const { rotateRefreshToken } = await import("../../services/tokens.js");
    const rotated = await rotateRefreshToken(res.json().refreshToken, "127.0.0.1", "mfa-test");
    assert.ok(rotated, "an MFA-verified session must keep working");
    assert.equal(rotated!.userId, user.id);
  });
});

describe("Token issuance chokepoint", () => {
  it("refuses to mint a token for an MFA user without a factor", async () => {
    const { user } = await createMfaUser({ totp: true });
    const { createAccessToken, createTokenSet, MfaRequiredError } = await import("../../services/tokens.js");

    assert.throws(() => createAccessToken(user), MfaRequiredError);
    await assert.rejects(
      () => createTokenSet(user, "127.0.0.1", "mfa-test"),
      (err: unknown) => err instanceof MfaRequiredError
    );
  });

  it("allows issuance once a factor is asserted", async () => {
    const { user } = await createMfaUser({ totp: true });
    const { createAccessToken } = await import("../../services/tokens.js");
    assert.ok(await createAccessToken(user, { mfaFactor: "totp" }));
  });

  it("blocks the SDK from returning tokens for an MFA user at the password step", async () => {
    const { user } = await createMfaUser({ totp: true });
    const sdk = getSdk();

    const result = await sdk.authentication.login({ email: user.email, password: PASSWORD });
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.status, "requires_mfa");
    assert.ok(!("accessToken" in result.data.data));
  });

  it("exposes a completeMfa operation on the SDK", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const sdk = getSdk();

    const step1 = await sdk.authentication.login({ email: user.email, password: PASSWORD });
    assert.equal(step1.success && step1.data.status, "requires_mfa");
    if (!step1.success || step1.data.status !== "requires_mfa") return;

    const step2 = await sdk.authentication.completeMfa({
      challenge: step1.data.data.challenge,
      code: totpFor(secret!),
    });
    assert.equal(step2.success, true);
    if (!step2.success) return;
    assert.ok(step2.data.accessToken);
    assert.equal(step2.data.factor, "totp");
  });
});

describe("Enrolling MFA", () => {
  it("revokes existing sessions, refresh tokens, and challenges", async () => {
    const { user } = await createMfaUser();
    const loginRes = await login(user.email, PASSWORD);
    assert.equal(loginRes.statusCode, 200);
    assert.equal((await countRows(refreshTokens, user.id)).length, 1);

    assert.equal((await countSessions(user.id)).length, 1);

    // Enroll, then complete enrollment with a real code. Both steps require
    // the password in addition to the session.
    const cookie = sessionCookie(loginRes);
    const bearer = { authorization: `Bearer ${extractBearer(loginRes)}` };
    const enroll = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { ...bearer, cookie },
      payload: { password: PASSWORD },
    });
    assert.equal(enroll.statusCode, 200);
    const { secret } = enroll.json();

    const verify = await app.inject({
      method: "POST",
      url: "/auth/totp/verify",
      headers: { ...bearer, cookie },
      payload: { code: totpFor(secret), password: PASSWORD },
    });
    assert.equal(verify.statusCode, 200);
    assert.equal(verify.json().sessionsRevoked, true);

    const tokens = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id));
    assert.ok(
      tokens.every((t) => t.revokedAt !== null),
      "pre-enrollment refresh tokens must be revoked"
    );

    const sessions = await countSessions(user.id);
    assert.ok(sessions.every((s) => s.revokedAt !== null), "pre-enrollment sessions must be revoked");
  });

  it("regenerates backup codes only with a valid TOTP code", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = (await login(user.email, PASSWORD)).json().challenge;
    const auth = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!) },
    });
    const cookie = sessionCookie(auth);
    const bearer = { authorization: `Bearer ${auth.json().accessToken}` };

    const rejected = await app.inject({
      method: "POST",
      url: "/auth/totp/backup",
      headers: { ...bearer, cookie },
      payload: { code: "000000" },
    });
    assert.equal(rejected.statusCode, 401);

    const before = await db.select().from(totpBackupCodes).where(eq(totpBackupCodes.userId, user.id));
    const accepted = await app.inject({
      method: "POST",
      url: "/auth/totp/backup",
      headers: { ...bearer, cookie },
      payload: { code: totpFor(secret!, Date.now() + 30_000), password: PASSWORD },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().backupCodes.length, 10);

    const after = await db.select().from(totpBackupCodes).where(eq(totpBackupCodes.userId, user.id));
    assert.equal(after.length, 10);
    const beforeHashes = new Set(before.map((r) => r.codeHash));
    assert.ok(after.every((r) => !beforeHashes.has(r.codeHash)), "old codes must be replaced");
  });

  it("cannot disable TOTP without a valid code", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = (await login(user.email, PASSWORD)).json().challenge;
    const auth = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!) },
    });
    const bearer = { authorization: `Bearer ${auth.json().accessToken}` };

    const rejected = await app.inject({
      method: "POST",
      url: "/auth/totp/disable",
      headers: bearer,
      payload: { code: "111111" },
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal((await userRepository.findById(user.id))!.totpEnabled, true);
  });
});

describe("Step-up on factor management", () => {
  /** Complete a login for `user` and return the resulting bearer token. */
  async function authedSession(user: User, secret: string) {
    const challenge = (await login(user.email, PASSWORD)).json().challenge;
    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret) },
    });
    assert.equal(res.statusCode, 200);
    return { token: res.json().accessToken as string, cookie: sessionCookie(res) };
  }

  it("refuses to enroll TOTP with only a session token", async () => {
    const { user } = await createMfaUser();
    const res = await login(user.email, PASSWORD);
    const token = extractBearer(res);

    const noPassword = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    assert.notEqual(noPassword.statusCode, 200, "a session token alone must not enroll a factor");
    const stillEmpty = (await userRepository.findById(user.id))!;
    assert.equal(stillEmpty.totpSecret, null, "no secret may be stored without step-up");

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { authorization: `Bearer ${token}` },
      payload: { password: "not-the-password" },
    });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(wrongPassword.json().code, "INVALID_CREDENTIALS");

    const ok = await app.inject({
      method: "POST",
      url: "/auth/totp/enroll",
      headers: { authorization: `Bearer ${token}` },
      payload: { password: PASSWORD },
    });
    assert.equal(ok.statusCode, 200);
    void user;
  });

  it("refuses to enable TOTP without the password, even with a valid code", async () => {
    const { user } = await createMfaUser();
    const token = extractBearer(await login(user.email, PASSWORD));
    const { secret } = (
      await app.inject({
        method: "POST",
        url: "/auth/totp/enroll",
        headers: { authorization: `Bearer ${token}` },
        payload: { password: PASSWORD },
      })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: "/auth/totp/verify",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: totpFor(secret) },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "STEP_UP_REQUIRED");
    assert.equal((await userRepository.findById(user.id))!.totpEnabled, false);
  });

  it("refuses to disable TOTP without the password", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const { token } = await authedSession(user, secret!);

    const res = await app.inject({
      method: "POST",
      url: "/auth/totp/disable",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: totpFor(secret!, Date.now() + 30_000) },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "STEP_UP_REQUIRED");
    assert.equal((await userRepository.findById(user.id))!.totpEnabled, true);
  });

  it("disables TOTP with the password and destroys the backup codes", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const { token } = await authedSession(user, secret!);

    const res = await app.inject({
      method: "POST",
      url: "/auth/totp/disable",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: totpFor(secret!, Date.now() + 30_000), password: PASSWORD },
    });
    assert.equal(res.statusCode, 200);

    const stored = (await userRepository.findById(user.id))!;
    assert.equal(stored.totpEnabled, false);
    const codes = await db
      .select()
      .from(totpBackupCodes)
      .where(eq(totpBackupCodes.userId, user.id));
    assert.equal(codes.length, 0, "recovery material must not outlive the factor");
  });

  it("refuses to register a passkey for a TOTP account without the password", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const { token } = await authedSession(user, secret!);

    const res = await app.inject({
      method: "POST",
      url: "/auth/webauthn/register/verify",
      headers: { authorization: `Bearer ${token}` },
      payload: { response: { id: "fake" } },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "STEP_UP_REQUIRED");
    void user;
  });
});

describe("MFA completion sets correctly scoped session cookies", () => {
  it("uses the default cookie name for a challenge with no client", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = (await login(user.email, PASSWORD)).json().challenge;

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!) },
    });
    assert.equal(res.statusCode, 200);

    const names = sessionCookieNames(res);
    assert.ok(names.includes("keystone-session"), `expected keystone-session, got ${names.join(", ")}`);
    assert.ok(names.includes("keystone-session-refresh"));
    // The flow name must never leak into a cookie name.
    assert.ok(!names.some((n) => n.includes("login")));
  });

  it("scopes cookies to the client the challenge was created for", async () => {
    const label = `mfa-cookie-${crypto.randomUUID().slice(0, 8)}`;
    const { DrizzleOrganizationRepository } = await import("../../repositories/organization.js");
    const { createApplication } = await import("../../services/applications.js");

    const { user, secret } = await createMfaUser({ totp: true });
    const { user: owner } = await createMfaUser();
    const organizations = new DrizzleOrganizationRepository();
    const org = await organizations.createWithOwner({ name: label, slug: label }, owner.id);
    await organizations.addMembership({ orgId: org.id, userId: user.id, role: "member" });
    const application = await createApplication({
      orgId: org.id,
      name: label,
      redirectUris: ["https://example.com/cb"],
    });

    const challenge = (await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: PASSWORD, client_id: application.clientId },
    })).json().challenge;

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!) },
    });
    assert.equal(res.statusCode, 200);

    // The client id, not the login flow, selects the cookie name — otherwise
    // every app on the cookie domain would share one fixed name.
    const names = sessionCookieNames(res);
    assert.ok(
      names.includes(`app-${application.clientId}-session`),
      `expected an app-scoped cookie, got ${names.join(", ")}`
    );
    assert.ok(!names.includes("keystone-session"), "must not fall back to the default cookie");
  });
});

describe("MFA challenge invariants", () => {
  it("stores only a hash of the challenge", async () => {
    const { user } = await createMfaUser({ totp: true });
    const challenge = (await login(user.email, PASSWORD)).json().challenge;

    const rows = await db.select().from(mfaChallenges).where(eq(mfaChallenges.userId, user.id));
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].challengeHash, challenge);
    assert.equal(rows[0].challengeHash, hashMfaChallenge(challenge));
    assert.equal(rows[0].status, "requires_mfa");
    assert.equal(rows[0].maxAttempts, 5);
  });

  it("marks a consumed, exhausted, or expired challenge as unusable", async () => {
    const { user } = await createMfaUser({ totp: true });
    await login(user.email, PASSWORD);
    const row = (await db.select().from(mfaChallenges).where(eq(mfaChallenges.userId, user.id)))[0];

    assert.equal(isMfaChallengeUsable(row), true);
    assert.equal(isMfaChallengeUsable({ ...row, status: "consumed" }), false);
    assert.equal(isMfaChallengeUsable({ ...row, status: "failed" }), false);
    assert.equal(isMfaChallengeUsable({ ...row, attempts: row.maxAttempts }), false);
    assert.equal(isMfaChallengeUsable({ ...row, expiresAt: new Date(Date.now() - 1) }), false);
  });

  it("rejects a challenge whose user was deactivated mid-flow", async () => {
    const { user, secret } = await createMfaUser({ totp: true });
    const challenge = (await login(user.email, PASSWORD)).json().challenge;

    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: totpFor(secret!) },
    });
    assert.equal(res.statusCode, 403);
    assert.ok(!res.json().accessToken);
  });

  it("invalidates outstanding challenges when the factor is disabled", async () => {
    const { user } = await createMfaUser({ totp: true });
    const challenge = (await login(user.email, PASSWORD)).json().challenge;
    await userRepository.disableTotp(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa/verify",
      payload: { challenge, code: "123456" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, "MFA_NOT_REQUIRED");
  });
});

describe("OAuth2 authorization codes carry the MFA assertion", () => {
  /**
   * Build an organization + application and add `member` to it, so the
   * authorization-code exchange has a valid tenant context to work with.
   */
  async function fixture(member: User) {
    const { DrizzleOrganizationRepository } = await import("../../repositories/organization.js");
    const { createApplication } = await import("../../services/applications.js");
    const { storeAuthorizationCode } = await import("../../services/oauth2.js");

    const label = `mfa-app-${crypto.randomUUID().slice(0, 8)}`;
    const { user: owner } = await createMfaUser();
    const organizations = new DrizzleOrganizationRepository();
    const org = await organizations.createWithOwner({ name: label, slug: label }, owner.id);
    const application = await createApplication({
      orgId: org.id,
      name: label,
      redirectUris: ["https://example.com/callback"],
    });
    await organizations.addMembership({ orgId: org.id, userId: member.id, role: "member" });
    return { application, storeAuthorizationCode };
  }

  it("records no factor when the approving session had none", async () => {
    const { user } = await createMfaUser();
    const { application, storeAuthorizationCode } = await fixture(user);

    const code = await storeAuthorizationCode({ appId: application.id, userId: user.id });
    assert.equal(code.mfaFactor, null);
  });

  it("records the factor asserted by the approving session", async () => {
    const { user } = await createMfaUser();
    const { application, storeAuthorizationCode } = await fixture(user);

    const code = await storeAuthorizationCode({
      appId: application.id,
      userId: user.id,
      mfaFactor: "totp",
    });
    assert.equal(code.mfaFactor, "totp");
  });

  it("refuses to exchange a code for an MFA user when no factor was recorded", async () => {
    const { user } = await createMfaUser({ totp: true });
    const { application, storeAuthorizationCode } = await fixture(user);
    const { createTokenResponse } = await import("../../services/oauth2.js");
    const { MfaRequiredError } = await import("../../services/tokens.js");

    // Simulates a session approved before MFA was enabled, or one whose factor
    // was stripped: the exchange must not silently upgrade it.
    const code = await storeAuthorizationCode({ appId: application.id, userId: user.id });
    assert.equal(code.mfaFactor, null);

    await assert.rejects(
      () => createTokenResponse(user, application, ["openid"], {}),
      (err: unknown) => err instanceof MfaRequiredError
    );
  });

  it("exchanges a code that carries a verified factor", async () => {
    const { user } = await createMfaUser({ totp: true });
    const { application, storeAuthorizationCode } = await fixture(user);
    const { createTokenResponse } = await import("../../services/oauth2.js");

    const code = await storeAuthorizationCode({
      appId: application.id,
      userId: user.id,
      mfaFactor: "totp",
    });
    assert.equal(code.mfaFactor, "totp");

    const response = await createTokenResponse(user, application, ["openid"], { mfaFactor: "totp" });
    assert.ok(response.access_token);
    assert.ok(response.refresh_token);
  });
});

// --- helpers -------------------------------------------------------------

/** The login response only exposes the token through Set-Cookie. */
function extractBearer(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers["set-cookie"];
  const list = Array.isArray(cookies) ? cookies.map(String) : cookies ? [String(cookies)] : [];
  const match = list.find((c) => c.startsWith("keystone-session="));
  assert.ok(match, "expected a keystone-session cookie");
  return decodeURIComponent(match.split(";")[0].split("=")[1]);
}

function sessionCookieNames(res: { headers: Record<string, unknown> }): string[] {
  const cookies = res.headers["set-cookie"];
  const list = Array.isArray(cookies) ? cookies.map(String) : cookies ? [String(cookies)] : [];
  return list
    .map((c) => c.split(";")[0].split("=")[0])
    .filter((name) => name.endsWith("session") || name.endsWith("session-refresh"));
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers["set-cookie"];
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  return list
    .map((c) => String(c).split(";")[0])
    .filter((c) => c.includes("="))
    .join("; ");
}

