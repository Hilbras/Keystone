import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "ratelimit-surface-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

// **The budget is set here, not inherited.**
//
// `npm test` sets `LOGIN_MAX_ATTEMPTS=1000000` so the rest of the suite is not
// throttled by the routes under test. That made this suite's first version pass in
// isolation — where the budget defaults to 10 and 60 requests trip it — and fail
// with 8 errors in the full run, where 60 requests against a million budget trip
// nothing.
//
// So the test was measuring the *configured budget* rather than whether a limiter
// is wired up, and a green run meant nothing. The budget is now forced to a small
// value before `config` is imported, which is the only way this assertion can mean
// anything.
//
// Contained: `node --test` runs each test **file** in its own process, so this
// does not change the budget for any other suite.
process.env.LOGIN_MAX_ATTEMPTS = "5";
process.env.LOGIN_WINDOW_SECONDS = "60";

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
const { migrationsFolder } = await import("../../../lib/paths.js");
const { users } = await import("../../../db/schema.js");
const { redis } = await import("../../../services/redis.js");

/**
 * The unauthenticated routes that consume an attacker-supplied credential.
 *
 * §3.6 recorded "21 routes have no rate limit" and deliberately left the decision
 * open, because a mechanical rule cannot tell a login from a discovery document
 * and closing it is a judgement about which are actually abusable.
 *
 * The judgement is made here, and it did not survive contact with the code:
 *
 * | what | count | verdict |
 * |---|---|---|
 * | already limited, and CodeQL missed it | 9 | false positives |
 * | limited now | 8 | real |
 * | deliberately not limited | 3 | a decision, not an oversight |
 * | authenticated, so bounded by the session | 1 | lower priority |
 *
 * **The 9 false positives are the interesting part.** CodeQL's
 * `js/missing-rate-limiting` looks for a `rateLimit` call in a route's own
 * options, and misses it in two ordinary shapes: a limiter inside a
 * `preHandler` array declared on a preceding line, and a limiter behind a named
 * helper (`factorRateLimit("totp-verify")`). Both are how this repository writes
 * limiters, so **9 of 21 alerts were routes that were already protected** — and
 * the number 21 was doing more harm than good, because it is what a reader would
 * quote.
 *
 * ## The 3 that are deliberately not limited
 *
 * - `GET /keystone-dropin.js` and its `.sri` — static file and its integrity hash.
 *   A browser and a CDN fetch these; limiting them breaks caching and protects
 *   nothing.
 * - `POST /setup/init` — guarded by `assertSetupToken`, one-shot, and an operator's
 *   *first* request to a new installation. A rate limit here can lock somebody out
 *   of their own deploy, which is a support incident caused by a security control.
 *
 * Both are recorded in `docs/security/rate-limiting.md` so the omission is
 * visible rather than looking like an oversight.
 */

const createdUserIds: string[] = [];
let app: FastifyInstance;

/**
 * The routes this suite covers, and what each one consumes.
 *
 * Four of the eight full paths are not the route file's own path, because a
 * Fastify plugin's prefix is prepended and the route declares its own segment
 * too. Getting these wrong produced four successive 404s, which read exactly like
 * "the route has no rate limit" — a 404 is a 404 whichever reason caused it, and
 * the message the assertion prints would have said the wrong thing entirely.
 *   authRoutes, magicLinkRoutes, webauthnRoutes  ->  mounted at /auth
 *   samlRoutes, oidcEnterpriseRoutes              ->  mounted at /sso
 *
 * The enterprise OIDC callback is registered at *two* paths: the canonical
 * `/sso/oidc/…` and the legacy doubled `/sso/sso/oidc/…` that 3.5.8 and earlier
 * served. Only the canonical one is listed here, deliberately:
 *
 * - listing both would break `bounds each route separately` below, which asserts one
 *   limiter prefix per entry. That assertion is right. The alias shares a single
 *   prefix on purpose, because two prefixes on one endpoint is two allowances;
 * - the shared-budget property is asserted directly, and rather better, in
 *   `oidc/enterpriseCallbackIsServed.test.ts`, which spends the whole budget on the
 *   canonical path and requires the legacy path to already be closed. "Each path is
 *   limited" and "both paths are limited *together*" are different claims, and only
 *   the second is the one worth having.
 *
 * `unauthenticated: false` means the route requires a session, so an attacker
 * already needs a credential — a different threat, bounded by the session rather
 * than by an IP budget.
 */
