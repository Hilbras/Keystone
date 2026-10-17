import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "ip-allowlist-test-key";
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
const { applications, auditLog, refreshTokens, userSessions, users } = await import("../../../db/schema.js");
const { hashPassword } = await import("../../../services/secrets/index.js");
const { migrationsFolder } = await import("../../helpers/paths.js");
const { initializeContainer } = await import("../../../di.js");
const { getContainer } = await import("../../../container.js");
const { createApplication } = await import("../../../services/applications.js");

/**
 * Per-application IP lists were enforced only when the caller volunteered
 * `client_id` in the login/register body. Omitting that one optional field
 * walked straight past `allowedIps`/`blockedIps`, so a deployment using them
 * as a network control was unprotected the moment the attacker chose not to
 * identify themselves.
 *
 * The fix makes the account itself answer for its memberships: every
 * application the user's organizations reach that carries a list gets to
 * speak for a bare login. Routing checks the submitted `client_id` as before.
 */
const RUN_ID = crypto.randomBytes(6).toString("hex");
const DOMAIN = `ip-allowlist-${RUN_ID}.example.test`;
const PASSWORD = "correct horse battery staple";
const ALLOWED_IP = "198.51.100.7";
const OFF_IP = "203.0.113.9";

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdAppIds: string[] = [];
let app: FastifyInstance;

before(async () => {
  await (await import("drizzle-orm/postgres-js/migrator")).migrate(db, {
    migrationsFolder: migrationsFolder(),
  });
  await loadSigningKeys();
  initializeContainer();
  app = await buildApp();
  await app.ready();
});

// The full shutdown lives in one `after` hook at the bottom of the file, after
// the fixture rows are deleted: closing the database first would leave this
// cleanup running with no connection.

async function createUser() {
  const handle = crypto.randomBytes(8).toString("hex");
  const [user] = await db
    .insert(users)
    .values({
      email: `u-${handle}@${DOMAIN}`,
      username: `u-${handle}`,
      name: `IpList ${handle.slice(0, 6)}`,
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
      isActive: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

/** An org (owner = user) with one application, restricted however the caller asks. */
async function createRestrictedOrg(
  userId: string,
  label: string,
  lists: { allowedIps?: string[]; blockedIps?: string[] }
) {
  const org = await getContainer().organizationRepository.createWithOwner(
    { name: `${label}-${RUN_ID}`, slug: `${label}-${RUN_ID}` },
    userId
  );
  createdOrgIds.push(org.id);
  const application = await createApplication({ orgId: org.id, name: `${label}-app-${RUN_ID}` });
  createdAppIds.push(application.id);
  if (lists.allowedIps?.length || lists.blockedIps?.length) {
    await db
      .update(applications)
      .set({
        ...(lists.allowedIps ? { allowedIps: lists.allowedIps } : {}),
        ...(lists.blockedIps ? { blockedIps: lists.blockedIps } : {}),
      })
      .where(eq(applications.id, application.id));
  }
  return { org, application };
}

function login(email: string, remoteAddress: string, clientId?: string) {
  return app.inject({
    method: "POST",
    url: "/auth/login",
    remoteAddress,
    payload: { email, password: PASSWORD, ...(clientId ? { client_id: clientId } : {}) },
  });
}

describe("per-application IP lists survive an omitted client_id", () => {
  it("refuses a bare login (no client_id) from outside the allowlist", async () => {
    const user = await createUser();
    await createRestrictedOrg(user.id, "allow", { allowedIps: [ALLOWED_IP] });

    const res = await login(user.email, OFF_IP);
    assert.equal(res.statusCode, 403, `off-IP bare login must be refused: ${res.body}`);
    const body = res.json() as { code?: string };
    assert.equal(body.code, "IP_NOT_ALLOWED", "the refusal names the IP control, not a generic error");
  });

  it("permits the bare login from an allowed address", async () => {
    const user = await createUser();
    await createRestrictedOrg(user.id, "allow-ok", { allowedIps: [ALLOWED_IP] });

    const res = await login(user.email, ALLOWED_IP);
    assert.equal(res.statusCode, 200, `the allowlisted address must get in: ${res.body}`);
  });

  it("applies blocklists the same way, client_id or not", async () => {
    const user = await createUser();
    await createRestrictedOrg(user.id, "block", { blockedIps: [`${OFF_IP}/32`] });

    for (const clientId of [undefined, "app_someclientid"]) {
      const res = await login(user.email, OFF_IP, clientId);
      assert.ok(
        res.statusCode === 403,
        `a blocked address must be refused with${clientId ? "" : "out"} client_id (got ${res.statusCode})`
      );
    }
  });

  it("sets the correct route-level guard too: client_id from an off-list address", async () => {
    const user = await createUser();
    const { application } = await createRestrictedOrg(user.id, "route-guard", { allowedIps: [ALLOWED_IP] });

    const res = await login(user.email, OFF_IP, application.clientId);
    assert.equal(res.statusCode, 403, `route-level client_id check must still refuse: ${res.body}`);
    assert.equal((res.json() as { code?: string }).code, "IP_NOT_ALLOWED");
  });

  it("leaves accounts with no restricted applications alone", async () => {
    const user = await createUser();
    await getContainer().organizationRepository.createWithOwner(
      { name: `free-${RUN_ID}`, slug: `free-${RUN_ID}` },
      user.id
    );

    const res = await login(user.email, OFF_IP);
    assert.equal(res.statusCode, 200, `unrestricted accounts must not be collateral: ${res.body}`);
  });
});

// One shutdown, after the fixture rows are gone: closing the database first
// would leave the cleanup below running with no connection to clean against.
after(async () => {
  await app?.close();
  for (const id of createdAppIds) {
    await db.delete(applications).where(eq(applications.id, id)).catch(() => {});
  }
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