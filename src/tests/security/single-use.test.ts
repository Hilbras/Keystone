import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "single-use-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../db/index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { users, magicLinks, passwordResetTokens, smsOtpCodes } = await import(
  "../../db/schema.js"
);
const {
  consumeMagicLinkRow,
  consumePasswordResetTokenRow,
  consumeSmsOtpCodeRow,
} = await import("../../services/singleUse.js");

const RUN_ID = crypto.randomBytes(6).toString("hex");
const EMAIL_DOMAIN = `single-use-${RUN_ID}.example.test`;
const createdUserIds: string[] = [];

/** Fresh token value and its stored hash. */
function token() {
  const value = crypto.randomBytes(32).toString("base64url");
  return { value, hash: sha256(value) };
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const FUTURE = () => new Date(Date.now() + 3_600_000);
const PAST = () => new Date(Date.now() - 3_600_000);

before(async () => {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../db/migrations") });
  await loadSigningKeys();
  // The password-reset test drives the SDK, which resolves services through the
  // DI container that the application bootstrap normally initializes.
  const { initializeContainer } = await import("../../di.js");
  initializeContainer();
});

after(async () => {
  // Everything cascades from the users, but be explicit about the test's own rows.
  for (const id of createdUserIds) {
    await db.delete(magicLinks).where(eq(magicLinks.userId, id)).catch(() => {});
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, id)).catch(() => {});
    await db.delete(smsOtpCodes).where(eq(smsOtpCodes.userId, id)).catch(() => {});
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  const { closeDb } = await import("../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

async function createUser() {
  const handle = crypto.randomBytes(8).toString("hex");
  const [user] = await db
    .insert(users)
    .values({
      email: `u-${handle}@${EMAIL_DOMAIN}`,
      username: `u-${handle}`,
      name: `Single Use ${handle.slice(0, 6)}`,
      passwordHash: "not-a-real-hash",
      emailVerified: true,
      isActive: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

/** Count how many of N parallel calls won. */
function tally(outcomes: Array<{ outcome: string }>) {
  return {
    consumed: outcomes.filter((o) => o.outcome === "consumed").length,
    replayed: outcomes.filter((o) => o.outcome === "replayed").length,
    expired: outcomes.filter((o) => o.outcome === "expired").length,
    notFound: outcomes.filter((o) => o.outcome === "not_found").length,
  };
}

// The three concurrency levels the plan requires.
const LEVELS = [10, 50, 100];

describe("Magic links: atomic single use", () => {
  for (const level of LEVELS) {
    it(`exactly one of ${level} concurrent redemptions succeeds`, async () => {
      const user = await createUser();
      const { hash } = token();
      await db.insert(magicLinks).values({ userId: user.id, tokenHash: hash, expiresAt: FUTURE() });

      const now = new Date();
      const outcomes = await Promise.all(
        Array.from({ length: level }, () => consumeMagicLinkRow(hash, now))
      );

      const counts = tally(outcomes);
      assert.equal(
        counts.consumed,
        1,
        `expected exactly 1 winner among ${level} concurrent redemptions, got ${counts.consumed}`
      );
      assert.equal(counts.consumed + counts.replayed, level, "every loser must be a replay, not a miss");
    });
  }

  it("returns not_found for a token that never existed", async () => {
    const { hash } = token();
    const result = await consumeMagicLinkRow(hash, new Date());
    assert.equal(result.outcome, "not_found");
    assert.equal(result.reason, undefined, "a miss must not be reportable as a replay");
  });

  it("reports an expired token as expired, not as a replay", async () => {
    const user = await createUser();
    const { hash } = token();
    await db.insert(magicLinks).values({ userId: user.id, tokenHash: hash, expiresAt: PAST() });

    const result = await consumeMagicLinkRow(hash, new Date());
    assert.equal(result.outcome, "expired");
    assert.equal(result.reason, "expired");
  });

  it("reports a second sequential use as a replay", async () => {
    const user = await createUser();
    const { hash } = token();
    await db.insert(magicLinks).values({ userId: user.id, tokenHash: hash, expiresAt: FUTURE() });

    const first = await consumeMagicLinkRow(hash, new Date());
    const second = await consumeMagicLinkRow(hash, new Date());
    assert.equal(first.outcome, "consumed");
    assert.equal(second.outcome, "replayed");
  });

  it("does not consume a token belonging to a different user", async () => {
    const owner = await createUser();
    const other = await createUser();
    const { hash } = token();
    await db.insert(magicLinks).values({ userId: owner.id, tokenHash: hash, expiresAt: FUTURE() });

    // Consuming resolves the row, not the user, so this is about the claim
    // being scoped to the token value itself.
    const result = await consumeMagicLinkRow(hash, new Date());
    assert.equal(result.outcome, "consumed");
    assert.equal(result.record?.userId, owner.id);
    assert.notEqual(result.record?.userId, other.id);
  });
});

describe("Password reset tokens: atomic single use", () => {
  for (const level of LEVELS) {
    it(`exactly one of ${level} concurrent resets succeeds`, async () => {
      const user = await createUser();
      const { hash } = token();
      await db
        .insert(passwordResetTokens)
        .values({ userId: user.id, tokenHash: hash, expiresAt: FUTURE() });

      const now = new Date();
      const outcomes = await Promise.all(
        Array.from({ length: level }, () => consumePasswordResetTokenRow(hash, now))
      );

      const counts = tally(outcomes);
      assert.equal(
        counts.consumed,
        1,
        `expected exactly 1 winner among ${level} concurrent resets, got ${counts.consumed}`
      );
    });
  }

  it("distinguishes replay from expiry", async () => {
    const user = await createUser();
    const live = token();
    const dead = token();
    await db.insert(passwordResetTokens).values({ userId: user.id, tokenHash: live.hash, expiresAt: FUTURE() });
    await db.insert(passwordResetTokens).values({ userId: user.id, tokenHash: dead.hash, expiresAt: PAST() });

    assert.equal((await consumePasswordResetTokenRow(live.hash, new Date())).outcome, "consumed");
    assert.equal((await consumePasswordResetTokenRow(live.hash, new Date())).outcome, "replayed");
    assert.equal((await consumePasswordResetTokenRow(dead.hash, new Date())).outcome, "expired");
  });
});

describe("SMS OTP: atomic single use", () => {
  for (const level of LEVELS) {
    it(`exactly one of ${level} concurrent verifications succeeds`, async () => {
      const user = await createUser();
      const code = String(crypto.randomInt(100000, 999999));
      const hash = sha256(code);
      await db
        .insert(smsOtpCodes)
        .values({ userId: user.id, phoneNumber: "+15550000000", codeHash: hash, expiresAt: FUTURE() });

      const now = new Date();
      const outcomes = await Promise.all(
        Array.from({ length: level }, () => consumeSmsOtpCodeRow(user.id, hash, now))
      );

      const counts = tally(outcomes);
      assert.equal(
        counts.consumed,
        1,
        `expected exactly 1 winner among ${level} concurrent verifications, got ${counts.consumed}`
      );
    });
  }

  it("will not let one user's code be spent against another's row", async () => {
    const owner = await createUser();
    const attacker = await createUser();
    const code = String(crypto.randomInt(100000, 999999));
    const hash = sha256(code);
    await db
      .insert(smsOtpCodes)
      .values({ userId: owner.id, phoneNumber: "+15550000001", codeHash: hash, expiresAt: FUTURE() });

    const result = await consumeSmsOtpCodeRow(attacker.id, hash, new Date());
    assert.equal(result.outcome, "not_found", "a six-digit code must be scoped to its user");
    assert.equal(
      (await consumeSmsOtpCodeRow(owner.id, hash, new Date())).outcome,
      "consumed",
      "the real owner can still use it"
    );
  });
});

describe("The racy pattern this replaced", () => {
  /**
   * The pre-Phase-6 shape, reproduced verbatim: a conditional SELECT followed by
   * an unconditional UPDATE. This test documents why the ordering is wrong, and
   * it fails loudly if the shape ever creeps back into a credential.
   */
  async function racyConsume(hash: string, now: Date): Promise<boolean> {
    const { and, gt, isNull } = await import("drizzle-orm");
    const [record] = await db
      .select()
      .from(magicLinks)
      .where(and(eq(magicLinks.tokenHash, hash), gt(magicLinks.expiresAt, now), isNull(magicLinks.usedAt)))
      .limit(1);
    if (!record) return false;
    await db.update(magicLinks).set({ usedAt: now }).where(eq(magicLinks.id, record.id));
    return true;
  }

  for (const level of [10, 50]) {
    it(`lets more than one of ${level} concurrent callers through (demonstrating the bug)`, async () => {
      const user = await createUser();
      const { hash } = token();
      await db.insert(magicLinks).values({ userId: user.id, tokenHash: hash, expiresAt: FUTURE() });

      const now = new Date();
      const results = await Promise.all(
        Array.from({ length: level }, () => racyConsume(hash, now))
      );
      const winners = results.filter(Boolean).length;

      assert.ok(
        winners > 1,
        `the racy pattern was expected to let several callers through, got ${winners}`
      );
    });
  }

  it("is beaten by the atomic claim at the same concurrency", async () => {
    const user = await createUser();
    const { hash } = token();
    await db.insert(magicLinks).values({ userId: user.id, tokenHash: hash, expiresAt: FUTURE() });

    const now = new Date();
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => consumeMagicLinkRow(hash, now))
    );
    assert.equal(tally(outcomes).consumed, 1);
  });
});

/**
 * The service-level entry points, exercised concurrently.
 *
 * The tests above cover the shared primitive. These cover the functions a route
 * actually calls, so a race reintroduced in a service would fail here even
 * though the primitive stayed correct.
 */
describe("Service entry points under concurrency", () => {
  const LEVEL = 50;

  it(`${LEVEL} concurrent magic link redemptions yield exactly one login`, async () => {
    const { consumeMagicLink } = await import("../../services/magicLinks.js");
    const user = await createUser();
    const { value } = token();
    await db.insert(magicLinks).values({ userId: user.id, tokenHash: sha256(value), expiresAt: FUTURE() });

    const results = await Promise.all(
      Array.from({ length: LEVEL }, () => consumeMagicLink(value))
    );
    const logins = results.filter(Boolean).length;
    assert.equal(logins, 1, `expected 1 login, got ${logins}`);
  });

  it(`${LEVEL} concurrent SMS OTP verifications yield exactly one success`, async () => {
    const { verifySmsOtp } = await import("../../services/smsOtp.js");
    const user = await createUser();
    const code = String(crypto.randomInt(100000, 999999));
    await db
      .insert(smsOtpCodes)
      .values({ userId: user.id, phoneNumber: "+15550000002", codeHash: sha256(code), expiresAt: FUTURE() });

    const results = await Promise.all(
      Array.from({ length: LEVEL }, () => verifySmsOtp(user.id, code))
    );
    const verified = results.filter(Boolean).length;
    assert.equal(verified, 1, `expected 1 verification, got ${verified}`);
  });

  it(`${LEVEL} concurrent password resets yield exactly one success`, async () => {
    const { getSdk } = await import("../../sdk/index.js");
    const user = await createUser();
    const { value } = token();
    await db
      .insert(passwordResetTokens)
      .values({ userId: user.id, tokenHash: sha256(value), expiresAt: FUTURE() });

    const sdk = getSdk();
    const results = await Promise.all(
      Array.from({ length: LEVEL }, (_, i) =>
        sdk.authentication.resetPasswordWithToken(value, `Concurrent-Passw0rd-${i}!`)
      )
    );
    const succeeded = results.filter((r) => r.success).length;
    assert.equal(succeeded, 1, `expected 1 successful reset, got ${succeeded}`);
  });
});

/**
 * Plan item 3 requires a replay to be *detected*, not merely refused. Detection
 * is only useful if it reaches an operator, so this asserts the event actually
 * fires rather than trusting that the emit call is in the right place.
 */
describe("Replay is detected and reported", () => {
  /** Collect events emitted while `fn` runs. */
  async function captureEvents<T>(fn: () => Promise<T>): Promise<{ value: T; types: string[] }> {
    const { subscribeAll } = await import("../../services/events/bus.js");
    const types: string[] = [];
    const unsubscribe = subscribeAll((event) => {
      types.push(event.type as string);
    });
    try {
      const value = await fn();
      // Let the bus drain before reading what it collected.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { value, types };
    } finally {
      unsubscribe();
    }
  }

  it("emits magic_link_replayed when a spent link is presented again", async () => {
    const { consumeMagicLink } = await import("../../services/magicLinks.js");
    const user = await createUser();
    const { value } = token();
    await db.insert(magicLinks).values({ userId: user.id, tokenHash: sha256(value), expiresAt: FUTURE() });

    // First use succeeds and should not be reported as a replay.
    const first = await captureEvents(() => consumeMagicLink(value));
    assert.ok(first.value, "the first redemption should succeed");
    assert.ok(
      !first.types.includes("magic_link_replayed"),
      "a legitimate first use must not look like a replay"
    );

    const second = await captureEvents(() => consumeMagicLink(value));
    assert.equal(second.value, undefined, "the second use must be refused");
    assert.ok(
      second.types.includes("magic_link_replayed"),
      `expected magic_link_replayed, saw: ${second.types.join(", ") || "nothing"}`
    );
  });

  it("emits sms_otp_replayed when a spent code is presented again", async () => {
    const { verifySmsOtp } = await import("../../services/smsOtp.js");
    const user = await createUser();
    const code = String(crypto.randomInt(100000, 999999));
    await db
      .insert(smsOtpCodes)
      .values({ userId: user.id, phoneNumber: "+15550000003", codeHash: sha256(code), expiresAt: FUTURE() });

    await verifySmsOtp(user.id, code);
    const second = await captureEvents(() => verifySmsOtp(user.id, code));
    assert.equal(second.value, false);
    assert.ok(
      second.types.includes("sms_otp_replayed"),
      `expected sms_otp_replayed, saw: ${second.types.join(", ") || "nothing"}`
    );
  });

  it("emits password_reset_token_replayed when a spent reset token is presented again", async () => {
    const { getSdk } = await import("../../sdk/index.js");
    const user = await createUser();
    const { value } = token();
    await db
      .insert(passwordResetTokens)
      .values({ userId: user.id, tokenHash: sha256(value), expiresAt: FUTURE() });

    const sdk = getSdk();
    await sdk.authentication.resetPasswordWithToken(value, "First-Passw0rd!");
    const second = await captureEvents(() =>
      sdk.authentication.resetPasswordWithToken(value, "Second-Passw0rd!")
    );
    assert.equal(second.value.success, false, "the second reset must be refused");
    assert.ok(
      second.types.includes("password_reset_token_replayed"),
      `expected password_reset_token_replayed, saw: ${second.types.join(", ") || "nothing"}`
    );
  });

  it("does not report an expiry as a replay", async () => {
    const { consumeMagicLink } = await import("../../services/magicLinks.js");
    const user = await createUser();
    const { value } = token();
    await db.insert(magicLinks).values({ userId: user.id, tokenHash: sha256(value), expiresAt: PAST() });

    const { types } = await captureEvents(() => consumeMagicLink(value));
    assert.ok(
      !types.includes("magic_link_replayed"),
      "an expired link is not a leak and must not be reported as a replay"
    );
  });
});
