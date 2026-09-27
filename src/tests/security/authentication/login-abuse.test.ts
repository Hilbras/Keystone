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
process.env.KEYSTONE_INTERNAL_API_KEY ||= "login-abuse-test-key";
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
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { auditLog, refreshTokens, userSessions, users } = await import("../../../db/schema.js");
const { hashPassword } = await import("../../../services/secrets/index.js");
const { migrationsFolder } = await import("../../helpers/paths.js");
const { refreshCookieName } = await import("../../../plugins/auth.js");

const RUN_ID = crypto.randomBytes(6).toString("hex");
const DOMAIN = `login-abuse-${RUN_ID}.example.test`;
const PASSWORD = "correct horse battery staple";

const createdUserIds: string[] = [];
let app: FastifyInstance;

/**
 * Present a refresh token the way a browser would.
 *
 * `/auth/refresh` reads the token from a cookie and accepts no token in the
 * body, so a call that passes it as JSON is not testing anything: the request is
 * rejected before the code under examination is ever reached.
 */
function refreshWith(token: string) {
  return app.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { cookie: `${refreshCookieName()}=${token}` },
    payload: {},
  });
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

async function createUser(): Promise<{ id: string; email: string }> {
  const handle = crypto.randomBytes(8).toString("hex");
  const email = `u-${handle}@${DOMAIN}`;
  const [user] = await db
    .insert(users)
    .values({
      email,
      username: `u-${handle}`,
      name: `Abuse ${handle.slice(0, 6)}`,
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
      isActive: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return { id: user.id, email };
}

/** Audit rows carry their payload as `metadata`, which is untyped JSON. */
function rowMetadata(row: { metadata: unknown }): Record<string, unknown> {
  return (row.metadata ?? {}) as Record<string, unknown>;
}

/**
 * Rows added since a snapshot, identified by id.
 *
 * `select()` without an `ORDER BY` makes "the last row" arbitrary, so
 * `.slice(-1)` asserts on whatever Postgres happened to return. When the suite
 * shares the audit table with everything else, that is regularly the wrong row —
 * and a test that checks the wrong row fails for a reason unrelated to the
 * behaviour it claims to cover.
 */
async function newRowsSince(snapshot: Set<string>) {
  const all = await db.select().from(auditLog);
  return all.filter((row) => !snapshot.has(row.id));
}

async function snapshotIds(): Promise<Set<string>> {
  return new Set((await db.select().from(auditLog)).map((r) => r.id));
}

/**
 * Audit rows of a given type for an actor, newest first.
 *
 * Events are stored with their schema version appended — `user_login:v1` — so a
 * query on the bare name finds nothing. Comparing against the bare name would
 * make every assertion here pass vacuously, which is the failure mode this whole
 * suite exists to prevent.
 */
async function auditRows(type: string, userId?: string) {
  const all = await db.select().from(auditLog).where(eq(auditLog.event, `${type}:v1`));
  if (!userId) return all;
  return all.filter((row) => row.userId === userId);
}

// ---------------------------------------------------------------------------
// SEC-037 — a failed login was unaudited
// ---------------------------------------------------------------------------
describe("Failed logins are recorded", () => {
  it("records a failed password attempt", async () => {
    const { email } = await createUser();
    const snapshot = await snapshotIds();

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "definitely not the password" },
    });
    assert.equal(response.statusCode, 401, "a wrong password must be rejected");

    const added = (await newRowsSince(snapshot)).filter(
      (r) => r.event === "user_login_failed:v1"
    );
    assert.ok(
      added.length > 0,
      "a rejected login must leave a record; before 2.8.0 it produced a 401 and nothing else"
    );
    assert.ok(
      added.some((row) => rowMetadata(row).email === email),
      "the record must identify the address that was attempted"
    );
  });

  it("does not attribute the failure to a user, because the address may match none", async () => {
    const { email } = await createUser();
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "wrong" },
    });

    const [row] = (await auditRows("user_login_failed")).filter((r) => rowMetadata(r).email === email);
    assert.ok(row, "the attempt must be identifiable by the submitted address");
    assert.equal(
      row.userId,
      null,
      "a failure must not be attributed to a user id: at that point no credential has been proven"
    );
  });

  it("records a failure on the token login route as well", async () => {
    const { email } = await createUser();
    const snapshot = await snapshotIds();

    const response = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email, password: "wrong", client_id: crypto.randomBytes(8).toString("hex") },
    });
    assert.ok(response.statusCode >= 400, `expected a rejection, got ${response.statusCode}`);

    const added = (await newRowsSince(snapshot)).filter(
      (r) => r.event === "user_login_failed:v1"
    );
    assert.ok(
      added.length > 0,
      "the second login route must be audited too; sharing the guard is not the same as covering both"
    );
  });

  it("does not record a successful login as a failure", async () => {
    const { email } = await createUser();
    const before = (await auditRows("user_login_failed")).length;

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: PASSWORD },
    });
    assert.equal(response.statusCode, 200, "the correct password must succeed");

    assert.equal(
      (await auditRows("user_login_failed")).length,
      before,
      "a successful login must not produce a failure row"
    );
  });
});

