import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "chaos-concurrency";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// A hundred simultaneous requests against one budget would be refused by the
// limiter before the limiter's subject is reached, and a 429 is not a race.
process.env.LOGIN_MAX_ATTEMPTS ||= "1000000";
process.env.LOGIN_PER_ADDRESS_MAX ||= "1000000";
process.env.LOGIN_WINDOW_SECONDS ||= "60";
process.env.REFRESH_RATE_MAX ||= "1000000";
process.env.REFRESH_RATE_WINDOW ||= "60";
process.env.GLOBAL_RATE_LIMIT_MAX ||= "1000000";
process.env.GLOBAL_RATE_LIMIT_WINDOW ||= "60";
process.env.SCIM_RATE_LIMIT_MAX ||= "1000000";
process.env.SCIM_RATE_LIMIT_WINDOW_SECONDS ||= "60";
// The private-address policy refuses a loopback target unless it is
// explicitly allowed, and the insecure-transport exception is scoped to
// localhost. Both are read when the configuration is first loaded, so they
// have to be set here rather than in the setup hook.
process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "true";
process.env.KEYSTONE_ALLOW_INSECURE_WEBHOOK = "localhost";
/**
 * The setup route refuses to run without a setup token, and compares against
 * this value. Assigned, not defaulted: the file must not depend on whatever
 * token the surrounding environment happens to carry.
 */
process.env.KEYSTONE_SETUP_TOKEN = "chaos-concurrency-setup-token-0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { hashPassword, hashClientSecret, generateClientSecret } = await import(
  "../../services/secrets/index.js"
);
const { users, refreshTokens, organizations, applications, orgMemberships, webhookEndpoints, webhookDeliveries } =
  await import("../../db/schema.js");
const { refreshCookieName } = await import("../../plugins/auth.js");
const { migrationsFolder } = await import("../../lib/paths.js");

/**
 * §8.6 — one hundred of everything, at once.
 *
 * Every claim Keystone makes about "one" is a claim about concurrency: one
 * platform owner, one authorization code redeemed, one refresh token rotated,
 * one webhook delivered. A property that holds when requests arrive one at a
 * time proves nothing, because the interesting arrival is the simultaneous
 * one.
 *
 * The number is a hundred rather than twenty because the failure mode is not
 * proportional. Twenty simultaneous requests can interleave such that the
 * twenty-first would not have overlapped the first; a hundred cannot be
 * scheduled by luck. And the assertions are about ownership, not about
 * latency: exactly one winner, no duplicate delivery, no corrupted state.
 *
 * The expectations are the same shape every time:
 *
 * - **no duplicate ownership** — one winner, and the state says so;
 * - **no replay** — a lost race is a refusal, not a security event;
 * - **no duplicate delivery** — the target sees the event once;
 * - **no corrupted state** — what is left behind is coherent.
 */

const CONCURRENCY = 100;
const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Chaos-Concurrency-Passw0rd!";
const REDIRECT = "https://client.example.test/callback";

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];
const createdAppIds: string[] = [];
const createdEndpointIds: string[] = [];

let app: FastifyInstance;

