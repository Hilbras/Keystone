import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Organization, User } from "../../../db/schema.js";
import { isRouterMiss } from "../../helpers/routerMiss.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "enterprise-callback-served-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.PUBLIC_URL ||= "https://keystone.example.com";

// See `unauthenticatedSurface.test.ts` for why the budget is forced here rather than
// inherited: `npm test` sets it to a million so nothing else is throttled, which made a
// budget assertion in this repository pass or fail depending on how it was invoked.
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
const { organizations, orgMemberships, users, oidcConnections } = await import("../../../db/schema.js");

/**
 * The redirect_uri an identity provider is told to call must be a route this server serves.
 *
 * ## The defect this pins
 *
 * `oidcEnterpriseRoutes` is mounted at `/sso` (src/index.ts) and its routes also declared
 * their own `/sso`, so the served paths were `/sso/sso/oidc/:connectionId` and
 * `/sso/sso/oidc/:connectionId/callback`. But the `redirect_uri` the start route hands to
 * the IdP — and the identical one the token exchange re-sends, as RFC 6749 §4.1.3 requires
 * — was built from a hardcoded `${publicUrl()}/sso/oidc/${connectionId}/callback`.
 *
 * So Keystone asked the IdP to call back a path it did not serve. A standards-compliant IdP
 * redirects to exactly the `redirect_uri` it was given, so the browser landed on a Fastify
 * route-not-found and enterprise OIDC SSO could not complete. SEC-062 recorded the doubled
 * path as a cosmetic defect; it was an availability defect in a shipped feature, and the
 * reason nobody noticed is that every existing test drives a *piece* — userinfo endpoint
 * resolution, nonce forwarding, membership scoping — and none drives the flow.
 *
 * ## Why the assertion is about the redirect_uri, not about a path
 *
 * Hardcoding `/sso/oidc/...` in this test would pass against the broken code if the author
 * asserted the string rather than the server's behaviour, and would fail for the right fix
 * if the canonical path ever moved. So this captures the `redirect_uri` the code actually
 * emits, then asks the running server what it does with that path.
 */
let app: FastifyInstance;

const orgIds: string[] = [];
const userIds: string[] = [];
const connectionIds: string[] = [];

const CLEAN_START = "/sso/oidc";
const LEGACY_START = "/sso/sso/oidc";

async function seed(): Promise<{ organization: Organization; owner: User; connectionId: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await app.container.userRepository.create({
    email: `sso-${suffix}@example.com`,
    username: `sso-${suffix}`,
    name: `SSO ${suffix}`,
    emailVerified: true,
  });
  userIds.push(owner.id);
  const organization = await app.container.organizationRepository.createWithOwner(
    { name: `SSO ${suffix}`, slug: `sso-${suffix}` },
    owner.id
  );
  orgIds.push(organization.id);
  const connection = await app.container.oidcConnectionRepository.create({
    orgId: organization.id,
    name: `IdP ${suffix}`,
    issuer: "https://idp.example.com",
    authorizationEndpoint: "https://idp.example.com/authorize",
    tokenEndpoint: "https://idp.example.com/token",
    userinfoEndpoint: "https://idp.example.com/userinfo",
    jwksUri: "https://idp.example.com/jwks",
    clientId: `client-${suffix}`,
    clientSecret: "secret",
    scopes: ["openid", "email", "profile"],
    isActive: true,
  });
  connectionIds.push(connection.id);
  return { organization, owner, connectionId: connection.id };
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  // Memberships first, by organization — the previous shape of this cleanup in a sibling
  // suite deleted by a hardcoded nil user id, a row that cannot exist, so it removed
  // nothing and leaned on an unverified cascade.
  if (connectionIds.length) {
    await db.delete(oidcConnections).where(inArray(oidcConnections.id, connectionIds)).catch(() => {});
  }
  if (orgIds.length) {
    await db.delete(orgMemberships).where(inArray(orgMemberships.orgId, orgIds)).catch(() => {});
  }
  if (orgIds.length) {
    await db.delete(organizations).where(inArray(organizations.id, orgIds)).catch(() => {});
  }
  if (userIds.length) {
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {});
  }
  await closeDb().catch(() => {});
});