// ---------------------------------------------------------------------------
// SEC-038 — a replayed refresh token was indistinguishable from an unknown one
// ---------------------------------------------------------------------------
describe("A replayed refresh token is detected", () => {
  /**
   * The token login route rather than `/auth/login`: the interactive route
   * returns tokens in cookies, and this suite needs the value itself to present
   * it a second time.
   */
  async function loginAndRotate() {
    const { id, email } = await createUser();
    const response = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email, password: PASSWORD },
    });
    assert.equal(response.statusCode, 200, `token login failed: ${response.body}`);
    const body = response.json();
    assert.ok(body.refreshToken, "token login must return a refresh token in the body");
    return { userId: id, refreshToken: body.refreshToken };
  }

  it("reports a second presentation of a consumed token as a replay", async () => {
    const { refreshToken } = await loginAndRotate();

    // The first rotation consumes the token, as every rotation must.
    const first = await refreshWith(refreshToken);
    assert.equal(first.statusCode, 200, "the first use is legitimate");

    const snapshot = await snapshotIds();
    const second = await refreshWith(refreshToken);
    assert.equal(second.statusCode, 401, "a spent token must not mint another session");

    const added = (await newRowsSince(snapshot)).filter(
      (r) => r.event === "refresh_token_replayed:v1"
    );
    assert.equal(
      added.length,
      1,
      "a replay must be distinguishable from an unknown token; before 2.9.0 both returned the same error"
    );
    assert.equal(
      rowMetadata(added[0]).replayed,
      true,
      "the event must say the token was spent, not merely unknown"
    );
  });

  it("revokes the account's remaining credentials, because the token leaked", async () => {
    const { userId, refreshToken } = await loginAndRotate();

    // Establish a live session the legitimate client would still be holding.
    const rotated = await refreshWith(refreshToken);
    assert.equal(rotated.statusCode, 200, "the first rotation is legitimate");

    const liveBefore = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));
    const liveHashes = liveBefore.filter((t) => t.revokedAt === null).map((t) => t.tokenHash);
    assert.ok(liveHashes.length > 0, "precondition: a rotated token should be live before the replay");

    const replayed = await refreshWith(refreshToken);
    assert.equal(replayed.statusCode, 401, "a spent token must not mint another session");

    const afterReplay = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));
    assert.equal(
      afterReplay.filter((t) => t.revokedAt === null).length,
      0,
      "a replay means the token is known to someone else, so everything it could mint must stop working"
    );
    for (const hash of liveHashes) {
      assert.ok(
        afterReplay.some((t) => t.tokenHash === hash && t.revokedAt !== null),
        "the token that was live before the replay must be among those revoked"
      );
    }
  });

  it("does not revoke anything for a token that was never issued", async () => {
    const { userId } = await loginAndRotate();

    const snapshot = await snapshotIds();
    const response = await refreshWith("a-token-that-was-never-issued");
    assert.equal(response.statusCode, 401);

    const added = (await newRowsSince(snapshot)).filter(
      (r) => r.event === "refresh_token_replayed:v1"
    );
    assert.equal(added.length, 1, "the attempt must be recorded even though nothing was revoked");
    assert.equal(
      rowMetadata(added[0]).replayed,
      false,
      "an unknown token is a guess or a stale client, not evidence of a leak, and must not revoke the account"
    );
    const live = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));
    assert.ok(
      live.some((t) => t.revokedAt === null),
      "an unknown token must not revoke the account's sessions"
    );
  });
});
