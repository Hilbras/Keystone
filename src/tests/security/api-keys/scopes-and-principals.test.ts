import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "m2m-scope-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { hashPassword } = await import("../../../services/secrets/index.js");
const { apiKeys, serviceAccounts, users, organizations, orgMemberships } = await import(
  "../../../db/schema.js"
);
const {
  API_KEY_SCOPES,
  hasScopes,
  isApiKeyScope,
  validateScopes,
  intersectScopes,
  knownScopes,
  describeScope,
  PERSONAL_KEY_DEFAULT_SCOPES,
  SERVICE_ACCOUNT_DEFAULT_SCOPES,
  HUMAN_ONLY_SCOPES,
} = await import("../../../services/scopes.js");

const RUN_ID = crypto.randomBytes(6).toString("hex");
const DOMAIN = `m2m-${RUN_ID}.example.test`;
const PASSWORD = "Machine-Scope-Passw0rd!";
const createdUserIds: string[] = [];
const createdKeyIds: string[] = [];

let app: FastifyInstance;
let userRepository: { create: Function; findById: Function };

before(async () => {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../db/migrations") });
  await loadSigningKeys();
  app = await buildApp();
  userRepository = app.container.userRepository as never;
});

after(async () => {
  for (const id of createdKeyIds) await db.delete(apiKeys).where(eq(apiKeys.id, id)).catch(() => {});
  for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id)).catch(() => {});
  await app?.close();
  const { closeDb } = await import("../../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

async function createUser() {
  const handle = crypto.randomBytes(8).toString("hex");
  const user = await userRepository.create({
    email: `m2m-${handle}@${DOMAIN}`,
    username: `m2m-${handle}`,
    name: `M2M ${handle.slice(0, 6)}`,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
  });
  createdUserIds.push(user.id);
  return user;
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers["set-cookie"];
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  return list.map((c) => String(c).split(";")[0]).filter((c) => c.includes("=")).join("; ");
}

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `login failed: ${res.statusCode} ${res.body.slice(0, 160)}`);
  return sessionCookie(res);
}

/**
 * Insert a key directly, so a test can grant scopes the API would refuse.
 *
 * `keyHash` must be the hash of the plaintext that will be presented, because
 * that is what the auth path recomputes and looks up.
 */
async function seedKey(userId: string, scopes: string[]) {
  const { hashApiKey } = await import("../../../services/tokens.js");
  const plaintext = `sk_test_${crypto.randomBytes(32).toString("base64url")}`;
  const [record] = await db
    .insert(apiKeys)
    .values({
      userId,
      keyHash: hashApiKey(plaintext),
      name: `seeded-${scopes.join("_").slice(0, 20)}`,
      prefix: "sk_test",
      scopes,
    })
    .returning();
  createdKeyIds.push(record.id);
  return { record, plaintext };
}