describe("the enterprise OIDC callback URI is a route this server serves", () => {
  it("serves the path it puts in the redirect_uri it gives the identity provider", async () => {
    const { organization, connectionId } = await seed();

    // The start route, at the path a user would actually be sent to.
    const start = await app.inject({
      method: "GET",
      url: `${CLEAN_START}/${connectionId}?orgId=${organization.id}`,
    });
    assert.equal(
      start.statusCode,
      302,
      `the canonical start route must exist. It answered ${start.statusCode}: ${start.body.slice(0, 200)}`
    );

    const location = new URL(start.headers.location as string);
    const redirectUri = location.searchParams.get("redirect_uri");
    assert.ok(redirectUri, "the authorization request must carry a redirect_uri");

    // Now ask the running server what it does with the path Keystone just told the IdP
    // to call. No state cookie, so the handler will refuse — but it must *reach* the
    // handler, which is the entire difference between a working endpoint and a dead one.
    const callback = new URL(redirectUri);
    const landed = await app.inject({
      method: "GET",
      url: `${callback.pathname}?${callback.searchParams.toString()}`,
    });

    assert.ok(
      !isRouterMiss(landed),
      `the redirect_uri handed to the IdP is ${callback.pathname}, which this server does ` +
        `not serve — the IdP would redirect the browser to a route-not-found and enterprise ` +
        `OIDC SSO could not complete. Response: ${landed.statusCode} ${landed.body.slice(0, 200)}`
    );
    assert.equal(
      landed.statusCode,
      400,
      `a callback with no state cookie must be refused by the handler as invalid state, ` +
        `not by the router. Got ${landed.statusCode} ${landed.body.slice(0, 200)}`
    );
  });

  it("keeps the legacy doubled path working, so a configured IdP does not break", async () => {
    const { organization, connectionId } = await seed();
    const res = await app.inject({
      method: "GET",
      url: `${LEGACY_START}/${connectionId}?orgId=${organization.id}`,
    });
    assert.equal(
      res.statusCode,
      302,
      `the legacy doubled path is what docs/API.md documented and what a configured IdP ` +
        `was told; removing it is a breaking change. It answered ${res.statusCode}: ${res.body.slice(0, 200)}`
    );
  });

  it("charges the legacy path against the same budget as the canonical one", async () => {
    // **The alias must not be a second allowance.** Two paths, one rate-limit keyPrefix,
    // is what a backwards-compatible alias looks like. Two keyPrefixes would hand an
    // attacker double the attempts for one endpoint, and every assertion above would
    // still pass — they check that each path is limited, not that they are limited
    // *together*.
    const { organization, connectionId } = await seed();
    const { redis } = await import("../../../services/redis.js");
    if (redis.status !== "ready") await redis.ping();

    const cleanCallback = `${CLEAN_START}/${connectionId}/callback?orgId=${organization.id}&state=x&code=y`;
    const legacyCallback = `${LEGACY_START}/${connectionId}/callback?orgId=${organization.id}&state=x&code=y`;

    // Spend the whole budget on the canonical path. Every one of these is refused as
    // invalid state, but the limiter runs first — that ordering is the point.
    let limitedAt = -1;
    for (let attempt = 1; attempt <= 8 && limitedAt < 0; attempt++) {
      const res = await app.inject({ method: "GET", url: cleanCallback });
      if (res.statusCode === 429) limitedAt = attempt;
    }
    assert.ok(
      limitedAt > 0,
      `the canonical callback must have a rate limit at all; nothing was refused in 8 attempts`
    );

    const legacy = await app.inject({ method: "GET", url: legacyCallback });
    assert.equal(
      legacy.statusCode,
      429,
      `the budget was exhausted on the canonical path, so the legacy path must already be ` +
        `closed. It answered ${legacy.statusCode} ${legacy.body.slice(0, 200)} — the alias ` +
        `is being charged to a second keyPrefix, which doubles the attempts available on ` +
        `one endpoint.`
    );
  });
});
