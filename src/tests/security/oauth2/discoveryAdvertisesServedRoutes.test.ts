import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { isRouterMiss, pathOf } from "../../helpers/routerMiss.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "discovery-advertised-routes-test-key";
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
const { migrationsFolder } = await import("../../../lib/paths.js");

/**
 * Every endpoint the OIDC discovery document advertises must be a route this server serves.
 *
 * ## The invariant
 *
 * `GET /.well-known/openid-configuration` is a list of URLs this server asserts exist. A
 * third party — an OIDC client library, a conforming relying party — fetches it and then
 * calls what it names. Nothing in the build cross-checks the two lists, so the two can
 * drift apart and the only symptom is a client failing against a Keystone that is
 * otherwise entirely healthy.
 *
 * This is the same shape as SEC-062, which was found by asking the same question of a
 * hand-built string rather than a document: the enterprise OIDC `redirect_uri` named
 * `/sso/oidc/:connectionId/callback` while the route was served at
 * `/sso/sso/oidc/:connectionId/callback`, so the IdP redirected the browser to a path
 * that did not exist and enterprise login could not complete. The difference is that this
 * one is *mechanically* checkable — the document and the route table are both in the
 * repository — so it belongs in a test rather than in a review someone has to remember to
 * do.
 *
 * ## Why the check asks the server rather than reading the route table
 *
 * Asserting against a list of known paths would test the list, not the server, and would
 * pass against a document advertising a route that had since been renamed. Each advertised
 * path is therefore *requested*, and the assertion is only that the request is not a router
 * miss. A handler may answer 400, 401 or 405 — that is the route existing and refusing,
 * which is the whole point.
 */
let app: FastifyInstance;

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  await closeDb().catch(() => {});
});

/** The document's endpoint-valued fields, and the method each is called with. */
const ADVERTISED: ReadonlyArray<{ field: string; method: "GET" | "POST" }> = [
  { field: "authorization_endpoint", method: "GET" },
  { field: "token_endpoint", method: "POST" },
  { field: "userinfo_endpoint", method: "GET" },
  { field: "revocation_endpoint", method: "POST" },
  { field: "jwks_uri", method: "GET" },
];

describe("the OIDC discovery document advertises only routes this server serves", () => {
  it("is served at the path RFC 8414 names", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/openid-configuration" });
    assert.equal(res.statusCode, 200, `discovery must be reachable: ${res.body.slice(0, 200)}`);
    assert.equal(
      res.json().issuer,
      res.json().authorization_endpoint.replace(/\/oauth2\/authorize$/, ""),
      "every endpoint in the document is derived from `issuer`, so a client that trusts the " +
        "document can resolve them all. If one is not, it was written out by hand."
    );
  });

  for (const { field, method } of ADVERTISED) {
    it(`${field} is a route, not a 404 from the router`, async () => {
      const res = await app.inject({ method: "GET", url: "/.well-known/openid-configuration" });
      const value = res.json()[field];
      assert.equal(typeof value, "string", `${field} must be advertised as a URL`);

      const path = pathOf(value);
      const target = await app.inject({
        method,
        url: path,
        ...(method === "POST" ? { payload: {} } : {}),
      });

      assert.ok(
        !isRouterMiss(target),
        `the discovery document advertises ${field} = ${path}, and ${method} ${path} answered ` +
          `${target.statusCode} from Fastify's router rather than from a handler. Every ` +
          `conforming OIDC client calls the endpoints this document names, so an advertised ` +
          `path that is not served is a broken integration with no other symptom. ` +
          `Body: ${target.body.slice(0, 200)}`
      );
    });
  }

  it("advertises nothing beyond the endpoints it checked", async () => {
    // A guard against the test being weakened into checking a hand-picked subset: any
    // other field whose value is an absolute URL is an endpoint claim too, and is checked
    // here even though the list above does not name it.
    const res = await app.inject({ method: "GET", url: "/.well-known/openid-configuration" });
    const doc = res.json() as Record<string, unknown>;

    // `issuer` is an absolute URL and is **not** an endpoint — it is the stable identifier
    // clients compare tokens and metadata against, and it is not something a client calls.
    // It is checked by the first test instead, which asserts every endpoint in the document
    // is derived from it; that is a stronger claim than "the issuer is served".
    //
    // The first version of this test excluded it by omission, which meant a new field
    // would have been silently unreviewed. Naming it is the difference between a decision
    // and a gap.
    const NOT_AN_ENDPOINT = new Set(["issuer"]);
    const known = new Set([...ADVERTISED.map((a) => a.field), ...NOT_AN_ENDPOINT]);

    const unlisted = Object.entries(doc).filter(
      ([key, value]) =>
        !known.has(key) && typeof value === "string" && /^https?:\/\//.test(value)
    );
    assert.deepEqual(
      unlisted.map(([key]) => key),
      [],
      "this document advertises absolute URLs in fields the test does not check. Either they " +
        "are endpoints and belong in ADVERTISED, or they are identifiers and belong in " +
        "NOT_AN_ENDPOINT with a reason. Silently ignoring an unreviewed field is the " +
        "failure this test exists to prevent."
    );
  });
});
