import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fastify, { type FastifyInstance } from "fastify";
import errorContract from "../plugins/errorContract.js";

/**
 * The JSON error contract, exercised through a real server.
 *
 * §7.2. The contract is `{ error, code, requestId }`, and the hook that supplies
 * the missing parts is the only thing making it true for handlers that were never
 * updated. These tests pin the three behaviours that matter: what is filled in,
 * what is left alone, and which envelopes are protocol rather than Keystone.
 */
let app: FastifyInstance;

before(async () => {
  app = fastify({ genReqId: () => "req-fixed" });
  await app.register(errorContract);

  app.get("/plain", async () => ({ ok: true }));
  app.get("/missing-both", async (_request, reply) => reply.status(403).send({ error: "Forbidden" }));
  app.get("/validation", async (_request, reply) =>
    reply.status(400).send({ error: "Invalid input", details: [{ path: ["email"], message: "bad" }] })
  );
  app.get("/existing-code", async (_request, reply) =>
    reply.status(404).send({ error: "User not found", code: "USER_NOT_FOUND" })
  );
  app.get("/oauth", async (_request, reply) =>
    reply.status(400).send({ error: "invalid_grant", error_description: "code expired" })
  );
  app.get("/scim", async (_request, reply) =>
    reply.status(400).send({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "400", detail: "bad" })
  );
  app.get("/authz", async (_request, reply) => reply.status(200).send({ allowed: false, reason: "no" }));
  app.get("/text", async (_request, reply) => reply.type("text/plain").status(500).send("boom"));
  app.get("/gateway", async (_request, reply) => reply.status(503).send({ error: "upstream died" }));

  await app.ready();
});

after(async () => {
  await app?.close();
});

async function get(url: string) {
  const response = await app.inject({ method: "GET", url });
  return { response, body: response.json() };
}

describe("the JSON error contract", () => {
  it("adds the requestId and a status-derived code", async () => {
    const { response, body } = await get("/missing-both");
    assert.equal(response.statusCode, 403);
    assert.equal(body.error, "Forbidden");
    assert.equal(body.code, "FORBIDDEN");
    assert.equal(body.requestId, "req-fixed");
    assert.equal(response.headers["request-id"], undefined, "the header belongs to requestLogger");
  });

  it("classifies a 400 with details as VALIDATION_ERROR", async () => {
    const { body } = await get("/validation");
    assert.equal(body.code, "VALIDATION_ERROR");
    assert.deepEqual(body.details, [{ path: ["email"], message: "bad" }]);
    assert.equal(body.requestId, "req-fixed");
  });

  it("does not overwrite a handler's own code", async () => {
    const { body } = await get("/existing-code");
    assert.equal(body.code, "USER_NOT_FOUND");
    assert.equal(body.requestId, "req-fixed");
  });

  it("leaves OAuth error parameters alone but adds the requestId", async () => {
    const { body } = await get("/oauth");
    assert.equal(body.error, "invalid_grant");
    assert.equal(body.error_description, "code expired");
    assert.equal("code" in body, false, "an RFC 6749 body must not gain a Keystone code");
    assert.equal(body.requestId, "req-fixed");
  });

  it("does not touch a SCIM error envelope", async () => {
    const { body } = await get("/scim");
    assert.deepEqual(Object.keys(body).sort(), ["detail", "schemas", "status"]);
  });

  it("does not touch an authorization decision", async () => {
    const { response, body } = await get("/authz");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body, { allowed: false, reason: "no" });
  });

  it("does not touch a non-JSON error body", async () => {
    const response = await app.inject({ method: "GET", url: "/text" });
    assert.equal(response.body, "boom");
  });

  it("derives a 5xx code from the status", async () => {
    const { response, body } = await get("/gateway");
    assert.equal(response.statusCode, 503);
    assert.equal(body.code, "SERVICE_UNAVAILABLE");
    assert.equal(body.requestId, "req-fixed");
  });
});