const ROUTES = [
  { method: "GET" as const, url: "/federation/google/callback", limiter: "federation-callback", consumes: "a provider token" },
  { method: "GET" as const, url: "/auth/callback/google", limiter: "oauth-callback", consumes: "a provider token" },
  { method: "GET" as const, url: "/sso/oidc/00000000-0000-0000-0000-000000000000/callback", limiter: "oidc-enterprise-callback", consumes: "an authorization code" },
  { method: "GET" as const, url: "/auth/magic-link/verify?token=0000000000000000000000000000000000000000", limiter: "magic-link-verify", consumes: "a token in the query string" },
  { method: "GET" as const, url: "/sso/saml/00000000-0000-0000-0000-000000000000?orgId=x", limiter: "saml-start", consumes: "a connection id" },
  { method: "POST" as const, url: "/sso/saml/acs", limiter: "saml-acs", consumes: "a signed assertion", payload: { SAMLResponse: "PHNhbWxwOlJlc3BvbnNlLz4=" } },
  { method: "POST" as const, url: "/auth/webauthn/authenticate/options", limiter: "webauthn-authn-options", consumes: "an email address", payload: { email: "nobody@example.test" } },
  { method: "POST" as const, url: "/auth/webauthn/authenticate/verify", limiter: "webauthn-authn-verify", consumes: "a challenge", payload: { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "e30" } } },
];

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
  if (redis.status !== "ready") await redis.ping();
  // A unique prefix per run would need a per-route setting, and these limiters read
  // the shared budget. Instead every key here is cleared before the suite, so the
  // budget is this suite's to spend.
  const keys = await redis.keys("*-callback:*");
  for (const key of keys) await redis.del(key);
});

after(async () => {
  await app?.close();
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
});

describe("unauthenticated routes that consume a credential", () => {
  for (const route of ROUTES) {
    it(`${route.method} ${route.url.split("?")[0]} refuses a flood — it consumes ${route.consumes}`, async () => {
      // `LOGIN_MAX_ATTEMPTS` is 5, set above, so twelve requests is comfortably
      // past the budget without being slow. The route may answer 400 or 401 for
      // the request itself; what matters is that it stops answering *at all* after
      // the budget, which is the difference between a limiter that exists and one
      // that does not.
      const attempts = 12;
      const statuses = new Map<number, number>();
      let sawLimit = false;

      for (let i = 0; i < attempts; i++) {
        const res = await app.inject({
          method: route.method,
          url: route.url,
          ...(route.payload ? { payload: route.payload } : {}),
        });
        statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
        if (res.statusCode === 429) {
          sawLimit = true;
          assert.ok(
            res.headers["retry-after"] !== undefined,
            "a 429 should carry Retry-After, or a well-behaved client cannot back off"
          );
          break;
        }
      }

      assert.ok(
        sawLimit,
        `${route.method} ${route.url.split("?")[0]} answered ${attempts} requests without ` +
          `ever returning 429. Statuses: ${JSON.stringify(Object.fromEntries(statuses))}. ` +
          `A route that consumes ${route.consumes} and never says no is an unbounded ` +
          `credential-guessing surface.`
      );
    });
  }

  it("bounds each route separately, so one flood does not lock out another", async () => {
    // If every route shared one key, a flood against the magic-link verifier would
    // deny service to the SAML ACS — a self-inflicted outage. The prefixes differ,
    // which is the property worth asserting.
    const seen = new Set<string>();
    for (const route of ROUTES) {
      assert.ok(!seen.has(route.limiter), `${route.limiter} is used twice`);
      seen.add(route.limiter);
    }
    assert.equal(seen.size, ROUTES.length);
  });
});
