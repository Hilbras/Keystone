#!/usr/bin/env node
/**
 * Runtime checks for `@hilbras/keystone-client`.
 *
 * `verify-sdk-packages.mjs` proves the five packages compile and agree on a
 * version. It deliberately does not prove the client *works*: a compiled
 * `.d.ts` and a runtime that retries the wrong method are different claims.
 * §7.5 is a promise about behaviour — safe operations retry, writes do not,
 * `Retry-After` is honoured — and the only way to know it holds is to drive the
 * client against a fetch that fails in the ways the promise is about.
 *
 * No network and no server: the fetch below is a function. Run after
 * `npm run verify:sdk` (which builds every package) so `dist/` exists.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages", "keystone-client", "dist", "index.js");

if (!existsSync(entry)) {
  console.error(
    "packages/keystone-client/dist/index.js is missing. Run " +
      "`npm run build --prefix packages/keystone-client` first."
  );
  process.exit(1);
}

const {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  KeystoneClient,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} = await import(pathToFileURL(entry).href);

const problems = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    problems.push(`${name}: ${error.message}`);
    console.log(`  FAIL  ${name}`);
  }
}

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const client = (fetch, overrides = {}) =>
  new KeystoneClient({
    baseUrl: "https://keystone.test",
    maxRetries: 2,
    backoffBaseMs: 0,
    maxBackoffMs: 0,
    fetch,
    ...overrides,
  });

await check("a GET retries and succeeds", async () => {
  let calls = 0;
  const keystone = client(async () => {
    calls += 1;
    return calls === 1 ? response(503, { error: "Unavailable" }) : response(200, { status: "ok" });
  });
  assert.deepEqual(await keystone.health.live(), { status: "ok" });
  assert.equal(calls, 2);
});

await check("a POST never retries without an explicit opt-in", async () => {
  let calls = 0;
  const keystone = client(async () => {
    calls += 1;
    return response(503, { error: "Unavailable", code: "SERVICE_UNAVAILABLE" });
  });
  await assert.rejects(
    keystone.auth.login({ email: "a@example.com", password: "secret" }),
    ServerError
  );
  assert.equal(calls, 1, "a write was retried");
});

await check("a POST retries when the caller opts in", async () => {
  let calls = 0;
  const keystone = client(async () => {
    calls += 1;
    return calls === 1 ? response(502, { error: "Bad gateway" }) : response(200, { success: true });
  });
  const result = await keystone.request("/auth/logout", { method: "POST", body: {}, retry: true });
  assert.deepEqual(result, { success: true });
  assert.equal(calls, 2);
});

await check("Retry-After is honoured on 429", async () => {
  let calls = 0;
  const started = Date.now();
  const keystone = client(
    async () => {
      calls += 1;
      return response(429, { error: "Slow down" }, { "retry-after": "1" });
    },
    { maxRetries: 1 }
  );
  await assert.rejects(
    keystone.request("/health/live"),
    (error) => error instanceof RateLimitError && error.retryAfterSeconds === 1
  );
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 900, "Retry-After was not waited out");
});

await check("a 401 is AuthenticationError with the server request id", async () => {
  const keystone = client(async () => response(401, { error: "Unauthorized", code: "UNAUTHORIZED", requestId: "req-1" }));
  await assert.rejects(
    keystone.auth.me(),
    (error) =>
      error instanceof AuthenticationError &&
      error.status === 401 &&
      error.code === "UNAUTHORIZED" &&
      error.requestId === "req-1"
  );
});

await check("403, 404, 409 and 422 map to distinct classes", async () => {
  const cases = [
    [403, AuthorizationError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, ValidationError],
  ];
  for (const [status, Expected] of cases) {
    const keystone = client(async () => response(status, { error: `status ${status}` }));
    await assert.rejects(keystone.request("/health/live"), (error) => error instanceof Expected);
  }
});

await check("validation details survive into the error", async () => {
  const details = [{ path: ["email"], message: "Invalid email" }];
  const keystone = client(async () =>
    response(400, { error: "Invalid input", code: "VALIDATION_ERROR", details })
  );
  await assert.rejects(
    keystone.auth.register({ username: "x", email: "nope", password: "secret123" }),
    (error) =>
      error instanceof ValidationError &&
      error.code === "VALIDATION_ERROR" &&
      JSON.stringify(error.details) === JSON.stringify(details)
  );
});

await check("a transport failure is NetworkError and a GET retries it", async () => {
  let calls = 0;
  const keystone = client(async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNRESET");
    return response(200, { status: "ok" });
  });
  assert.deepEqual(await keystone.health.live(), { status: "ok" });
  assert.equal(calls, 2);
});

await check("a transport failure on a write is not retried", async () => {
  let calls = 0;
  const keystone = client(async () => {
    calls += 1;
    throw new Error("ECONNRESET");
  });
  await assert.rejects(keystone.auth.login({ email: "a@example.com", password: "secret" }), NetworkError);
  assert.equal(calls, 1);
});

await check("credentials, idempotency keys and content type reach the wire", async () => {
  let seen;
  const keystone = client(
    async (_url, init) => {
      seen = init;
      return response(200, { success: true });
    },
    { apiKey: "key-123", headers: { "x-custom": "yes" } }
  );
  await keystone.request("/v1/admin/platform/feature-flags/test", {
    method: "PUT",
    body: { enabled: true },
    idempotencyKey: "idem-1",
  });
  assert.equal(seen.headers["x-api-key"], "key-123");
  assert.equal(seen.headers["x-custom"], "yes");
  assert.equal(seen.headers["idempotency-key"], "idem-1");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.equal(seen.body, JSON.stringify({ enabled: true }));
});

await check("an access token replaces the API key and is resolved per request", async () => {
  let token = "first";
  let seen;
  const keystone = client(
    async (_url, init) => {
      seen = init;
      return response(200, { status: "ok" });
    },
    { accessToken: () => token }
  );
  await keystone.health.live();
  assert.equal(seen.headers.authorization, "Bearer first");
  token = "second";
  await keystone.health.live();
  assert.equal(seen.headers.authorization, "Bearer second");

  const withKey = keystone.withApiKey("key-1");
  await withKey.health.live();
  assert.equal(seen.headers["x-api-key"], "key-1");
  assert.equal(seen.headers.authorization, undefined);
});

await check("query parameters are encoded and undefined values omitted", async () => {
  let seenUrl;
  const keystone = client(async (url) => {
    seenUrl = url;
    return response(200, { logs: [] });
  });
  await keystone.admin.auditLogs({ event: "user.login", limit: 10, offset: undefined });
  const url = new URL(seenUrl);
  assert.equal(url.pathname, "/v1/admin/platform/audit-logs");
  assert.equal(url.searchParams.get("event"), "user.login");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.has("offset"), false);
});

await check("path parameters are encoded rather than concatenated", async () => {
  let seenUrl;
  const keystone = client(async (url) => {
    seenUrl = url;
    return response(200, { success: true });
  });
  await keystone.organizations.getUser("org/1", "user?2");
  assert.equal(new URL(seenUrl).pathname, "/v1/admin/organizations/org%2F1/users/user%3F2");
});

await check("the authorize URL carries PKCE and state", async () => {
  const keystone = client(async () => response(200, {}));
  const url = new URL(
    keystone.oauth.authorizeUrl({
      client_id: "app-1",
      redirect_uri: "https://app.example.com/callback",
      code_challenge: "x".repeat(43),
      scope: "openid profile",
      state: "state-1",
    })
  );
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("scope"), "openid profile");
});

await check("a base URL without a scheme is refused at construction", async () => {
  assert.throws(() => new KeystoneClient({ baseUrl: "keystone.test" }), TypeError);
});

if (problems.length > 0) {
  console.error("\nThe Keystone client does not honour its contract:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\nKeystone client OK: errors, retries, credentials and URL handling verified.");
process.exit(0);
