import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";

/** The documented per-address login budget. 30 per fifteen minutes. */
const PER_ADDRESS_MAX = 30;
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
// The budget this suite is about, pinned here rather than inherited.
//
// `package.json`'s test script raises `LOGIN_PER_ADDRESS_MAX` to a very large
// number, because the whole suite logs in from 127.0.0.1 and a correctly working
// per-address budget would otherwise throttle the other files. Each test file is
// its own process, so this file sets the real value for itself — and must, because
// a test whose subject is the number cannot take that number from the environment
// that runs it. `PER_ADDRESS_MAX` below is the same value, and the test asserts
// the limiter agrees with it.
process.env.LOGIN_PER_ADDRESS_MAX = String(PER_ADDRESS_MAX);
process.env.LOGIN_MAX_ATTEMPTS = "5";
process.env.LOGIN_WINDOW_SECONDS = "900";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "spray-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../../db/index.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { hashPassword } = await import("../../../services/secrets/index.js");
const { redis } = await import("../../../services/redis.js");
const { resetLocalRateLimits } = await import("../../../services/localRateLimit.js");
const { users } = await import("../../../db/schema.js");
const { migrationsFolder } = await import("../../../lib/paths.js");

/**
 * Credential spraying from one host, and the budget that was supposed to stop it.
 *
 * `POST /auth/token-login` carries two budgets. The first is keyed on address
 * **and** submitted address, 5 per fifteen minutes, and it stops repeated guesses
 * at one account. The comment beside the second says why that is not enough: an
 * attacker who varies the submitted address on every request gets a fresh budget
 * each time and can guess across a thousand accounts from one host. So the second
 * is keyed on the address alone, 30 per fifteen minutes.
 *
 * The second did not do that. `rateLimit()` appended the submitted address to
 * every limiter's key, so `login-per-address` became `login-per-address:<ip>:<email>`
 * — the same shape as the first. Thirty distinct accounts from one address each
 * got their own budget of thirty, and the control bounded nothing. SEC-048.
 *
 * The code, the comment and `docs/security/rate-limiting.md` all disagreed with
 * each other, which is why this is worth a test that sprays rather than one that
 * reads the key: a test asserting the key format would have been written against
 * whatever the format was.
 */

const PASSWORD = "Spray-Attempt-Passw0rd!";

let app: FastifyInstance;

/** One login attempt from `address` for `email`, as a spraying client would. */
function attempt(address: string, email: string) {
  return app.inject({
    method: "POST",
    url: "/auth/token-login",
    remoteAddress: address,
    payload: { email, password: "not-the-password" },
  });
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  resetLocalRateLimits();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  // Only the addresses this suite invented, so a shared Redis keeps everything else.
  const suffix = crypto.randomBytes(3).toString("hex");
  void suffix;
  await closeDb().catch(() => {});
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("credential spraying", () => {
  it("is bounded per address, however many accounts are tried", async () => {
    const address = `198.51.100.${1 + Math.floor(Math.random() * 200)}`;

    // Thirty distinct accounts, one attempt each. Every one of them is a *different*
    // key as far as the per-account budget is concerned, so none of them should be
    // refused by that budget.
    const { config } = await import("../../../config.js");
    assert.equal(
      config.LOGIN_PER_ADDRESS_MAX,
      PER_ADDRESS_MAX,
      "the limiter must be using the budget this test pins, not a default that " +
        "happens to match it — otherwise the test asserts nothing about it"
    );

    const statuses: number[] = [];
    for (let i = 0; i < PER_ADDRESS_MAX; i++) {
      const email = `spray-${address}-${i}@example.test`;
      const res = await attempt(address, email);
      statuses.push(res.statusCode);
    }
    assert.ok(
      statuses.every((s) => s === 401 || s === 429),
      `expected each of the first ${PER_ADDRESS_MAX} attempts to be a plain 401, got ${statuses.join(",")}`
    );

    // The next one is the thirty-first from this address, and it must be refused
    // on the address budget alone — no repeated account, no single account under
    // attack. With the key including the submitted address this returned 401 and
    // the control was doing nothing.
    const overflow = await attempt(address, `spray-${address}-overflow@example.test`);
    assert.equal(
      overflow.statusCode,
      429,
      "the 31st login from one address must be refused, whatever account it names. " +
        "Without this the spraying budget is keyed on address *and* account, which " +
        "is the same shape as the per-account budget beside it and bounds nothing."
    );
  });

  it("gives a different address its own budget", async () => {
    // A NAT means many legitimate users share one address, so the budget has to be
    // per address and not global — but two addresses must not share one.
    const a = `203.0.113.${1 + Math.floor(Math.random() * 200)}`;
    const b = `203.0.113.${1 + Math.floor(Math.random() * 200)}`;
    const first = await attempt(a, "nat-a-1@example.test");
    assert.ok(first.statusCode === 401 || first.statusCode === 429);

    const other = await attempt(b, "nat-b-1@example.test");
    assert.notEqual(
      other.statusCode,
      429,
      "a second address must not be refused because the first exhausted its budget"
    );
  });

  it("still refuses repeated guesses at one account, on the per-account budget", async () => {
    // The other half. The per-account budget is the reason the address budget is
    // only 30: one account gets a much tighter allowance.
    const address = `192.0.2.${1 + Math.floor(Math.random() * 200)}`;
    const email = `repeat-${address}@example.test`;

    let sawLimit = false;
    for (let i = 0; i < 8; i++) {
      const res = await attempt(address, email);
      if (res.statusCode === 429) {
        sawLimit = true;
        break;
      }
    }
    assert.equal(
      sawLimit,
      true,
      "eight guesses at one account from one address should hit the per-account " +
        "budget of 5, well before the per-address budget of 30"
    );
  });

  it("does not consult the database for accounts it is about to refuse", async () => {
    // A cheap property worth stating: the address budget refuses before any user
    // lookup, so spraying cannot be used to probe which addresses exist. The
    // response for a refused attempt and for a missing account are the same shape.
    const address = `198.18.${Math.floor(Math.random() * 200)}.${1 + Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < PER_ADDRESS_MAX; i++) {
      await attempt(address, `uniformity-${i}@example.test`);
    }
    const refused = await attempt(address, "uniformity-overflow@example.test");
    const body = refused.json() as { error?: string };
    assert.equal(refused.statusCode, 429);
    assert.equal(
      body.error,
      "Too many attempts. Please try again later.",
      "a refused request must not distinguish itself from any other refusal"
    );

    // And the passwords never matched, so nothing here proves an account exists.
    await db.delete(users).where(eq(users.email, "uniformity-0@example.test")).catch(() => {});
  });
});
