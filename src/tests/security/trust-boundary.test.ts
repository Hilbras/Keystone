import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "proxy-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

// Default posture: nothing is a trusted proxy. Individual tests set the
// variable and reset the module-level cache around themselves.
process.env.KEYSTONE_TRUSTED_PROXIES = "";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { organizations, serviceAccounts } = await import("../../db/schema.js");
const {
  addressInCidr,
  canonicalFingerprint,
  clientAddress,
  fastifyTrustProxySetting,
  isTrustedProxy,
  isValidFingerprint,
  hasTrustedProxies,
  isInfrastructureAddress,
  describeUntrustedPeer,
  normalizeAddress,
  peerAddress,
  resetTrustedProxyCache,
  stripUntrustedHeaders,
} = await import("../../services/trustedProxies.js");
const {
  setServiceAccountCertificate,
  revokeServiceAccount,
  findServiceAccountById,
} = await import("../../services/serviceAccounts.js");

let app: FastifyInstance;

/**
 * The test database is persistent and `cert_fingerprint` is unique, so every
 * value this file writes is derived from a per-process nonce and removed during
 * teardown. Without that, a second run collides with the first run's rows.
 */
const RUN_ID = crypto.randomBytes(6).toString("hex");
const NAME_PREFIX = `tb-${RUN_ID}-`;
let fingerprintSeq = 0;

/** A well-formed, never-reused SHA-256 fingerprint. */
function nextFingerprint(): string {
  fingerprintSeq += 1;
  return crypto.createHash("sha256").update(`${RUN_ID}-${fingerprintSeq}`).digest("hex");
}

const FINGERPRINT = "a".repeat(64);
const COLON_FINGERPRINT = Array.from({ length: 32 }, () => "ab").join(":");

