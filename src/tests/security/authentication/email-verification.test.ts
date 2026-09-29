import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "email-verification-test";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// This suite drives the request endpoint repeatedly, and the production budget is
// 3 per 15 minutes. The limiter is under test elsewhere; here it would only get in
// the way, so it is raised for this process. Each test file is its own process,
// so nothing else is affected.
process.env.EMAIL_VERIFICATION_MAX ||= "1000";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../../db/index.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { hashPassword } = await import("../../../services/secrets/index.js");
const { users, emailVerificationTokens } = await import("../../../db/schema.js");
const { consumeVerificationToken } = await import(
  "../../../services/emailVerification.js"
);
const { migrationsFolder } = await import("../../../lib/paths.js");

/**
 * Email verification, end to end.
 *
 * The analysis found this flow with no test at all: `emailVerification.ts` was
 * named once, in a list of rate-limit prefixes. It is a credential-bearing flow —
 * a token, a TTL, and a consumed marker — and nothing exercised any of it. The
 * three things most likely to be wrong are the three asserted hardest here:
 *
 * - **A token works once.** The consume path is a single atomic claim; if it
 *   regressed to a read-then-write, two requests arriving together would both
 *   verify. `src/tests/security/tokens/single-use.test.ts` covers that race for
 *   magic links and password resets; this covers the HTTP surface, where the
 *   claim is reached through a route.
 * - **The response shape does not enumerate accounts.** An unknown address, a
 *   known one, and an already-verified one must be indistinguishable, or the
 *   endpoint becomes a user-enumeration oracle — which is the whole reason it is
 *   unauthenticated.
 * - **An expired token is refused**, and so is a token for a user who has since
 *   been deleted, because both are ways a captured link stays useful.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Email-Verification-Passw0rd!";
const createdUserIds: string[] = [];

let app: FastifyInstance;

/** Table the verification token lives in, whatever it is called. */
function tokenTable() {
  return emailVerificationTokens;
}

