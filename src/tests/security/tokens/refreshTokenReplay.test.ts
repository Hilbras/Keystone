import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "refresh-replay-test";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

// This suite drives the refresh endpoint more than a hundred times in one
// window, and the production budget is a handful per minute. The limiter is
// under test elsewhere; here it would only get in the way, so it is raised for
// this process. Each test file is its own process, so nothing else is
// affected — and setting it here rather than relying on the runner's
// environment means the suite means the same thing however it is invoked.
process.env.REFRESH_RATE_MAX ||= "1000000";
process.env.REFRESH_RATE_WINDOW ||= "60";
process.env.LOGIN_MAX_ATTEMPTS ||= "1000000";
process.env.LOGIN_PER_ADDRESS_MAX ||= "1000000";
process.env.LOGIN_WINDOW_SECONDS ||= "60";
process.env.GLOBAL_RATE_LIMIT_MAX ||= "1000000";
process.env.GLOBAL_RATE_LIMIT_WINDOW ||= "60";

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
const { hashPassword, hashClientSecret, generateClientSecret } = await import(
  "../../../services/secrets/index.js"
);
const { users, refreshTokens, userSessions, organizations, applications, orgMemberships } =
  await import("../../../db/schema.js");
const { refreshCookieName } = await import("../../../plugins/auth.js");
const { migrationsFolder } = await import("../../../lib/paths.js");

/**
 * A replayed refresh token must end the credential it came from, and only
 * that credential.
 *
 * The rotation consumes a refresh token, so presenting one twice means two
 * parties hold it. The safe response is to revoke what the stolen token could
 * become — but the *right* response is narrower than that, and the difference
 * is the whole subject of this suite:
 *
 * - **Revoking the family** ends the login the attacker compromised and
 *   nothing else. The attacker may already have rotated the stolen token, and
 *   the token they hold is a descendant of it, so the family is the smallest
 *   set that certainly includes it.
 * - **Revoking the account** ends every session the user has, including the
 *   ones on devices the attacker never touched. That buys no additional
 *   security — the attacker's token is already in the family — and it hands
 *   the attacker a denial of service for the price of one stolen token.
 * - **Revoking nothing** is what the OAuth grant path did, and it is how a
 *   stolen token stays useful indefinitely.
 *
 * The suite also pins the distinction between a replay and a race. A client
 * that sends two refreshes at once is the ordinary case, not an attack, and
 * it must not cost the user their session.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Refresh-Replay-Passw0rd!";
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdAppIds: string[] = [];

let app: FastifyInstance;

async function createOrg(): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({
      name: `Replay Org ${RUN_ID.slice(0, 4)}`,
      slug: `replay-${RUN_ID}-${crypto.randomBytes(3).toString("hex")}`,
    })
    .returning();
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(label: string) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${RUN_ID}@example.test`,
      username: `${label}${RUN_ID}`.slice(0, 32),
      name: label,
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

/**
 * The `Cookie` header the server set on a response.
 *
 * The refresh endpoint answers with `{ success: true }` and puts the rotated
 * token in a cookie, so the cookie header is the only place the new token
 * exists. A test that reads `body.refreshToken` finds `undefined` and then
 * asserts that `undefined` is not usable — which is true, and says nothing.
 */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers["set-cookie"];
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  return list
    .map((cookie) => String(cookie).split(";")[0])
    .filter((cookie) => cookie.includes("="))
    .join("; ");
}

/**
 * The refresh token inside a `Cookie` header.
 *
 * The cookie is named for the client it belongs to — a login bound to an
 * application gets `app-<clientId>-session-refresh`, not the default name — so
 * the caller has to say which one it is looking for.
 */
function refreshTokenFrom(cookie: string, clientId?: string): string {
  const name = refreshCookieName(clientId);
  for (const part of cookie.split("; ")) {
    if (part.startsWith(`${name}=`)) {
      return decodeURIComponent(part.slice(name.length + 1));
    }
  }
  assert.fail(`no ${name} cookie in: ${cookie}`);
}

/**
 * Log in and return the cookie the server issued, plus the token in it.
 *
 * `/auth/login` is the endpoint that sets the session cookie; `/auth/token-login`
 * returns the tokens in the body and sets no cookie, so a client that then
 * calls the refresh endpoint has nothing to present.
 */
async function login(email: string, clientId?: string): Promise<{ cookie: string; refreshToken: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: PASSWORD, ...(clientId ? { client_id: clientId } : {}) },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = sessionCookie(res);
  assert.ok(cookie, `the login must set a session cookie: ${res.body.slice(0, 200)}`);
  return { cookie, refreshToken: refreshTokenFrom(cookie, clientId) };
}

