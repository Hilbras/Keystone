import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "setup-status-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { buildApp } = await import("../../../index.js");

/**
 * §1.5 — `GET /setup/status` told an unauthenticated caller whether a setup
 * token was configured.
 *
 * The endpoint cannot require a credential: the wizard calls it before any
 * credential exists, which is the point of it. Everything it returns is therefore
 * anonymous-readable, and it used to return two things — `needsSetup` and
 * `setupToken: Boolean(...)`. The second is a one-bit oracle answering "is this
 * instance still unclaimed, and is there a token standing between me and owning
 * it" to anyone who can reach the port.
 *
 * `needsSetup` alone is the whole contract the wizard needs.
 *
 * Asserted against the real application, because the defect was in the response
 * body and a test of the handler in isolation would have to reconstruct the
 * route wiring that is exactly what could regress.
 */
describe("GET /setup/status discloses only `needsSetup` (§1.5)", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("answers with exactly one field", async () => {
    const res = await app.inject({ method: "GET", url: "/setup/status" });

    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    // The strict form, not `assert.ok(!("setupToken" in body))`. A field added
    // later leaks the same way this one did, and a name-based check would let it
    // through; an exact key set makes every addition a deliberate act.
    assert.deepEqual(
      Object.keys(body).sort(),
      ["needsSetup"],
      `the response must carry only needsSetup, got ${JSON.stringify(body)}`
    );
    assert.equal(typeof body.needsSetup, "boolean");
  });

  it("does not report whether a setup token is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/setup/status" });
    assert.doesNotMatch(res.body, /setupToken/i, "the bootstrap-token state must not be disclosed");
  });

  it("is reachable without a credential, which is why the field had to go", async () => {
    // The precondition of the whole finding: anything this endpoint returns is
    // readable by an anonymous caller. If a later change puts it behind a
    // credential, this test fails and the §1.5 reasoning should be revisited.
    const res = await app.inject({ method: "GET", url: "/setup/status" });
    assert.equal(res.statusCode, 200);
  });
});