/** Run `fn` with a trusted-proxy configuration, restoring the default after. */
async function withTrustedProxies(value: string, fn: () => Promise<void>): Promise<void> {
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

/** Values the header-probe route observed during a request. */
const observedHeaders: Record<string, unknown> = {};
const HEADER_PROBE_PATH = "/__probe/headers";
const LIMIT_PROBE_PATH = "/__probe/limited";
const RATE_LIMIT_MAX = 3;

let orgId: string;

before(async () => {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../db/migrations") });
  await loadSigningKeys();
  app = await buildApp();
  await app.container.permissionRepository.ensureRolePermissionsSeeded();

  // Probe routes must be registered before the first ready(): Fastify rejects
  // routes added to an already-booted instance.
  const { rateLimit } = await import("../../plugins/rateLimit.js");
  app.get(HEADER_PROBE_PATH, async (request) => {
    observedHeaders.fingerprint = request.headers["x-client-cert-fingerprint"];
    observedHeaders.serviceAccount = request.headers["x-service-account-id"];
    observedHeaders.forwardedFor = request.headers["x-forwarded-for"];
    return { ok: true };
  });
  app.get(
    LIMIT_PROBE_PATH,
    {
      preHandler: rateLimit({
        keyPrefix: `tb-${RUN_ID}-limited`,
        maxAttempts: RATE_LIMIT_MAX,
        windowSeconds: 60,
      }),
    },
    async () => ({ ok: true })
  );
  await app.ready();

  // The shared client is created with `lazyConnect`, and the limiter fails open
  // whenever it is not connected. Connect explicitly, or these assertions would
  // pass against a permanently open budget and prove nothing.
  const { redis, isRedisReady } = await import("../../services/redis.js");
  if (redis.status === "wait") await redis.connect();
  for (let attempt = 0; attempt < 50 && !isRedisReady(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(isRedisReady(), "Redis must be connected for rate-limit assertions to mean anything");
  await redis.ping();

  const [org] = await db.select({ id: organizations.id }).from(organizations).limit(1);
  assert.ok(org, "expected at least one organization in the test database");
  orgId = org.id;
});

after(async () => {
  // Remove only this run's rows, so repeated runs stay independent.
  await db
    .delete(serviceAccounts)
    .where(like(serviceAccounts.name, `${NAME_PREFIX}%`))
    .catch(() => {});

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

describe("Address normalization", () => {
  it("treats IPv4-mapped IPv6 as the IPv4 address", () => {
    assert.equal(normalizeAddress("::ffff:127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeAddress("::ffff:7F00:1"), "127.0.0.1");
  });

  it("strips brackets, zones, and case", () => {
    assert.equal(normalizeAddress("[2001:DB8::1]"), "2001:db8::1");
    assert.equal(normalizeAddress("fe80::1%eth0"), "fe80::1");
  });

  it("handles missing input", () => {
    assert.equal(normalizeAddress(undefined), "");
    assert.equal(normalizeAddress("   "), "");
  });
});

describe("CIDR matching", () => {
  it("matches IPv4 ranges", () => {
    assert.equal(addressInCidr("10.0.0.5", "10.0.0.0/8"), true);
    assert.equal(addressInCidr("10.1.2.3", "10.0.0.0/8"), true);
    assert.equal(addressInCidr("11.0.0.1", "10.0.0.0/8"), false);
    assert.equal(addressInCidr("192.168.1.130", "192.168.1.128/25"), true);
    assert.equal(addressInCidr("192.168.1.127", "192.168.1.128/25"), false);
  });

  it("handles non-byte-aligned prefixes", () => {
    assert.equal(addressInCidr("10.1.2.3", "10.0.0.0/12"), true);
    assert.equal(addressInCidr("11.0.0.1", "10.0.0.0/12"), false);
  });

  it("matches exact addresses and IPv6 prefixes", () => {
    assert.equal(addressInCidr("127.0.0.1", "127.0.0.1"), true);
    assert.equal(addressInCidr("127.0.0.2", "127.0.0.1"), false);
    assert.equal(addressInCidr("2001:db8::1", "2001:db8::/32"), true);
    assert.equal(addressInCidr("2001:dbf::1", "2001:db8::/32"), false);
  });

  it("fails closed on garbage", () => {
    assert.equal(addressInCidr("not-an-ip", "10.0.0.0/8"), false);
    assert.equal(addressInCidr("10.0.0.1", "not-a-cidr"), false);
    assert.equal(addressInCidr("10.0.0.1", "10.0.0.0/99"), false);
    assert.equal(addressInCidr("", "10.0.0.0/8"), false);
  });
});

describe("Trusted proxy configuration", () => {
  it("trusts nothing by default", async () => {
    await withTrustedProxies("", async () => {
      assert.equal(isTrustedProxy("127.0.0.1"), false);
      assert.equal(
        fastifyTrustProxySetting(),
        false,
        "Fastify must not trust x-forwarded-for by default"
      );
    });
  });

  it("honours an explicit list", async () => {
    await withTrustedProxies("10.0.0.0/8, 192.168.1.1", async () => {
      assert.equal(isTrustedProxy("10.5.5.5"), true);
      assert.equal(isTrustedProxy("192.168.1.1"), true);
      assert.equal(isTrustedProxy("203.0.113.9"), false);
      assert.deepEqual(fastifyTrustProxySetting(), ["10.0.0.0/8", "192.168.1.1"]);
    });
  });

  it("does not treat an IPv4-mapped peer as a different network", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      assert.equal(isTrustedProxy("::ffff:10.1.2.3"), true);
      // 0a01:0203 is the hex spelling of 10.1.2.3.
      assert.equal(isTrustedProxy("::ffff:0a01:0203"), true, "hex mapped form must match too");
    });
  });
});

describe("Client address resolution", () => {
  it("ignores x-forwarded-for from an untrusted peer", async () => {
    await withTrustedProxies("", async () => {
      const request = fakeRequest("203.0.113.9", { "x-forwarded-for": "1.2.3.4" });
      assert.equal(clientAddress(request), "203.0.113.9");
      assert.equal(peerAddress(request), "203.0.113.9");
    });
  });

  it("uses the forwarded address behind a trusted proxy", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const request = fakeRequest("10.0.0.1", { "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
      assert.equal(clientAddress(request), "203.0.113.9");
    });
  });

  it("does not let a client behind an untrusted peer rotate its budget", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const request = fakeRequest("198.51.100.7", { "x-forwarded-for": "1.1.1.1" });
      assert.equal(clientAddress(request), "198.51.100.7");
    });
  });
});