async function createOrg(): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({
      name: `Concurrency Org ${RUN_ID.slice(0, 4)}`,
      slug: `conc-${RUN_ID}-${crypto.randomBytes(3).toString("hex")}`,
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

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers["set-cookie"];
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  return list
    .map((cookie) => String(cookie).split(";")[0])
    .filter((cookie) => cookie.includes("="))
    .join("; ");
}

function refreshTokenFrom(cookie: string): string {
  const name = refreshCookieName();
  for (const part of cookie.split("; ")) {
    if (part.startsWith(`${name}=`)) {
      return decodeURIComponent(part.slice(name.length + 1));
    }
  }
  assert.fail(`no ${name} cookie in: ${cookie}`);
}

async function login(email: string): Promise<{ cookie: string; refreshToken: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = sessionCookie(res);
  return { cookie, refreshToken: refreshTokenFrom(cookie) };
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
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, id)).catch(() => {});
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("a hundred simultaneous refreshes (§8.6)", () => {
  it("rotates exactly once and leaves the session usable", async () => {
    const user = await makeUser("conc-refresh");
    const session = await login(user.email);

    const attempts = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        app.inject({
          method: "POST",
          url: "/auth/refresh",
          headers: { cookie: session.cookie },
        })
      )
    );

    const winners = attempts.filter((r) => r.statusCode === 200);
    assert.equal(
      winners.length,
      1,
      `exactly one refresh may win; ${winners.length} of ${CONCURRENCY} were told they were right`
    );

    const loserStatuses = new Set(
      attempts.filter((r) => r.statusCode !== 200).map((r) => r.statusCode)
    );
    for (const status of loserStatuses) {
      assert.ok(
        status === 401 || status === 429,
        `a lost race must be a refusal, not a server error; saw ${status}`
      );
    }

    // The winner's token must still work: a race must not cost the client its
    // session.
    const winnerCookie = sessionCookie(winners[0]);
    const next = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: winnerCookie },
    });
    assert.equal(next.statusCode, 200, "the winning session must still be usable");
  });
});

describe("a hundred simultaneous redemptions of one authorization code (§8.6)", () => {
  it("issues tokens exactly once", async () => {
    const { storeAuthorizationCode, grantConsent } = await import("../../services/oauth2.js");
    const orgId = await createOrg();
    const user = await makeUser("conc-oauth");
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
        name: `Concurrency App ${RUN_ID.slice(0, 4)}`,
        redirectUris: [REDIRECT],
      })
      .returning();
    createdAppIds.push(application.id);

    // The grant needs the user's consent before a code may be redeemed, and
    // the redemption is refused without it — a refusal that has nothing to do
    // with the race being tested.
    await grantConsent(user.id, application.id, []);

    const { code } = await storeAuthorizationCode({
      appId: application.id,
      userId: user.id,
      redirectUri: REDIRECT,
      scopes: [],
    });

    const attempts = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        app.inject({
          method: "POST",
          url: "/oauth2/token",
          payload: {
            grant_type: "authorization_code",
            code,
            client_id: application.clientId,
            client_secret: clientSecret,
            redirect_uri: REDIRECT,
            code_verifier: "concurrency-verifier-that-is-not-checked-here",
          },
        })
      )
    );

    const issued = attempts.filter((r) => r.statusCode === 200 && r.json().access_token);
    assert.equal(
      issued.length,
      1,
      `an authorization code is single-use; ${issued.length} of ${CONCURRENCY} were issued tokens`
    );

    // The code is spent: the row records one use, and no second token exists.
    const consumed = await db
      .select({ usedAt: refreshTokens.consumedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, user.id));
    assert.ok(
      consumed.length <= 1,
      `one redemption may mint one token; ${consumed.length} were minted`
    );
  });
});

