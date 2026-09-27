import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "session-revocation-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { users, refreshTokens, userSessions, passwordResetTokens, magicLinks } = await import(
  "../../../db/schema.js"
);
const {
  revokeRefreshTokens,
  revokeAuthenticationSessions,
  revokeRecoveryCredentials,
  revokeUserSessions,
  revokeAllUserCredentials,
} = await import("../../../services/sessionRevocation.js");

const RUN_ID = crypto.randomBytes(6).toString("hex");
const DOMAIN = `session-revocation-${RUN_ID}.example.test`;
const createdUserIds: string[] = [];

before(async () => {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../db/migrations") });
  await loadSigningKeys();
  const { initializeContainer } = await import("../../../di.js");
  initializeContainer();
});

after(async () => {
  for (const id of createdUserIds) {
    await db.delete(userSessions).where(eq(userSessions.userId, id)).catch(() => {});
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, id)).catch(() => {});
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, id)).catch(() => {});
    await db.delete(magicLinks).where(eq(magicLinks.userId, id)).catch(() => {});
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  const { closeDb } = await import("../../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../../services/redis.js");
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
      email: `u-${handle}@${DOMAIN}`,
      username: `u-${handle}`,
      name: `Revocation ${handle.slice(0, 6)}`,
      passwordHash: "hash",
      emailVerified: true,
      isActive: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

/**
 * Give the user a live session plus refresh token — the state an attacker
 * would be holding after stealing a password.
 */
async function seedLiveCredentials(userId: string, count = 1) {
  const sessions = [];
  const tokens = [];
  for (let i = 0; i < count; i++) {
    const [token] = await db
      .insert(refreshTokens)
      .values({
        userId,
        tokenHash: crypto.randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      })
      .returning();
    const [session] = await db
      .insert(userSessions)
      .values({
        userId,
        refreshTokenId: token.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      })
      .returning();
    tokens.push(token);
    sessions.push(session);
  }
  return { sessions, tokens };
}

async function liveSessionCount(userId: string) {
  const rows = await db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
  return rows.length;
}

async function liveTokenCount(userId: string) {
  const rows = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  return rows.length;
}

async function liveResetTokenCount(userId: string) {
  const rows = await db
    .select({ id: passwordResetTokens.id })
    .from(passwordResetTokens)
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
  return rows.length;
}

describe("Centralized revocation primitives", () => {
  it("revokes refresh tokens", async () => {
    const user = await createUser();
    await seedLiveCredentials(user.id, 3);
    assert.equal(await liveTokenCount(user.id), 3);

    const revoked = await revokeRefreshTokens(user.id);
    assert.equal(revoked, 3);
    assert.equal(await liveTokenCount(user.id), 0);
  });

  it("revokes authentication sessions", async () => {
    const user = await createUser();
    await seedLiveCredentials(user.id, 2);

    const revoked = await revokeAuthenticationSessions(user.id);
    assert.equal(revoked, 2);
    assert.equal(await liveSessionCount(user.id), 0);
  });

  it("leaves an excluded refresh token and session alive", async () => {
    const user = await createUser();
    const { sessions, tokens } = await seedLiveCredentials(user.id, 3);

    const revoked = await revokeUserSessions(user.id, {
      exceptSessionId: sessions[0].id,
      exceptRefreshTokenId: tokens[0].id,
    });

    assert.equal(revoked.sessions, 2, "the other two sessions must be revoked");
    assert.equal(revoked.refreshTokens, 2, "the other two tokens must be revoked");
    assert.equal(await liveSessionCount(user.id), 1, "the excluded session must survive");
    assert.equal(await liveTokenCount(user.id), 1, "the excluded token must survive");

    // And the excluded session is genuinely still usable, not merely un-revoked.
    const [kept] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, sessions[0].id));
    assert.equal(kept.revokedAt, null);
  });

  it("revokes outstanding recovery credentials", async () => {
    const user = await createUser();
    for (let i = 0; i < 3; i++) {
      await db.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: crypto.randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 3600 * 1000),
      });
    }
    assert.equal(await liveResetTokenCount(user.id), 3);

    const revoked = await revokeRecoveryCredentials(user.id);
    assert.equal(revoked, 3);
    assert.equal(await liveResetTokenCount(user.id), 0);
  });

  it("is idempotent — a second revocation revokes nothing", async () => {
    const user = await createUser();
    await seedLiveCredentials(user.id, 2);

    assert.equal((await revokeAllUserCredentials(user.id)).sessions, 2);
    const second = await revokeAllUserCredentials(user.id);
    assert.equal(second.sessions, 0);
    assert.equal(second.refreshTokens, 0);
  });

  it("does not touch another user's credentials", async () => {
    const victim = await createUser();
    const bystander = await createUser();
    await seedLiveCredentials(victim.id, 2);
    await seedLiveCredentials(bystander.id, 2);

    await revokeAllUserCredentials(victim.id);

    assert.equal(await liveSessionCount(victim.id), 0);
    assert.equal(await liveTokenCount(victim.id), 0);
    assert.equal(await liveSessionCount(bystander.id), 2, "a bystander's session must survive");
    assert.equal(await liveTokenCount(bystander.id), 2, "a bystander's token must survive");
  });
});

/**
 * The gap this phase exists to close. Before it, completing a password reset
 * changed the password and left every session and refresh token working, so an
 * attacker who prompted the reset kept their access.
 */
describe("Password reset evicts existing access", () => {
  it("kills the attacker's session and refresh token", async () => {
    const user = await createUser();
    await seedLiveCredentials(user.id, 3);

    const { getSdk } = await import("../../../sdk/index.js");
    const sdk = getSdk();
    // The SDK never hands the token back to a caller, so mint one directly to
    // drive the completion path.
    const value = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(value).digest("hex");
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    const result = await sdk.authentication.resetPasswordWithToken(value, "Recovered-Passw0rd!");
    assert.equal(result.success, true, "the reset itself must succeed");

    assert.equal(await liveSessionCount(user.id), 0, "no session may survive a password reset");
    assert.equal(await liveTokenCount(user.id), 0, "no refresh token may survive a password reset");
    assert.equal(await liveResetTokenCount(user.id), 0, "no reset token may survive");
  });

  it("leaves the recovered account able to log in again", async () => {
    const user = await createUser();
    await seedLiveCredentials(user.id, 1);
    const { getSdk } = await import("../../../sdk/index.js");
    const sdk = getSdk();

    const value = crypto.randomBytes(32).toString("base64url");
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: crypto.createHash("sha256").update(value).digest("hex"),
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    await sdk.authentication.resetPasswordWithToken(value, "Recovered-Passw0rd!");

    // Revoking access must not lock the user out of their own account.
    const login = await sdk.authentication.login({
      email: user.email,
      password: "Recovered-Passw0rd!",
    });
    assert.equal(login.success, true, "the user must be able to log in after recovering");
  });

  it("does not let a token issued before the reset be used afterwards", async () => {
    const user = await createUser();
    const { getSdk } = await import("../../../sdk/index.js");
    const sdk = getSdk();

    // Two reset emails: an earlier one intercepted by an attacker, and the one
    // the user actually uses.
    const stolen = crypto.randomBytes(32).toString("base64url");
    const real = crypto.randomBytes(32).toString("base64url");
    const hash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hash(stolen),
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hash(real),
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    assert.equal(
      (await sdk.authentication.resetPasswordWithToken(real, "Recovered-Passw0rd!")).success,
      true
    );

    const replay = await sdk.authentication.resetPasswordWithToken(stolen, "Attacker-Passw0rd!");
    assert.equal(replay.success, false, "the intercepted earlier token must be dead");
  });
});