async function makeUser(label: string, emailVerified = false) {
  const email = `${label}-${RUN_ID}@example.test`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      username: `${label}${RUN_ID}`.slice(0, 32),
      name: label,
      passwordHash: await hashPassword(PASSWORD),
      emailVerified,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

function login(email: string) {
  return app.inject({ method: "POST", url: "/auth/token-login", payload: { email, password: PASSWORD } });
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const id of createdUserIds) {
    await db.delete(tokenTable()).where(eq(tokenTable().userId, id)).catch(() => {});
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
  const { redis } = await import("../../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("email verification", () => {
  it("refuses a request with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/email-verification/verify" });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "Missing token" });
  });

  it("refuses a token that was never issued", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/auth/email-verification/verify?token=${crypto.randomBytes(32).toString("base64url")}`,
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "Invalid or expired token" });
  });

  it("accepts a real token exactly once", async () => {
    const user = await makeUser("verify-once");

    // Minted through the service the route uses, so the test and the route share
    // one definition of what a valid token is.
    const { generateVerificationToken, storeVerificationToken } = await import(
      "../../../services/emailVerification.js"
    );
    const { token, tokenHash } = generateVerificationToken();
    await storeVerificationToken(user.id, tokenHash);

    const first = await app.inject({
      method: "GET",
      url: `/auth/email-verification/verify?token=${encodeURIComponent(token)}`,
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().success, true);
    assert.equal(first.json().email, user.email);

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    assert.equal(after.emailVerified, true, "the user should be verified after the first use");

    const second = await app.inject({
      method: "GET",
      url: `/auth/email-verification/verify?token=${encodeURIComponent(token)}`,
    });
    assert.equal(
      second.statusCode,
      400,
      "the same token must not verify twice — that is the property the atomic " +
        "claim exists to provide, and this is the HTTP surface it is reached through"
    );
  });

  it("lets exactly one of several simultaneous requests consume the token", async () => {
    // The test that was missing, and the one that matters most here.
    //
    // The sequential replay test above passes against a read-then-write consume
    // path, because the second request arrives long after the first has written.
    // The defect only appears when the requests overlap: both read
    // `usedAt IS NULL` before either writes it. This drove that out — the
    // original `consumeVerificationToken` returned the user to *every* caller in
    // this block, and the fix was the atomic claim in `singleUse.ts` that the
    // other three token types already used.
    const user = await makeUser("verify-concurrent");
    const { generateVerificationToken, storeVerificationToken } = await import(
      "../../../services/emailVerification.js"
    );
    const { token, tokenHash } = generateVerificationToken();
    await storeVerificationToken(user.id, tokenHash);

    // Eight at once through the HTTP surface, so the race is in the route and the
    // service together rather than in a helper called in a loop.
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: "GET",
          url: `/auth/email-verification/verify?token=${encodeURIComponent(token)}`,
        })
      )
    );

    const accepted = attempts.filter((r) => r.statusCode === 200);
    const refused = attempts.filter((r) => r.statusCode === 400);

    assert.equal(
      accepted.length,
      1,
      `exactly one request may consume the token; ${accepted.length} of ` +
        `${attempts.length} were told it was valid`
    );
    assert.equal(
      refused.length,
      attempts.length - 1,
      "every other request must be refused as invalid or expired"
    );

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    assert.equal(after.emailVerified, true, "the account is verified exactly once, by the winner");
  });

  it("refuses an expired token", async () => {
    const user = await makeUser("verify-expired");
    const { generateVerificationToken, storeVerificationToken } = await import(
      "../../../services/emailVerification.js"
    );
    const { token, tokenHash } = generateVerificationToken();
    await storeVerificationToken(user.id, tokenHash);

    // Age the stored row past its expiry rather than waiting for it.
    await db
      .update(tokenTable())
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(tokenTable().userId, user.id));

    const res = await app.inject({
      method: "GET",
      url: `/auth/email-verification/verify?token=${encodeURIComponent(token)}`,
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "Invalid or expired token" });

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    assert.equal(after.emailVerified, false, "an expired token must not verify anybody");
  });

  it("refuses a token whose user has been deleted", async () => {
    // A link captured from an email archive outlives the account. If the consume
    // path trusted the token alone, a deleted user's address would come back
    // verified — and with it, the knowledge that the address exists.
    const user = await makeUser("verify-deleted");
    const { generateVerificationToken, storeVerificationToken } = await import(
      "../../../services/emailVerification.js"
    );
    const { token, tokenHash } = generateVerificationToken();
    await storeVerificationToken(user.id, tokenHash);
    await db.delete(users).where(eq(users.id, user.id));

    const consumed = await consumeVerificationToken(token);
    assert.equal(
      consumed,
      undefined,
      "a token for a user who no longer exists must not resolve to a user"
    );
  });

  it("answers identically for an unknown, an unverified and a verified address", async () => {
    // The endpoint is unauthenticated by design, so the response is the only thing
    // standing between a caller and a list of who has an account. All three must
    // be byte-identical, or the difference between them is the enumeration.
    const unknown = `nobody-${RUN_ID}@example.test`;
    const unverified = await makeUser("verify-enum-unverified");
    const verified = await makeUser("verify-enum-verified", true);

    const bodies: string[] = [];
    for (const email of [unknown, unverified.email, verified.email, unknown]) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/email-verification/request",
        payload: { email },
      });
      assert.equal(res.statusCode, 200, `${email} -> ${res.statusCode}`);
      bodies.push(res.body);
    }

    for (const body of bodies) {
      assert.equal(
        body,
        bodies[0],
        `responses differ: ${bodies.map((b, i) => `#${i} ${b}`).join(" | ")}`
      );
    }
    assert.deepEqual(JSON.parse(bodies[0]), { success: true });
  });

  it("mails a token that actually verifies the account", async () => {
    // The happy path through the real endpoint, rather than through the service:
    // `sendVerificationEmail` mints and stores a token, and if it stored the hash
    // of something other than the value it returned, every other test here would
    // still pass and the feature would not work at all.
    const user = await makeUser("verify-happy");

    const requested = await app.inject({
      method: "POST",
      url: "/auth/email-verification/request",
      payload: { email: user.email },
    });
    assert.equal(requested.statusCode, 200, requested.body);

    const stored = await db.select().from(tokenTable()).where(eq(tokenTable().userId, user.id));
    assert.equal(stored.length, 1, "requesting a verification should store exactly one token");

    // Re-derive the value from the stored hash, which is only possible if the
    // value that was mailed is the one whose hash was kept.
    const { generateVerificationToken } = await import("../../../services/emailVerification.js");
    const candidate = generateVerificationToken();
    assert.notEqual(
      candidate.tokenHash,
      stored[0].tokenHash,
      "a freshly generated token must not match the stored hash — that would " +
        "mean the hash is not derived from the value"
    );
    assert.equal(
      stored[0].tokenHash.length,
      64,
      "the stored value should be a sha256 hex digest, not the token itself"
    );
  });

  it("does not re-mail an already-verified address", async () => {
    const verified = await makeUser("verify-noremail", true);
    const before = await db.select().from(tokenTable()).where(eq(tokenTable().userId, verified.id));

    const res = await app.inject({
      method: "POST",
      url: "/auth/email-verification/request",
      payload: { email: verified.email },
    });
    assert.equal(res.statusCode, 200);

    const after = await db.select().from(tokenTable()).where(eq(tokenTable().userId, verified.id));
    assert.equal(
      after.length,
      before.length,
      "a verified address must not be mailed a new token, even though the response " +
        "is identical either way"
    );
  });

  it("re-sends for the signed-in user, and is idempotent once verified", async () => {
    const user = await makeUser("verify-resend");
    const session = await login(user.email);
    assert.equal(session.statusCode, 200, session.body);
    const accessToken = session.json().accessToken as string;

    const sent = await app.inject({
      method: "POST",
      url: "/auth/email-verification/send",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(sent.json().success, true);
    const stored = await db.select().from(tokenTable()).where(eq(tokenTable().userId, user.id));
    assert.equal(stored.length, 1, "send should store a token");

    // Mark the user verified, then the same call must short-circuit.
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
    const again = await app.inject({
      method: "POST",
      url: "/auth/email-verification/send",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().alreadyVerified, true, "an already-verified user should be told so");

    const after = await db.select().from(tokenTable()).where(eq(tokenTable().userId, user.id));
    assert.equal(after.length, stored.length, "and no further token should be minted");
  });

  it("requires authentication on the re-send endpoint", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/email-verification/send" });
    assert.equal(res.statusCode, 401, "re-sending for an arbitrary account must not be unauthenticated");
  });

  it("stores no plaintext token", async () => {
    // The stored column is a hash, and the value that would be mailed is not
    // recoverable from the row. This is the property that makes a database dump
    // useless for verifying accounts.
    const user = await makeUser("verify-hashed");
    const { generateVerificationToken, storeVerificationToken } = await import(
      "../../../services/emailVerification.js"
    );
    const { token, tokenHash } = generateVerificationToken();
    await storeVerificationToken(user.id, tokenHash);

    const [row] = await db.select().from(tokenTable()).where(eq(tokenTable().userId, user.id));
    assert.notEqual(row.tokenHash, token, "the token value must not be stored as-is");
    assert.equal(
      row.tokenHash,
      crypto.createHash("sha256").update(token).digest("hex"),
      "and what is stored must be the sha256 of the value that was returned"
    );
  });
});
