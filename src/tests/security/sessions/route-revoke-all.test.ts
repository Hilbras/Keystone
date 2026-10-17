import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "route-revoke-all-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { buildApp } = await import("../../../index.js");
const { db } = await import("../../../db/index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { auditLog, refreshTokens, userSessions, users } = await import("../../../db/schema.js");
const { hashPassword } = await import("../../../services/secrets/index.js");
const { migrationsFolder } = await import("../../helpers/paths.js");
const { accessCookieName, refreshCookieName } = await import("../../../plugins/auth.js");

/**
 * Route-level coverage for the revocation endpoints.
 *
 * `POST /auth/sessions/revoke-all` had three stacked defects and zero route
 * tests (the suite covered only the service primitives it failed to call):
 * it read the access cookie where the refresh cookie belongs, so the
 * "except current" carve-out was permanently dead; it deleted session rows
 * without ever setting `refresh_tokens.revoked_at`, so every stolen refresh
 * token kept minting access tokens; and the repository's except-branch filter
 * used lexicographic `lt` on UUIDs instead of `ne`.
 */
const RUN_ID = crypto.randomBytes(6).toString("hex");
const DOMAIN = `route-revoke-all-${RUN_ID}.example.test`;
const PASSWORD = "correct horse battery staple";

const createdUserIds: string[] = [];
let app: FastifyInstance;

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

before(async () => {
  await (await import("drizzle-orm/postgres-js/migrator")).migrate(db, {
    migrationsFolder: migrationsFolder(),
  });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const id of createdUserIds) {
    await db.delete(userSessions).where(eq(userSessions.userId, id)).catch(() => {});
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, id)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.userId, id)).catch(() => {});
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
      name: `RevokeAll ${handle.slice(0, 6)}`,
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
      isActive: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

/** A live session + refresh token whose plaintext the test can present as a cookie. */
async function seedLiveCredentials(userId: string, count = 1) {
  const seeds: Array<{ sessionId: string; tokenPlaintext: string }> = [];
  for (let i = 0; i < count; i++) {
    const tokenPlaintext = crypto.randomBytes(32).toString("base64url");
    const [token] = await db
      .insert(refreshTokens)
      .values({
        userId,
        tokenHash: sha256(tokenPlaintext),
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
    seeds.push({ sessionId: session.id, tokenPlaintext });
  }
  return seeds;
}

async function login(email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, `login must succeed: ${res.body}`);
  const cookies = new Map(res.cookies.map((c) => [c.name, c.value]));
  const access = cookies.get(accessCookieName());
  const refresh = cookies.get(refreshCookieName());
  assert.ok(access && refresh, "login must set the access and refresh cookies");
  return { access: access!, refresh: refresh! };
}

function authCookie(access: string, refresh: string) {
  return `${accessCookieName()}=${access}; ${refreshCookieName()}=${refresh}`;
}

function refreshWith(token: string) {
  return app.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { cookie: `${refreshCookieName()}=${token}` },
    payload: {},
  });
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