/**
 * Present a session at the refresh endpoint.
 *
 * The route reads the token from a cookie, not from the body — `getRefreshToken`
 * looks at `request.cookies` and nowhere else — so a test that posts
 * `refresh_token` in the JSON body is testing a request the server never
 * looks at, and every assertion about it is vacuously true.
 */
function refresh(cookie: string) {
  return app.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { cookie },
  });
}

/** Collect the event types emitted while `fn` runs. */
async function captureEvents<T>(fn: () => Promise<T>): Promise<{ value: T; types: string[] }> {
  const { subscribeAll } = await import("../../../services/events/bus.js");
  const types: string[] = [];
  const unsubscribe = subscribeAll((event) => {
    types.push(event.type as string);
  });
  try {
    const value = await fn();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { value, types };
  } finally {
    unsubscribe();
  }
}

/**
 * Age a token's consumption so it falls outside the replay grace window.
 *
 * The window exists so that a client sending two refreshes at once is not
 * mistaken for an attacker. A test that waits it out would be slow and flaky,
 * so the timestamp is moved instead — which is also exactly what a token
 * stolen an hour ago looks like.
 */
async function ageConsumption(token: string, minutes: number) {
  await db
    .update(refreshTokens)
    .set({ consumedAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(refreshTokens.tokenHash, sha256(token)));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const id of createdAppIds) await db.delete(applications).where(eq(applications.id, id)).catch(() => {});
  for (const id of createdOrgIds) await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
  for (const id of createdUserIds) {
    await db
      .delete(userSessions)
      .where(eq(userSessions.userId, id))
      .catch(() => {});
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, id)).catch(() => {});
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

describe("a replayed refresh token ends its own credential family", () => {
  it("refuses the replayed token", async () => {
    const user = await makeUser("replay-refused");
    const first = await login(user.email);

    // The first exchange rotates the token: it is consumed and replaced.
    const rotated = await refresh(first.cookie);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const successor = refreshTokenFrom(sessionCookie(rotated));
    assert.notEqual(successor, first.refreshToken, "rotation must issue a new token");

    // The second presentation of the spent token is the replay.
    const replay = await refresh(first.cookie);
    assert.equal(replay.statusCode, 401, `a spent token must not be accepted: ${replay.body}`);
  });

  it("revokes the successor token, so the family cannot mint anything else", async () => {
    const user = await makeUser("replay-family");
    const first = await login(user.email);
    const rotated = await refresh(first.cookie);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const successorCookie = sessionCookie(rotated);

    // Make the consumption old enough to be outside the race window.
    await ageConsumption(first.refreshToken, 30);

    const replay = await refresh(first.cookie);
    assert.equal(replay.statusCode, 401);

    // The successor is the token the attacker would be holding. It must be dead.
    const successorResponse = await refresh(successorCookie);
    assert.equal(
      successorResponse.statusCode,
      401,
      "the token that replaced the replayed one must be revoked with it — " +
        "otherwise the attacker simply rotates the stolen token and keeps it"
    );
  });

  it("ends the sessions that hang off the revoked tokens", async () => {
    const user = await makeUser("replay-sessions");
    const first = await login(user.email);
    await refresh(first.cookie);
    await ageConsumption(first.refreshToken, 30);

    const live = await db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)));
    assert.ok(live.length >= 1, "the login should have left a live session");

    await refresh(first.cookie);

    const still = await db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)));
    assert.equal(
      still.length,
      0,
      "a session whose token is dead must not still claim to be live — the user " +
        "would see 'signed in' on a session that cannot be refreshed"
    );
  });

  it("emits refresh_token_replayed", async () => {
    const user = await makeUser("replay-event");
    const first = await login(user.email);
    await refresh(first.cookie);
    await ageConsumption(first.refreshToken, 30);

    const { types } = await captureEvents(() => refresh(first.cookie));
    assert.ok(
      types.includes("refresh_token_replayed"),
      `expected refresh_token_replayed, saw: ${types.join(", ") || "nothing"}`
    );
  });

  it("leaves the other logins of the same user alone", async () => {
    // The over-revocation this replaces killed every session the user had.
    // An attacker with one stolen token must not be able to sign the user out
    // of the device they are not using — that is a denial of service for the
    // price of the theft, and it buys the attacker nothing the family
    // revocation does not already buy.
    const user = await makeUser("replay-isolation");
    const deviceA = await login(user.email);
    const deviceB = await login(user.email);
    assert.notEqual(deviceA.refreshToken, deviceB.refreshToken);

    await refresh(deviceA.cookie);
    await ageConsumption(deviceA.refreshToken, 30);
    await refresh(deviceA.cookie);

    const other = await refresh(deviceB.cookie);
    assert.equal(
      other.statusCode,
      200,
      "a replay in one login must not end another login of the same user"
    );
  });

  it("does not treat a logged-out token as a replay", async () => {
    // A logout marks the token revoked, not consumed. Re-presenting it is a
    // stale tab, and it must not cost the user anything.
    const user = await makeUser("replay-not-logout");
    const session = await login(user.email);

    const loggedOut = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: session.cookie },
    });
    assert.equal(loggedOut.statusCode, 200, loggedOut.body);

    const { types } = await captureEvents(() => refresh(session.cookie));
    assert.equal(
      types.includes("refresh_token_replayed"),
      false,
      "a revoked token is not a replay: nothing was stolen, the user logged out"
    );
  });

  it("does not report an expired token as a replay", async () => {
    const user = await makeUser("replay-not-expired");
    const session = await login(user.email);

    await db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(refreshTokens.tokenHash, sha256(session.refreshToken)));

    const { types } = await captureEvents(() => refresh(session.cookie));
    assert.equal(
      types.includes("refresh_token_replayed"),
      false,
      "an expired token is a client that lost one, not a leak"
    );
  });
});