describe("Header stripping", () => {
  it("removes identity headers from an untrusted peer", async () => {
    await withTrustedProxies("", async () => {
      const request = fakeRequest("203.0.113.9", {
        "x-forwarded-client-cert": "By=cn;Hash=abc",
        "x-client-cert-fingerprint": FINGERPRINT,
        "x-service-account-id": "11111111-1111-1111-1111-111111111111",
        "x-forwarded-for": "1.2.3.4",
      });
      const trusted = stripUntrustedHeaders(request);
      assert.equal(trusted, false);
      const headers = (request as { headers: Record<string, string> }).headers;
      assert.equal(headers["x-forwarded-client-cert"], undefined);
      assert.equal(headers["x-client-cert-fingerprint"], undefined);
      assert.equal(headers["x-service-account-id"], undefined);
      assert.equal(headers["x-forwarded-for"], undefined);
    });
  });

  it("keeps headers from a trusted proxy", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const request = fakeRequest("10.0.0.1", { "x-client-cert-fingerprint": FINGERPRINT });
      assert.equal(stripUntrustedHeaders(request), true);
      const headers = (request as { headers: Record<string, string> }).headers;
      assert.equal(headers["x-client-cert-fingerprint"], FINGERPRINT);
    });
  });

  it("is applied by the running server", async () => {
    // End-to-end: a request carrying identity headers from a direct client
    // must have them removed before any route can see them.
    const res = await app.inject({
      method: "GET",
      url: HEADER_PROBE_PATH,
      headers: {
        "x-client-cert-fingerprint": FINGERPRINT,
        "x-service-account-id": "11111111-1111-1111-1111-111111111111",
        "x-forwarded-for": "1.2.3.4",
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(observedHeaders.fingerprint, undefined, "fingerprint must be stripped");
    assert.equal(observedHeaders.serviceAccount, undefined, "service-account hint must be stripped");
    assert.equal(observedHeaders.forwardedFor, undefined, "forwarded-for must be stripped");
  });
});

describe("Misconfiguration diagnostics", () => {
  it("recognises infrastructure addresses", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      // Fully expanded forms must classify the same as the compressed ones.
      "fe80:0000:0000:0000:0000:0000:0000:0001",
      "fd12:3456:789a:bcde:f012:3456:789a:bcde",
    ]) {
      assert.equal(isInfrastructureAddress(address), true, address);
    }
  });

  it("does not treat public client addresses as infrastructure", () => {
    for (const address of [
      "203.0.113.9",
      "198.51.100.7",
      "8.8.8.8",
      // 172.15/16 and 172.32/16 sit just outside RFC 1918.
      "172.15.0.1",
      "172.32.0.1",
      "11.0.0.1",
      "192.169.0.1",
      "2001:db8::1",
    ]) {
      assert.equal(isInfrastructureAddress(address), false, address);
    }
  });

  it("reports a proxied deployment that forgot to configure trusted proxies", async () => {
    await withTrustedProxies("", async () => {
      assert.equal(hasTrustedProxies(), false);
      const reason = describeUntrustedPeer("10.0.0.1");
      assert.ok(reason, "an infrastructure peer with no configured proxy is a misconfiguration");
      assert.match(reason, /KEYSTONE_TRUSTED_PROXIES/);
      assert.match(reason, /rate-limit/, "the warning must name the observable symptom");
    });
  });

  it("stays quiet for a public client and once proxies are configured", async () => {
    await withTrustedProxies("", async () => {
      assert.equal(describeUntrustedPeer("203.0.113.9"), null, "a hostile client is not a misconfiguration");
    });
    await withTrustedProxies("10.0.0.0/8", async () => {
      assert.equal(hasTrustedProxies(), true);
      assert.equal(describeUntrustedPeer("192.168.1.1"), null, "the operator configured this deliberately");
    });
  });
});

describe("Fingerprint validation", () => {
  it("accepts hex and colon-separated SHA-256 forms", () => {
    assert.equal(isValidFingerprint("A".repeat(64)), true);
    assert.equal(isValidFingerprint(COLON_FINGERPRINT), true);
  });

  it("rejects anything else", () => {
    const bad: Array<string | undefined> = [
      undefined,
      "",
      "zz".repeat(32),
      "a".repeat(63),
      "a".repeat(65),
      "not a fingerprint",
      `${"a".repeat(64)} extra`,
    ];
    for (const value of bad) {
      assert.equal(isValidFingerprint(value), false, String(value));
    }
  });

  it("canonicalises both forms to the same value", () => {
    assert.equal(canonicalFingerprint(COLON_FINGERPRINT), "ab".repeat(32));
    assert.equal(canonicalFingerprint(`  ${FINGERPRINT.toUpperCase()} `), FINGERPRINT);
  });
});