describe("a hundred simultaneous deliveries of one webhook (§8.6)", () => {
  it("delivers to the target exactly once", async () => {
    // A real HTTP collector, so "delivered once" is observed by the receiver
    // rather than inferred from the delivery table.
    const arrivals: string[] = [];
    const collector = http.createServer((req, res) => {
      arrivals.push(req.headers["x-keystone-delivery"] as string);
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const port = (collector.address() as AddressInfo).port;

    try {
      const { encryptSecret } = await import("../../services/totp.js");
      const orgId = await createOrg();
      const user = await makeUser("conc-webhook");
      await db.insert(orgMemberships).values({ orgId, userId: user.id, role: "owner" });
      const [application] = await db
        .insert(applications)
        .values({
          orgId,
          clientId: `client-${crypto.randomBytes(10).toString("hex")}`,
          clientSecretHash: null,
          clientType: "public",
          allowedScopes: [],
          name: `Webhook App ${RUN_ID.slice(0, 4)}`,
          redirectUris: [REDIRECT],
        })
        .returning();
      createdAppIds.push(application.id);

      // The endpoint and the delivery are written directly, the way the other
      // webhook suites write them: what is under test here is the claim, not
      // the URL policy or the endpoint's event filter.
      const [endpoint] = await db
        .insert(webhookEndpoints)
        .values({
          appId: application.id,
          url: `http://127.0.0.1:${port}/hook`,
          events: ["user.login"],
          isActive: true,
          secret: encryptSecret(`whsec_${crypto.randomBytes(24).toString("base64url")}`),
        })
        .returning();
      createdEndpointIds.push(endpoint.id);

      const [delivery] = await db
        .insert(webhookDeliveries)
        .values({
          endpointId: endpoint.id,
          eventType: "user.login",
          payload: { type: "user.login" },
        })
        .returning();

      const { deliverNow } = await import("../../services/webhooks.js");
      await Promise.all(
        Array.from({ length: CONCURRENCY }, () => deliverNow(delivery.id))
      );

      assert.equal(
        arrivals.length,
        1,
        `the target must receive the event exactly once; it received ${arrivals.length}`
      );

      const row = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, delivery.id));
      assert.equal(row[0].status, "success", "the delivery must be recorded as delivered");
    } finally {
      collector.close();
      for (const id of createdEndpointIds) {
        await db.delete(webhookDeliveries).where(eq(webhookDeliveries.endpointId, id)).catch(() => {});
        await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).catch(() => {});
      }
    }
  });
});

describe("a hundred simultaneous setup attempts (§8.6)", () => {
  it("creates exactly one platform owner", async () => {
    const SETUP_TOKEN = "chaos-concurrency-setup-token-0123456789abcdef";
    const previousOwners = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "owner"));
    const previouslyOwnerIds = previousOwners.map((owner) => owner.id);

    // The route only runs while no active owner exists.
    await db.update(users).set({ role: "user" }).where(eq(users.role, "owner"));
    const email = `chaos-setup-${crypto.randomUUID().slice(0, 8)}@example.test`;

    try {
      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          app.inject({
            method: "POST",
            url: "/setup/init",
            headers: { "x-setup-token": SETUP_TOKEN },
            payload: { email, password: "Chaos-Setup-Passw0rd!" },
          })
        )
      );

      const winners = responses.filter((r) => r.statusCode === 200);
      assert.equal(
        winners.length,
        1,
        `exactly one caller may bootstrap; ${winners.length} of ${CONCURRENCY} were told they had`
      );

      const owners = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "owner"), eq(users.isActive, true)));
      assert.equal(owners.length, 1, "the platform must end up with exactly one active owner");

      const created = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      assert.equal(created.length, 1, "the winner must have created exactly one user for that address");
    } finally {
      // Hand the platform back to whoever had it.
      await db.update(users).set({ role: "user" }).where(eq(users.role, "owner"));
      for (const id of previouslyOwnerIds) {
        await db.update(users).set({ role: "owner" }).where(eq(users.id, id));
      }
    }
  });
});

describe("a hundred simultaneous queue jobs (§8.6)", () => {
  it("runs every job exactly once", async () => {
    const { queue } = await import("../../services/queue/index.js");
    const runs: number[] = [];

    queue.process("chaos-concurrency", async (job) => {
      runs.push(job.payload as number);
    });

    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, index) =>
        queue.enqueue({ type: "chaos-concurrency", payload: index })
      )
    );

    // The in-process driver dispatches on `setImmediate`, so the work is queued
    // rather than done when `enqueue` resolves.
    const deadline = Date.now() + 20_000;
    while (runs.length < CONCURRENCY && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(runs.length, CONCURRENCY, `every job must run; ${runs.length} of ${CONCURRENCY} ran`);
    assert.equal(
      new Set(runs).size,
      CONCURRENCY,
      "no job may run twice — a duplicated job is a duplicated side effect"
    );
  });
});