// ---------------------------------------------------------------------------
// Plan item 2 — the registry
// ---------------------------------------------------------------------------
describe("API key scope registry", () => {
  it("recognises only its own names", () => {
    for (const scope of knownScopes()) {
      assert.equal(isApiKeyScope(scope), true, scope);
      assert.ok(describeScope(scope), `${scope} must have a description`);
    }
    for (const bogus of ["service_account", "api:read", "api:write", "*", "", "ADMIN"]) {
      assert.equal(isApiKeyScope(bogus), false, `${bogus} must not be a scope`);
    }
  });

  it("documents every scope it defines", () => {
    for (const [name, description] of Object.entries(API_KEY_SCOPES)) {
      assert.ok(description.length > 0, `${name} needs a description`);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan item 3 — scope intersection
// ---------------------------------------------------------------------------
describe("Scope validation", () => {
  it("accepts known scopes and normalises order", () => {
    const result = validateScopes(["sessions:revoke", "profile:read"], { principal: "user" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.scopes, ["profile:read", "sessions:revoke"]);
  });

  it("refuses an unknown scope rather than dropping it", () => {
    const result = validateScopes(["profile:read", "api:read"], { principal: "user" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.unknown, ["api:read"]);
  });

  it("refuses the historical wildcard string", () => {
    // This is the string `requireScopes` used to honour as "all scopes", and it
    // was client-suppliable at key creation.
    const result = validateScopes(["service_account"], { principal: "user" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.unknown, ["service_account"]);
  });

  it("refuses an interactive scope for a service account", () => {
    const result = validateScopes(["mfa:manage"], { principal: "service_account" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.forbiddenForServiceAccount, ["mfa:manage"]);
  });

  it("allows an interactive scope for a person", () => {
    const result = validateScopes(["mfa:manage"], { principal: "user" });
    assert.equal(result.ok, true);
  });

  it("applies a read-only default to a personal key", () => {
    const result = validateScopes(undefined, { principal: "user" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.scopes, PERSONAL_KEY_DEFAULT_SCOPES);
    assert.ok(
      !result.scopes.includes("api_keys:revoke") && !result.scopes.includes("organizations:write"),
      "the default must not include a destructive scope"
    );
  });

  it("applies a minimal default to a service account", () => {
    const result = validateScopes(undefined, { principal: "service_account" });
    assert.deepEqual(result.scopes, SERVICE_ACCOUNT_DEFAULT_SCOPES);
    for (const forbidden of HUMAN_ONLY_SCOPES) {
      assert.ok(!result.scopes.includes(forbidden), `a service account must not default to ${forbidden}`);
    }
  });
});

describe("Scope intersection narrows to the principal's authority", () => {
  it("keeps only scopes both sides hold", () => {
    const result = intersectScopes(["profile:read", "organizations:write"], ["profile:read", "sessions:read"]);
    assert.deepEqual(result, ["profile:read"]);
  });

  it("yields nothing when the principal has no authority", () => {
    assert.deepEqual(intersectScopes(["profile:read", "organizations:write"], []), []);
  });

  it("ignores a stored scope that is not in the registry", () => {
    const result = intersectScopes(["profile:read", "legacy:bogus"], ["profile:read", "legacy:bogus"]);
    assert.deepEqual(result, ["profile:read"]);
  });
});

// ---------------------------------------------------------------------------
// The two defects in the old guard
// ---------------------------------------------------------------------------
describe("Scope enforcement", () => {
  it("does not honour the service_account wildcard", () => {
    // The old guard was `scopes.includes(scope) || scopes.includes("service_account")`,
    // so a key holding only that string satisfied every requirement.
    assert.equal(hasScopes(["service_account"], ["organizations:write"]), false);
    assert.equal(hasScopes(["service_account"], ["api_keys:revoke"]), false);
    assert.equal(hasScopes(["service_account"], ["profile:read"]), false);
  });

  it("requires every named scope, not just one", () => {
    assert.equal(hasScopes(["profile:read"], ["profile:read", "sessions:read"]), false);
    assert.equal(hasScopes(["profile:read", "sessions:read"], ["profile:read", "sessions:read"]), true);
  });

  it("treats an empty requirement as satisfied and an absent grant as not", () => {
    assert.equal(hasScopes([], []), true);
    assert.equal(hasScopes(null, ["profile:read"]), false);
    assert.equal(hasScopes(undefined, ["profile:read"]), false);
  });
});

// ---------------------------------------------------------------------------
// End to end: a key's scopes are actually enforced on a guarded route
// ---------------------------------------------------------------------------
/**
 * Enforcement, over HTTP.
 *
 * Worth being precise about reachability: `app.authenticate` is JWT-only, so
 * almost every route refuses an API key with a 401 before a scope is ever
 * examined. `GET /auth/validate` is the one route wired to
 * `authenticateOrApiKey`, so it is where scope enforcement is observable end to
 * end. The registry and guard matter for every route that adopts key
 * authentication from here on.
 */
describe("Key scopes are enforced where a key can reach", () => {
  it("allows a key holding the required scope", async () => {
    const user = await createUser();
    const { plaintext } = await seedKey(user.id, ["profile:read"]);

    const res = await app.inject({
      method: "GET",
      url: "/auth/validate",
      headers: { authorization: `Bearer ${plaintext}` },
    });
    assert.equal(res.statusCode, 200, `expected success, got ${res.statusCode} ${res.body.slice(0, 160)}`);
    assert.equal(res.json().valid, true);
  });

  it("refuses a key without the required scope", async () => {
    const user = await createUser();
    // Holds a real, registered scope -- just not the one this route needs.
    const { plaintext } = await seedKey(user.id, ["sessions:read"]);

    const res = await app.inject({
      method: "GET",
      url: "/auth/validate",
      headers: { authorization: `Bearer ${plaintext}` },
    });
    assert.equal(res.statusCode, 403, `expected a scope refusal, got ${res.statusCode}`);
    assert.match(res.json().error ?? "", /scope/i);
  });

  it("refuses a key holding only the historical wildcard string", async () => {
    const user = await createUser();
    // Stored directly, because the API now refuses to create such a key. Under
    // the old guard this satisfied every scope requirement.
    const { plaintext } = await seedKey(user.id, ["service_account"]);

    const res = await app.inject({
      method: "GET",
      url: "/auth/validate",
      headers: { authorization: `Bearer ${plaintext}` },
    });
    assert.equal(res.statusCode, 403, "the wildcard string must not grant scope");
  });

  it("refuses a key with an empty scope set", async () => {
    const user = await createUser();
    const { plaintext } = await seedKey(user.id, []);

    const res = await app.inject({
      method: "GET",
      url: "/auth/validate",
      headers: { authorization: `Bearer ${plaintext}` },
    });
    assert.equal(res.statusCode, 403, "a key with no scopes must not pass a scope check");
  });

  it("does not apply scope checks to a session", async () => {
    // A session carries a person's authority and is governed by the permission
    // system, so the guard must not fire for it.
    const user = await createUser();
    const cookie = await login(user.email);
    const res = await app.inject({ method: "GET", url: "/auth/validate", headers: { cookie } });
    assert.equal(res.statusCode, 200, `a session must not be scope-checked, got ${res.statusCode}`);
  });
});

describe("Key creation refuses unknown scopes over HTTP", () => {
  it("rejects the wildcard string a caller used to be able to store", async () => {
    const user = await createUser();
    const cookie = await login(user.email);

    const res = await app.inject({
      method: "POST",
      url: "/auth/api-keys",
      headers: { cookie },
      payload: { name: "wildcard attempt", scopes: ["service_account"] },
    });
    assert.equal(res.statusCode, 400, `expected a 400, got ${res.statusCode}`);
    const body = res.json();
    assert.deepEqual(body.unknown, ["service_account"]);
    assert.ok(Array.isArray(body.known) && body.known.length > 0, "the error should list what is allowed");
  });

  it("accepts a known scope", async () => {
    const user = await createUser();
    const cookie = await login(user.email);

    const res = await app.inject({
      method: "POST",
      url: "/auth/api-keys",
      headers: { cookie },
      payload: { name: "legitimate", scopes: ["profile:read", "sessions:read"] },
    });
    assert.equal(res.statusCode, 200, `expected success, got ${res.statusCode} ${res.body.slice(0, 160)}`);
    const created = res.json().apiKey;
    createdKeyIds.push(created.id);
    assert.deepEqual(created.scopes, ["profile:read", "sessions:read"]);
  });
});

// ---------------------------------------------------------------------------
// Plan item 5 — the machine-principal boundary
// ---------------------------------------------------------------------------
/**
 * The machine-principal boundary.
 *
 * Stated plainly: this is a backstop, not a fix for a live hole. The routes it
 * guards use `app.authenticate`, which is JWT-only, so a service-account key is
 * refused with a 401 before the guard is reached. The guard matters for the day a
 * route is switched to `authenticateOrApiKey` -- it is the default that stops a
 * machine credential from silently becoming acceptable on a route that assumed a
 * person was present.
 *
 * So it is tested by invoking the guard with a machine principal present, which is
 * exactly the state a future wiring change would produce.
 */
describe("Machine-principal boundary", () => {
  async function invokeGuard(serviceAccount: unknown) {
    const { default: plugin } = await import("../../../plugins/machinePrincipal.js");
    const decorated: Record<string, () => unknown> = {};
    // Exercise the real guard without booting a second application.
    const instance = {
      decorate: (name: string, fn: unknown) => {
        decorated[name] = fn as () => unknown;
      },
    };
    await (plugin as (i: unknown) => Promise<void>)(instance);

    const preHandler = decorated.requireHumanPrincipal() as (
      r: unknown,
      rep: unknown
    ) => Promise<unknown>;

    let status = 200;
    const audits: unknown[] = [];
    const request = {
      serviceAccount,
      method: "POST",
      url: "/auth/totp/enroll",
      log: {},
      audit: async (_action: string, payload: unknown) => {
        audits.push(payload);
      },
    };
    const reply = {
      status(code: number) {
        status = code;
        return this;
      },
      send() {
        return this;
      },
    };
    await preHandler(request, reply);
    return { status, audits };
  }

  it("refuses a service account with a reason and an audit record", async () => {
    const result = await invokeGuard({ id: "sa-1", orgId: "org-1" });
    assert.equal(result.status, 403);
    assert.equal(result.audits.length, 1, "the refusal must be auditable");
    assert.equal(
      (result.audits[0] as { action: string }).action,
      "machine_principal_on_interactive_route"
    );
  });

  it("lets a user session through untouched", async () => {
    const result = await invokeGuard(undefined);
    assert.equal(result.status, 200, "a human principal must not be refused");
    assert.equal(result.audits.length, 0, "no audit noise for ordinary traffic");
  });

  it("a default-scoped service account key cannot read a profile", async () => {
    // Confirms the scope boundary applies to machine credentials too, rather
    // than the synthetic principal simply being waved through.
    const handle = crypto.randomBytes(8).toString("hex");
    const { hashApiKey } = await import("../../../services/tokens.js");
    const [org] = await db
      .insert(organizations)
      .values({ name: `SA Org ${handle.slice(0, 4)}`, slug: `sa-${handle}` })
      .returning();
    const [account] = await db
      .insert(serviceAccounts)
      .values({ orgId: org.id, name: `sa-${handle.slice(0, 6)}`, isActive: true })
      .returning();
    const plaintext = `sk_sa_${crypto.randomBytes(24).toString("base64url")}`;
    const [key] = await db
      .insert(apiKeys)
      .values({
        serviceAccountId: account.id,
        orgId: org.id,
        keyHash: hashApiKey(plaintext),
        name: "sa-key",
        prefix: "sk_sa",
        scopes: SERVICE_ACCOUNT_DEFAULT_SCOPES,
      })
      .returning();
    createdKeyIds.push(key.id);

    const res = await app.inject({
      method: "GET",
      url: "/auth/validate",
      headers: { authorization: `Bearer ${plaintext}` },
    });
    assert.equal(res.statusCode, 403, "a default-scoped service account must not read a profile");
  });
});

void users;
void orgMemberships;