describe("Service account certificate binding", () => {
  it("refuses certificate auth when no service account is bound", async () => {
    const [created] = await db
      .insert(serviceAccounts)
      .values({ orgId, name: `${NAME_PREFIX}unbound`, isActive: true })
      .returning();
    assert.equal(created.certFingerprint, null);

    const { findServiceAccountByFingerprint } = await import("../../plugins/mtls.js");
    assert.equal(await findServiceAccountByFingerprint(nextFingerprint()), undefined);
  });

  it("resolves an active account by its bound fingerprint", async () => {
    const fingerprint = nextFingerprint();
    const [created] = await db
      .insert(serviceAccounts)
      .values({ orgId, name: `${NAME_PREFIX}bound`, certFingerprint: fingerprint, isActive: true })
      .returning();

    const { findServiceAccountByFingerprint } = await import("../../plugins/mtls.js");
    const found = await findServiceAccountByFingerprint(fingerprint);
    assert.equal(found?.id, created.id);

    // A different certificate must not resolve to it.
    assert.equal(await findServiceAccountByFingerprint(nextFingerprint()), undefined);
  });

  it("does not resolve a revoked or inactive account", async () => {
    const revokedPrint = nextFingerprint();
    const inactivePrint = nextFingerprint();
    await db.insert(serviceAccounts).values({
      orgId,
      name: `${NAME_PREFIX}revoked`,
      certFingerprint: revokedPrint,
      isActive: true,
      revokedAt: new Date(),
    });
    await db.insert(serviceAccounts).values({
      orgId,
      name: `${NAME_PREFIX}inactive`,
      certFingerprint: inactivePrint,
      isActive: false,
    });

    const { findServiceAccountByFingerprint } = await import("../../plugins/mtls.js");
    assert.equal(
      await findServiceAccountByFingerprint(revokedPrint),
      undefined,
      "revoked must not authenticate"
    );
    assert.equal(
      await findServiceAccountByFingerprint(inactivePrint),
      undefined,
      "inactive must not authenticate"
    );
  });

  it("cannot bind one fingerprint to two accounts", async () => {
    const fingerprint = nextFingerprint();
    await db
      .insert(serviceAccounts)
      .values({ orgId, name: `${NAME_PREFIX}dup-a`, certFingerprint: fingerprint });

    // Drizzle wraps the driver error, so the server's message is on `cause`.
    await assert.rejects(
      () =>
        db
          .insert(serviceAccounts)
          .values({ orgId, name: `${NAME_PREFIX}dup-b`, certFingerprint: fingerprint }),
      (error: Error) => {
        const detail = `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`;
        assert.match(detail, /service_accounts_cert_fingerprint_unique|duplicate key/i);
        return true;
      }
    );
  });
});