async function listSessions(access: string, refresh: string): Promise<string[]> {
  const res = await app.inject({
    method: "GET",
    url: "/auth/sessions",
    headers: { cookie: authCookie(access, refresh) },
  });
  assert.equal(res.statusCode, 200, `session list must succeed: ${res.body}`);
  return (res.json() as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
}

describe("POST /auth/sessions/revoke-all", () => {
  it("revokes every other refresh token and session, keeping the current one alive", async () => {
    const user = await createUser();
    const seeds = await seedLiveCredentials(user.id, 2);
    const { access, refresh } = await login(user.email);

    assert.equal(await liveTokenCount(user.id), 3, "precondition: three live tokens");
    assert.equal(await liveSessionCount(user.id), 3, "precondition: three live sessions");

    const res = await app.inject({
      method: "POST",
      url: "/auth/sessions/revoke-all",
      headers: { cookie: authCookie(access, refresh) },
    });
    assert.equal(res.statusCode, 200, `revoke-all must succeed: ${res.body}`);

    assert.equal(await liveTokenCount(user.id), 1, "only the caller's refresh token may survive");
    assert.equal(await liveSessionCount(user.id), 1, "only the caller's session may survive");

    // The stolen credentials are dead: neither can mint a new access token.
    for (const seed of seeds) {
      const attempt = await refreshWith(seed.tokenPlaintext);
      assert.ok(
        attempt.statusCode >= 400,
        `a revoked refresh token must not rotate (got ${attempt.statusCode})`
      );
    }

    // The caller is not logged out by "log out everywhere else".
    const stillWorks = await refreshWith(refresh);
    assert.equal(stillWorks.statusCode, 200, `the current refresh token must still rotate: ${stillWorks.body}`);
  });

  it("reads the refresh cookie, not the access cookie, to find the current session", async () => {
    const user = await createUser();
    await seedLiveCredentials(user.id, 1);
    const { access, refresh } = await login(user.email);

    const before = new Set((await db.select({ id: auditLog.id }).from(auditLog)).map((r) => r.id));
    const res = await app.inject({
      method: "POST",
      url: "/auth/sessions/revoke-all",
      headers: { cookie: authCookie(access, refresh) },
    });
    assert.equal(res.statusCode, 200, res.body);

    const added = (await db.select().from(auditLog)).filter((row) => !before.has(row.id));
    const row = added.find((r) => r.event === "sessions_revoked_all:v1");
    assert.ok(row, "revoke-all must leave an audit row");
    const metadata = (row!.metadata ?? {}) as Record<string, unknown>;
    // The except id must be the caller's live *session* id. The bug read the
    // access cookie, hashed it against refresh_tokens, and never resolved a
    // session — long term this field was a refresh-token id or undefined.
    const [survivor] = await db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)));
    assert.ok(survivor, "the caller's own session must survive");
    assert.equal(
      metadata.exceptSessionId,
      survivor.id,
      "the audit row must name the caller's real session id"
    );
    // One seeded credential revoked alongside the caller's untouched pair:
    // 1 session and 1 refresh token revoked, caller spared in both tables.
    assert.equal(metadata.sessions, 1, "one other session must be reported as revoked");
    assert.equal(metadata.refreshTokens, 1, "one other refresh token must be reported as revoked");
  });

  it("stops listing revoked sessions", async () => {
    const user = await createUser();
    const [seed] = await seedLiveCredentials(user.id, 1);
    const { access, refresh } = await login(user.email);

    const before = await listSessions(access, refresh);
    assert.equal(before.length, 2, "precondition: login session plus seeded session are listed");
    assert.ok(before.includes(seed.sessionId), "precondition: the seeded session is listed");

    const res = await app.inject({
      method: "POST",
      url: "/auth/sessions/revoke-all",
      headers: { cookie: authCookie(access, refresh) },
    });
    assert.equal(res.statusCode, 200, res.body);

    const after = await listSessions(access, refresh);
    assert.equal(after.length, 1, "only the surviving session may be listed");
    assert.ok(!after.includes(seed.sessionId), "the revoked seeded session must disappear from the list");
  });
});

describe("DELETE /auth/sessions/:id", () => {
  it("revokes that session's refresh token so it cannot rotate again", async () => {
    const user = await createUser();
    const [seed] = await seedLiveCredentials(user.id, 1);
    const { access, refresh } = await login(user.email);

    const res = await app.inject({
      method: "DELETE",
      url: `/auth/sessions/${seed.sessionId}`,
      headers: { cookie: authCookie(access, refresh) },
    });
    assert.equal(res.statusCode, 200, `single-session revoke must succeed: ${res.body}`);

    const attempt = await refreshWith(seed.tokenPlaintext);
    assert.ok(attempt.statusCode >= 400, `the revoked session's token must not rotate (got ${attempt.statusCode})`);

    const current = await refreshWith(refresh);
    assert.equal(current.statusCode, 200, `the caller's own session must be untouched: ${current.body}`);
  });

  it("404s for a session belonging to someone else", async () => {
    const owner = await createUser();
    const [foreign] = await seedLiveCredentials(owner.id, 1);
    const intruder = await createUser();
    const { access, refresh } = await login(intruder.email);

    const res = await app.inject({
      method: "DELETE",
      url: `/auth/sessions/${foreign.sessionId}`,
      headers: { cookie: authCookie(access, refresh) },
    });
    assert.equal(res.statusCode, 404, "another user's session must not be reachable");

    const stillWorks = await refreshWith(foreign.tokenPlaintext);
    assert.equal(stillWorks.statusCode, 200, "a foreign 404 must not have revoked the owner's credential");
  });
});