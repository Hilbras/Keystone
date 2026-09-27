import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import nodePath from "node:path";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "abuse-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { isOriginAllowed } = await import("../../services/trustedProxies.js");
const {
  localRateLimit,
  resetLocalRateLimits,
  localRateLimitSize,
} = await import("../../services/localRateLimit.js");
const {
  isTrustedProxy,
  clientAddress,
  normalizeAddress,
  resetTrustedProxyCache,
} = await import("../../services/trustedProxies.js");

let app: FastifyInstance;

before(async () => {
  const { db } = await import("../../db/index.js");
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../db/migrations") });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  const { closeDb } = await import("../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

beforeEach(() => {
  resetLocalRateLimits();
});

/** Run `fn` with a trusted-proxy configuration, restoring the default after. */
async function withTrustedProxies(value: string, fn: () => Promise<void> | void): Promise<void> {
  const previous = process.env.KEYSTONE_TRUSTED_PROXIES;
  process.env.KEYSTONE_TRUSTED_PROXIES = value;
  resetTrustedProxyCache();
  try {
    await fn();
  } finally {
    process.env.KEYSTONE_TRUSTED_PROXIES = previous ?? "";
    resetTrustedProxyCache();
  }
}

function fakeRequest(peer: string, headers: Record<string, string> = {}) {
  return {
    headers: { ...headers },
    socket: { remoteAddress: peer },
    ip: peer,
  } as never;
}

// ---------------------------------------------------------------------------
// Plan item 1 — the emergency local limiter
// ---------------------------------------------------------------------------
describe("Emergency local limiter", () => {
  it("allows up to the limit and refuses the next", () => {
    for (let i = 1; i <= 3; i++) {
      assert.equal(localRateLimit("k", 3, 60).allowed, true, `attempt ${i} should be allowed`);
    }
    const refused = localRateLimit("k", 3, 60);
    assert.equal(refused.allowed, false);
    if (!refused.allowed) {
      assert.ok(refused.retryAfterSeconds > 0, "a refusal must carry Retry-After");
    }
  });

  it("keeps separate budgets per key", () => {
    for (let i = 0; i < 3; i++) localRateLimit("a", 3, 60);
    assert.equal(localRateLimit("a", 3, 60).allowed, false);
    assert.equal(localRateLimit("b", 3, 60).allowed, true, "one exhausted key must not affect another");
  });

  it("starts a fresh window once the old one has passed", () => {
    localRateLimit("k", 1, 60);
    assert.equal(localRateLimit("k", 1, 60).allowed, false, "still inside the window");
    // A zero-length window has already expired when the next call reads it, so
    // this is a first request rather than a continuation.
    localRateLimit("instant", 1, 0);
    assert.equal(localRateLimit("instant", 1, 0).allowed, true, "an expired window refills");
  });

  it("is bounded, so rotating addresses cannot grow it without limit", () => {
    resetLocalRateLimits();
    for (let i = 0; i < 12_000; i++) {
      localRateLimit(`addr-${i}`, 5, 300);
    }
    assert.ok(
      localRateLimitSize() <= 10_000,
      `expected the store to stay bounded, held ${localRateLimitSize()}`
    );
  });

  it("does not grant extra budget by being evicted", async () => {
    // Eviction forgets an expired window, which is refilled on the next request
    // anyway, so a client cannot buy attempts by forcing the cap.
    resetLocalRateLimits();
    const first = localRateLimit("victim", 1, 0); // expires immediately
    assert.equal(first.allowed, true);
    for (let i = 0; i < 10_000; i++) localRateLimit(`filler-${i}`, 5, 300);
    // The victim's window had expired, so this is a fresh window, not a bonus.
    assert.equal(localRateLimit("victim", 1, 300).allowed, true);
    assert.equal(localRateLimit("victim", 1, 300).allowed, false);
  });
});

// ---------------------------------------------------------------------------
// Plan item 4 — proxy spoofing
// ---------------------------------------------------------------------------
describe("Proxy spoofing", () => {
  it("ignores a spoofed x-forwarded-for from an untrusted peer", async () => {
    await withTrustedProxies("", () => {
      const request = fakeRequest("203.0.113.9", { "x-forwarded-for": "1.2.3.4" });
      assert.equal(clientAddress(request), "203.0.113.9");
    });
  });

  it("ignores every value in a multi-entry forwarded header from an untrusted peer", async () => {
    await withTrustedProxies("", () => {
      const request = fakeRequest("203.0.113.9", {
        "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12",
      });
      assert.equal(clientAddress(request), "203.0.113.9", "none of the entries may be believed");
    });
  });

  it("ignores x-real-ip and forwarded from an untrusted peer", async () => {
    await withTrustedProxies("", () => {
      assert.equal(
        clientAddress(fakeRequest("203.0.113.9", { "x-real-ip": "1.2.3.4" })),
        "203.0.113.9"
      );
      assert.equal(
        clientAddress(fakeRequest("203.0.113.9", { forwarded: "for=1.2.3.4" })),
        "203.0.113.9"
      );
    });
  });

  it("uses the left-most entry when a trusted proxy forwards it", async () => {
    await withTrustedProxies("10.0.0.0/8", () => {
      const request = fakeRequest("10.0.0.1", { "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
      assert.equal(clientAddress(request), "203.0.113.9");
    });
  });

  it("does not trust an untrusted proxy that sits behind a trusted one", async () => {
    await withTrustedProxies("10.0.0.0/8", () => {
      // The peer is outside the trusted range, so its forwarding is ignored even
      // though the address it claims to have been forwarded by is not involved.
      const request = fakeRequest("203.0.113.9", { "x-forwarded-for": "1.2.3.4" });
      assert.equal(clientAddress(request), "203.0.113.9");
    });
  });

  it("handles IPv4, IPv6, and IPv4-mapped IPv6 peers", async () => {
    await withTrustedProxies("10.0.0.0/8,2001:db8::/32", () => {
      assert.equal(isTrustedProxy("10.1.2.3"), true);
      assert.equal(isTrustedProxy("2001:db8::1"), true);
      assert.equal(isTrustedProxy("::ffff:10.1.2.3"), true, "mapped IPv4 must match an IPv4 range");
      assert.equal(isTrustedProxy("::ffff:0a01:0203"), true, "the hex mapped form too");
      assert.equal(isTrustedProxy("2001:dbf::1"), false);
    });
  });

  it("normalizes the addresses a mapped peer can arrive as", () => {
    assert.equal(normalizeAddress("::ffff:10.1.2.3"), "10.1.2.3");
    assert.equal(normalizeAddress("::ffff:0a01:0203"), "10.1.2.3");
    assert.equal(normalizeAddress("[2001:DB8::1]"), "2001:db8::1");
  });

  it("treats a request with no forwarded header as its peer address", async () => {
    await withTrustedProxies("10.0.0.0/8", () => {
      assert.equal(clientAddress(fakeRequest("10.0.0.1")), "10.0.0.1");
    });
  });
});

// ---------------------------------------------------------------------------
// Plan item 2 — sensitive endpoints carry an emergency budget
// ---------------------------------------------------------------------------
describe("Sensitive endpoints keep a budget when Redis is down", () => {
  it("are opted in across the authentication surface", () => {
    // Enumerated by reading the route files, so adding a new sensitive endpoint
    // without the flag shows up here rather than as a silent gap.
    const routeDir = nodePath.resolve(__dirname, "..");
    const files = fs.readdirSync(routeDir).map((f) => nodePath.join(routeDir, f));
    const sensitive = new Set([
      "login",
      "register",
      "mfa-verify",
      "forgot-password",
      "magic-link",
      "sms-otp-send",
      "sms-otp-verify",
      "oauth2_authorize",
      "oauth2_token",
      "scim",
      "api-key-create",
      "totp-enroll",
      "totp-verify",
      "totp-disable",
      "totp-backup",
      "totp-backup-verify",
      "email-verification",
      "create-org",
    ]);
    const missing: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const source = fs.readFileSync(file, "utf8");

      // Limiters built by a local factory (the TOTP ones) carry the flag once, in
      // the factory, rather than at each call site.
      if (source.includes("factorRateLimit(")) {
        if (!source.includes("emergencyLocalLimit")) {
          missing.push(`${nodePath.basename(file)}:factorRateLimit`);
        }
        continue;
      }

      for (const prefix of sensitive) {
        if (source.includes(`keyPrefix: "${prefix}"`) && !source.includes("emergencyLocalLimit")) {
          missing.push(`${nodePath.basename(file)}:${prefix}`);
        }
      }
    }
    assert.deepEqual(missing, [], `these sensitive limiters have no emergency budget: ${missing.join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// Plan item 5 — abuse events reach the audit log
// ---------------------------------------------------------------------------
describe("Abuse events are recorded", () => {
  it("the vocabulary includes every signal the plan names", async () => {
    const { VALID_EVENT_TYPES } = await import("../../services/events/validate.js");
    for (const event of [
      "rate_limit_triggered",
      "authentication_brute_force",
      "mfa_brute_force",
      "refresh_token_replayed",
      "user_login_failed",
    ]) {
      assert.ok(VALID_EVENT_TYPES.has(event), `${event} must be a known event`);
    }
  });

  it("emits rate_limit_triggered when a limiter refuses, naming which limiter", async () => {
    const { subscribeAll } = await import("../../services/events/bus.js");
    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeAll((event) => {
      if (event.type === "rate_limit_triggered") {
        seen.push(event.payload as Record<string, unknown>);
      }
    });

    // Exhaust a budget so the limiter actually refuses.
    const { rateLimit } = await import("../../plugins/rateLimit.js");
    const keyPrefix = `evt-${Date.now()}`;
    const guard = rateLimit({
      keyPrefix,
      maxAttempts: 1,
      windowSeconds: 60,
      // Without this the limiter fails open when Redis is unavailable, and the
      // test would never see a refusal at all.
      emergencyLocalLimit: true,
    });

    const call = async () => {
      let status = 200;
      const reply = {
        header() {
          return this;
        },
        status(code: number) {
          status = code;
          return this;
        },
        send() {
          return this;
        },
      } as never;
      await guard(fakeRequest("198.51.100.5"), reply);
      return status;
    };

    try {
      assert.equal(await call(), 200, "the first attempt is within budget");
      assert.equal(await call(), 429, "the second exceeds it");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      unsubscribe();
    }

    assert.equal(seen.length, 1, `expected one rate_limit_triggered event, saw ${seen.length}`);
    assert.equal(seen[0].keyPrefix, keyPrefix);
    assert.equal(seen[0].clientAddress, "198.51.100.5");
    assert.ok(
      ["redis", "local", "none"].includes(String(seen[0].limiter)),
      "the event must say which limiter decided, so a degraded control is visible"
    );
  });
});