describe("Service account certificate authentication", () => {
  async function seedBoundAccount(fingerprint = nextFingerprint()) {
    const [account] = await db
      .insert(serviceAccounts)
      .values({
        orgId,
        name: `${NAME_PREFIX}mtls-${fingerprint.slice(0, 8)}`,
        certFingerprint: fingerprint,
        isActive: true,
      })
      .returning();
    return account;
  }

  async function probe(peer: string, headers: Record<string, string>) {
    const { requireMTLS } = await import("../../plugins/mtls.js");
    const preHandler = requireMTLS();
    let status = 200;
    const reply = {
      status(code: number) {
        status = code;
        return this;
      },
      send() {
        return this;
      },
    } as never;
    const request = {
      headers,
      socket: { remoteAddress: peer },
      ip: peer,
      serviceAccount: undefined as unknown,
      log: { warn() {}, debug() {} },
    } as never;
    await preHandler(request, reply);
    return { status, serviceAccount: (request as { serviceAccount?: { id: string } }).serviceAccount };
  }

  it("rejects x-service-account-id alone, with no certificate", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const account = await seedBoundAccount();
      const res = await probe("10.0.0.1", { "x-service-account-id": account.id });
      assert.equal(res.status, 401, "naming a service account must never authenticate");
      assert.equal(res.serviceAccount, undefined);
    });
  });

  it("rejects a spoofed x-service-account-id from an untrusted peer", async () => {
    await withTrustedProxies("", async () => {
      const fingerprint = nextFingerprint();
      const account = await seedBoundAccount(fingerprint);
      const res = await probe("203.0.113.9", {
        "x-service-account-id": account.id,
        "x-client-cert-fingerprint": fingerprint,
      });
      assert.equal(res.status, 401);
      assert.equal(res.serviceAccount, undefined);
    });
  });

  it("accepts a valid certificate from a trusted proxy", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const fingerprint = nextFingerprint();
      const account = await seedBoundAccount(fingerprint);
      const res = await probe("10.0.0.1", { "x-client-cert-fingerprint": fingerprint });
      assert.equal(res.status, 200);
      assert.equal(res.serviceAccount?.id, account.id);
    });
  });

  it("accepts the colon-separated fingerprint form", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const fingerprint = crypto.randomBytes(32).toString("hex");
      const account = await seedBoundAccount(fingerprint);
      const colonForm = fingerprint.replace(/(..)(?=.)/g, "$1:");
      const res = await probe("10.0.0.1", { "x-client-cert-fingerprint": colonForm });
      assert.equal(res.status, 200);
      assert.equal(res.serviceAccount?.id, account.id);
    });
  });

  it("rejects a certificate bound to no account", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const res = await probe("10.0.0.1", { "x-client-cert-fingerprint": nextFingerprint() });
      assert.equal(res.status, 403);
    });
  });

  it("rejects a malformed fingerprint", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const res = await probe("10.0.0.1", { "x-client-cert-fingerprint": "not-a-fingerprint" });
      assert.equal(res.status, 401);
    });
  });

  it("refuses a hint that disagrees with the presented certificate", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const realFingerprint = nextFingerprint();
      const hinted = await seedBoundAccount();
      await seedBoundAccount(realFingerprint);
      // Claim to be `hinted` while presenting a different account's certificate.
      const res = await probe("10.0.0.1", {
        "x-service-account-id": hinted.id,
        "x-client-cert-fingerprint": realFingerprint,
      });
      assert.notEqual(res.status, 200, "a mismatched hint must not authenticate");
      assert.notEqual(res.serviceAccount?.id, hinted.id);
    });
  });
});

/**
 * The regression that motivated this phase: `trustProxy: true` plus an
 * unconditional `x-forwarded-for` read meant any client could present a fresh
 * address on every request and never hit a rate limit.
 */
describe("Rate limiting cannot be bypassed by header spoofing", () => {
  const LIMIT = RATE_LIMIT_MAX;
  const probePath = LIMIT_PROBE_PATH;

  /** Send `count` requests from a fixed peer, each claiming a different address. */
  async function burst(count: number, peer: string) {
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) {
      const res = await app.inject({
        method: "GET",
        url: probePath,
        remoteAddress: peer,
        headers: { "x-forwarded-for": `198.51.100.${i + 1}` },
      });
      statuses.push(res.statusCode);
    }
    return statuses;
  }

  it("counts every spoofed address against one budget when no proxy is trusted", async () => {
    await withTrustedProxies("", async () => {
      const statuses = await burst(LIMIT + 2, "203.0.113.9");
      assert.deepEqual(
        statuses.slice(0, LIMIT),
        [200, 200, 200],
        "the first requests in the window must succeed"
      );
      assert.ok(
        statuses.slice(LIMIT).every((code) => code === 429),
        `requests past the limit must be rate limited, got ${statuses.join(",")}`
      );
    });
  });

  it("still separates distinct clients behind a trusted proxy", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      // A genuine proxy forwards real client addresses, so those clients must
      // not share a single budget.
      const statuses = await burst(LIMIT + 2, "10.0.0.1");
      assert.ok(
        statuses.every((code) => code === 200),
        `each forwarded client should get its own budget, got ${statuses.join(",")}`
      );
    });
  });

  it("keeps the budget shared when the same client repeats behind a proxy", async () => {
    await withTrustedProxies("10.0.0.0/8", async () => {
      const seen: number[] = [];
      for (let i = 0; i < LIMIT + 2; i++) {
        const res = await app.inject({
          method: "GET",
          url: probePath,
          remoteAddress: "10.0.0.1",
          headers: { "x-forwarded-for": "198.51.100.77" },
        });
        seen.push(res.statusCode);
      }
      assert.ok(
        seen.slice(LIMIT).every((code) => code === 429),
        `a repeated client address must exhaust its own budget, got ${seen.join(",")}`
      );
    });
  });
});