describe("a client that refreshes twice at once is not an attacker", () => {
  it("lets exactly one of many simultaneous refreshes win, and reports no replay", async () => {
    const user = await makeUser("replay-race");
    const session = await login(user.email);

    // One hundred requests, one token. This is what two tabs, or a retry after
    // a slow response, looks like from the server's side.
    const attempts = await Promise.all(
      Array.from({ length: 100 }, () => refresh(session.cookie))
    );

    const accepted = attempts.filter((r) => r.statusCode === 200);
    const refused = attempts.filter((r) => r.statusCode === 401);
    assert.equal(
      accepted.length,
      1,
      `exactly one refresh may win; ${accepted.length} of ${attempts.length} were told they were right`
    );
    assert.equal(refused.length, attempts.length - 1, "every other refresh must be refused");

    // No family was revoked: the winner's token must still work.
    const winner = sessionCookie(accepted[0]);
    const next = await refresh(winner);
    assert.equal(next.statusCode, 200, "the winning session must still be usable");
  });

  it("reports no replay for the losing requests", async () => {
    const user = await makeUser("replay-race-event");
    const session = await login(user.email);

    const { types } = await captureEvents(async () => {
      await Promise.all(Array.from({ length: 20 }, () => refresh(session.cookie)));
    });

    assert.equal(
      types.includes("refresh_token_replayed"),
      false,
      `a client that refreshes twice is not a breach; saw: ${types.join(", ") || "nothing"}`
    );
  });
});

describe("the OAuth grant path detects a replay too", () => {
  it("refuses a replayed token presented at the token endpoint", async () => {
    // The OAuth grant had no detection of its own: a stolen token replayed
    // through /oauth2/token was refused and nothing else happened, so the
    // token the attacker held stayed alive indefinitely. Detection now happens
    // where the rotation happens, so every path that rotates a token gets it.
    //
    // This needs a real confidential client bound to the session, because the
    // grant authenticates the client before it will rotate anything — and a
    // token minted for an application is bound to that application, so the
    // rotation refuses a client that does not match.
    const orgId = await createOrg();
    const user = await makeUser("replay-oauth");
    await db.insert(orgMemberships).values({ orgId, userId: user.id, role: "owner" });
    const clientSecret = generateClientSecret();
    const [application] = await db
      .insert(applications)
      .values({
        orgId,
        clientId: `client-${crypto.randomBytes(10).toString("hex")}`,
        clientSecretHash: hashClientSecret(clientSecret),
        clientType: "confidential",
        allowedScopes: [],
        name: `Replay App ${RUN_ID.slice(0, 4)}`,
        redirectUris: ["https://client.example.test/callback"],
      })
      .returning();
    createdAppIds.push(application.id);

    // Log in *as the client*, so the refresh token is bound to the application.
    const session = await login(user.email, application.clientId);

    const grant = () =>
      app.inject({
        method: "POST",
        url: "/oauth2/token",
        payload: {
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
          client_id: application.clientId,
          client_secret: clientSecret,
        },
      });

    const first = await grant();
    assert.equal(first.statusCode, 200, `the first grant must succeed: ${first.body}`);

    await ageConsumption(session.refreshToken, 30);

    const { types } = await captureEvents(() => grant());
    // The response stays RFC-shaped (invalid_grant) whatever happened, but the
    // replay is reported.
    assert.ok(
      types.includes("refresh_token_replayed"),
      `the OAuth grant path must detect a replay too; saw: ${types.join(", ") || "nothing"}`
    );
  });
});