describe("Service account certificate administration", () => {
  async function seedAccount() {
    const [account] = await db
      .insert(serviceAccounts)
      .values({ orgId, name: `${NAME_PREFIX}admin-${Date.now()}`, isActive: true })
      .returning();
    return account;
  }

  it("binds and then clears a certificate", async () => {
    const account = await seedAccount();
    const fingerprint = nextFingerprint();

    const bound = await setServiceAccountCertificate(account.id, orgId, fingerprint);
    assert.equal(bound?.certFingerprint, fingerprint);

    const cleared = await setServiceAccountCertificate(account.id, orgId, null);
    assert.equal(cleared?.certFingerprint, null);
  });

  it("canonicalizes a colon-separated fingerprint so one certificate cannot bind twice", async () => {
    const account = await seedAccount();
    const fingerprint = nextFingerprint();
    const colonForm = fingerprint.replace(/(..)(?=.)/g, "$1:");

    await setServiceAccountCertificate(account.id, orgId, colonForm);

    const other = await seedAccount();
    // The same certificate spelled differently must collide, not create a
    // second binding.
    await assert.rejects(
      () => setServiceAccountCertificate(other.id, orgId, fingerprint.toUpperCase()),
      (error: Error) => {
        const detail = `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`;
        assert.match(detail, /service_accounts_cert_fingerprint_unique|duplicate key/i);
        return true;
      }
    );
  });

  it("refuses to bind a certificate already held by another account", async () => {
    const first = await seedAccount();
    const fingerprint = nextFingerprint();
    await setServiceAccountCertificate(first.id, orgId, fingerprint);

    const second = await seedAccount();
    await assert.rejects(() => setServiceAccountCertificate(second.id, orgId, fingerprint));
  });

  it("rejects a malformed fingerprint instead of storing it", async () => {
    const account = await seedAccount();
    for (const bad of ["", "not-a-fingerprint", "a".repeat(63), "a".repeat(65), "zz".repeat(32)]) {
      await assert.rejects(
        () => setServiceAccountCertificate(account.id, orgId, bad),
        /SHA-256/,
        `expected ${JSON.stringify(bad)} to be refused`
      );
    }
    const untouched = await db
      .select({ fp: serviceAccounts.certFingerprint })
      .from(serviceAccounts)
      .where(eq(serviceAccounts.id, account.id));
    assert.equal(untouched[0]?.fp, null, "a refused binding must not write anything");
  });

  it("does not touch a service account in another organization", async () => {
    const account = await seedAccount();
    const wrongOrg = crypto.randomUUID();
    const result = await setServiceAccountCertificate(account.id, wrongOrg, nextFingerprint());
    assert.equal(result, undefined, "an org mismatch must not update the row");
  });

  it("revokes an account, and revoking twice is not a silent success", async () => {
    const account = await seedAccount();
    const fingerprint = nextFingerprint();
    await setServiceAccountCertificate(account.id, orgId, fingerprint);

    const { findServiceAccountByFingerprint } = await import("../../plugins/mtls.js");
    assert.equal((await findServiceAccountByFingerprint(fingerprint))?.id, account.id);

    const revoked = await revokeServiceAccount(account.id, orgId);
    assert.equal(revoked?.isActive, false);
    assert.ok(revoked?.revokedAt, "revokedAt must be stamped");

    // Certificate auth must stop, and the account must disappear from reads.
    assert.equal(await findServiceAccountByFingerprint(fingerprint), undefined);
    assert.equal(await findServiceAccountById(account.id, orgId), undefined);

    // A second revoke reports nothing, so the caller can tell it was already done.
    assert.equal(await revokeServiceAccount(account.id, orgId), undefined);
  });
});
