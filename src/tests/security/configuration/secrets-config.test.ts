import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "secrets-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const {
  REDACTED_CONFIG_VALUE,
  EXPOSABLE_CONFIG_KEYS,
  isExposableConfigurationKey,
  isSensitiveConfigurationKey,
  redactConfigurationValues,
  mergeConfigurationUpdates,
} = await import("../../../services/configuration/profiles.js");
const { encryptSecret } = await import("../../../services/totp.js");
const { readWebhookSecret, createEndpoint, rotateEndpointSecret } = await import(
  "../../../services/webhooks.js"
);
const { signWebhookPayload } = await import("../../../lib/webhookSignature.js");
const { isOriginAllowed } = await import("../../../services/trustedProxies.js");
const { webhookEndpoints } = await import("../../../db/schema.js");

before(async () => {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../db/migrations") });
  await loadSigningKeys();
});

after(async () => {
  await db.delete(webhookEndpoints).catch(() => {});
  const { closeDb } = await import("../../../db/index.js");
  await closeDb().catch(() => {});
});

// ---------------------------------------------------------------------------
// Plan item 1 — the admin configuration endpoint
// ---------------------------------------------------------------------------
describe("Admin configuration redaction", () => {
  it("never returns a value for a key that is not explicitly exposable", () => {
    // These are the keys the previous denylist missed, found by running the
    // denylist against a list of secret-looking names.
    const previouslyLeaked = [
      "SIGNING_KEY",
      "JWT_SIGNING_KEY",
      "SMTP_USER",
      "TWILIO_AUTH",
      "SENDGRID_KEY",
      "PROVIDER_APIKEY",
      "SAML_CERT",
      "TLS_KEY",
      "CERT_PRIVATE",
      "HMAC_KEY",
      "KMS_KEY",
      "DB_URL",
    ];
    const values = Object.fromEntries(previouslyLeaked.map((k) => [k, "super-secret-value"]));
    const redacted = redactConfigurationValues(values);

    for (const key of previouslyLeaked) {
      assert.equal(redacted[key], REDACTED_CONFIG_VALUE, `${key} must be masked`);
    }
  });

  it("masks every connection string and private key", () => {
    const values = {
      DATABASE_URL: "postgres://user:pass@host/db",
      REDIS_URL: "redis://:password@host:6379",
      JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
      KEYSTONE_ENCRYPTION_KEY: "0".repeat(32),
      KEYSTONE_INTERNAL_API_KEY: "internal",
      SMTP_PASSWORD: "mailpass",
    };
    const redacted = redactConfigurationValues(values);
    for (const [key, value] of Object.entries(values)) {
      assert.equal(redacted[key], REDACTED_CONFIG_VALUE, `${key} must be masked`);
      assert.ok(!redacted[key].includes(value.slice(0, 6)), `${key} must not leak a prefix`);
    }
  });

  it("still returns deployment settings, which are not credentials", () => {
    const redacted = redactConfigurationValues({
      NODE_ENV: "production",
      PORT: "4001",
      ALLOWED_ORIGINS: "https://app.example.com",
      MFA_MAX_ATTEMPTS: "5",
    });
    assert.equal(redacted.NODE_ENV, "production");
    assert.equal(redacted.PORT, "4001");
    assert.equal(redacted.ALLOWED_ORIGINS, "https://app.example.com");
    assert.equal(redacted.MFA_MAX_ATTEMPTS, "5");
  });

  it("defaults a key that is not on the allowlist to private", () => {
    // The point of the allowlist: a key nobody has thought about is private.
    assert.equal(isExposableConfigurationKey("SOME_FUTURE_SECRET_THING"), false);
    assert.equal(isExposableConfigurationKey("NODE_ENV"), true);
  });

  it("keeps every real credential off the allowlist", () => {
    // The allowlist is an independent judgement and does not have to agree with
    // the legacy denylist regex, which is over-broad: it matches TOKEN inside
    // ACCESS_TOKEN_TTL_SECONDS and PASSWORD inside RESET_PASSWORD_URL, neither of
    // which is a credential. So this asserts against the actual credentials
    // rather than against the regex.
    const credentials = [
      "DATABASE_URL",
      "REDIS_URL",
      "JWT_PRIVATE_KEY",
      "JWT_PUBLIC_KEY",
      "SIGNING_KEY",
      "JWT_SIGNING_KEY",
      "KEYSTONE_ENCRYPTION_KEY",
      "KEYSTONE_TOTP_ENCRYPTION_KEY",
      "KEYSTONE_INTERNAL_API_KEY",
      "SMTP_PASS",
      "SMTP_PASSWORD",
      "SENDGRID_API_KEY",
      "MAILGUN_API_KEY",
      "TWILIO_AUTH_TOKEN",
      "WEBHOOK_SIGNING_SECRET",
      "KEYSTONE_WEBHOOK_SIGNING_SECRET",
      "KEYSTONE_SEED_OWNER_PASSWORD",
      "HILBRAS_OS_CLIENT_SECRET",
      "HILBRAS_AI_CLIENT_SECRET",
      "ZITADEL_CLIENT_SECRET",
      "ZITADEL_SERVICE_PAT",
    ];
    for (const key of credentials) {
      assert.equal(
        EXPOSABLE_CONFIG_KEYS.has(key),
        false,
        `${key} is a credential and must never be exposable`
      );
    }
  });

  it("preserves a masked value across a round trip rather than overwriting it", () => {
    const existing = { JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----", NODE_ENV: "production" };
    const merged = mergeConfigurationUpdates(existing, {
      JWT_PRIVATE_KEY: REDACTED_CONFIG_VALUE,
      NODE_ENV: "staging",
    });
    assert.equal(merged.JWT_PRIVATE_KEY, "-----BEGIN PRIVATE KEY-----", "the secret must survive untouched");
    assert.equal(merged.NODE_ENV, "staging", "a real update must still apply");
  });

  it("omits keys that are unset rather than reporting them as empty", () => {
    const redacted = redactConfigurationValues({ NODE_ENV: "production", MISSING: undefined });
    assert.equal("MISSING" in redacted, false);
  });
});

// ---------------------------------------------------------------------------
// Plan item 2 — setup token logging
// ---------------------------------------------------------------------------
describe("Setup token is never logged", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPrint = process.env.KEYSTONE_PRINT_SETUP_TOKEN;
  const originalToken = process.env.KEYSTONE_SETUP_TOKEN;

  function restore() {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalPrint === undefined) delete process.env.KEYSTONE_PRINT_SETUP_TOKEN;
    else process.env.KEYSTONE_PRINT_SETUP_TOKEN = originalPrint;
    if (originalToken === undefined) delete process.env.KEYSTONE_SETUP_TOKEN;
    else process.env.KEYSTONE_SETUP_TOKEN = originalToken;
  }

  async function capture(fn: () => void): Promise<string> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      fn();
    } finally {
      console.log = original;
    }
    return lines.join("\n");
  }

  it("does not print the token by default", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.KEYSTONE_PRINT_SETUP_TOKEN;
    process.env.KEYSTONE_SETUP_TOKEN = "deadbeef-secret-token";
    try {
      const { printSetupToken } = await import("../../../services/setup/token.js");
      const output = await capture(() => printSetupToken());
      assert.ok(!output.includes("deadbeef-secret-token"), "the token must not appear in output");
      assert.match(output, /KEYSTONE_SETUP_TOKEN/, "the operator should be told where to find it");
    } finally {
      restore();
    }
  });

  it("refuses to print it even when explicitly requested in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.KEYSTONE_PRINT_SETUP_TOKEN = "true";
    process.env.KEYSTONE_SETUP_TOKEN = "deadbeef-secret-token";
    try {
      const { printSetupToken } = await import("../../../services/setup/token.js");
      const output = await capture(() => printSetupToken());
      assert.ok(!output.includes("deadbeef-secret-token"), "production must never print it");
    } finally {
      restore();
    }
  });

  it("prints it outside production when explicitly asked", async () => {
    process.env.NODE_ENV = "development";
    process.env.KEYSTONE_PRINT_SETUP_TOKEN = "true";
    process.env.KEYSTONE_SETUP_TOKEN = "deadbeef-secret-token";
    try {
      const { printSetupToken } = await import("../../../services/setup/token.js");
      const output = await capture(() => printSetupToken());
      assert.match(output, /deadbeef-secret-token/, "an explicit opt-in outside production should work");
    } finally {
      restore();
    }
  });

  it("says nothing on a rejected token", async () => {
    // The old code logged the presented and expected lengths on a mismatch,
    // disclosing the expected token's length to anyone who could read the output.
    // Asserted behaviourally: a rejected token produces no output at all.
    process.env.NODE_ENV = "production";
    process.env.KEYSTONE_SETUP_TOKEN = "expected-token-value";
    delete process.env.KEYSTONE_PRINT_SETUP_TOKEN;
    try {
      const { validateSetupToken } = await import("../../../services/setup/token.js");
      const output = await capture(() => {
        assert.equal(validateSetupToken("short"), false, "a wrong-length token must be rejected");
        assert.equal(validateSetupToken(undefined), false);
        assert.equal(validateSetupToken(""), false);
      });
      assert.equal(output.trim(), "", `a rejected token must be silent, got: ${output}`);
      assert.ok(!output.includes("expected"), "nothing about the expected token may be logged");
    } finally {
      restore();
    }
  });

  it("accepts a correct token without logging it", async () => {
    process.env.NODE_ENV = "production";
    const secret = "correct-token-value";
    process.env.KEYSTONE_SETUP_TOKEN = secret;
    try {
      const { validateSetupToken } = await import("../../../services/setup/token.js");
      const output = await capture(() => {
        assert.equal(validateSetupToken(secret), true);
        assert.equal(validateSetupToken(`  ${secret.toUpperCase()}  `), true, "whitespace and case are forgiven");
      });
      assert.ok(!output.includes(secret), "a successful validation must not echo the token");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Plan item 3 — webhook secrets at rest
// ---------------------------------------------------------------------------
describe("Webhook secrets are encrypted at rest", () => {
  const createdEndpointIds: string[] = [];

  after(async () => {
    for (const id of createdEndpointIds) {
      await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).catch(() => {});
    }
  });

  it("stores ciphertext, not the secret", async () => {
    const { createEndpoint: create } = await import("../../../services/webhooks.js");
    const created = await create({ url: "https://hook.example.test/a", events: ["user_login"] });
    createdEndpointIds.push(created.id);

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, created.id));
    assert.notEqual(row.secret, created.signingSecret, "the stored value must not be the plaintext");
    assert.ok(!row.secret.includes(created.signingSecret), "the plaintext must not be a substring");
    assert.ok(row.secret.startsWith("v2."), "the stored value should be a versioned envelope");
  });

  it("returns the plaintext exactly once, at creation", async () => {
    const { createEndpoint: create } = await import("../../../services/webhooks.js");
    const created = await create({ url: "https://hook.example.test/b" });
    createdEndpointIds.push(created.id);
    assert.match(created.signingSecret, /^whsec_/);
  });

  it("signs identically after a round trip, so existing verifiers keep working", () => {
    const secret = `whsec_${"Ab-_123".repeat(4)}`;
    const stored = encryptSecret(secret);
    assert.equal(readWebhookSecret(stored), secret);
    const payload = '{"event":"user_login"}';
    assert.equal(
      signWebhookPayload(secret, payload),
      signWebhookPayload(readWebhookSecret(stored), payload),
      "signature must be byte-identical"
    );
  });

  it("reads a pre-upgrade plaintext secret unchanged", () => {
    // Without this, every existing endpoint would throw on its first delivery.
    const legacy = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
    assert.equal(readWebhookSecret(legacy), legacy);
  });

  it("encrypts on rotation too", async () => {
    const { createEndpoint: create } = await import("../../../services/webhooks.js");
    const created = await create({ url: "https://hook.example.test/c" });
    createdEndpointIds.push(created.id);

    const rotated = await rotateEndpointSecret(created.id);
    assert.ok(rotated?.signingSecret, "rotation must return the new secret");
    assert.notEqual(rotated.signingSecret, created.signingSecret, "rotation must change the secret");

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, created.id));
    assert.notEqual(row.secret, rotated.signingSecret, "the rotated secret must also be encrypted");
    assert.equal(readWebhookSecret(row.secret), rotated.signingSecret);
  });
});

// ---------------------------------------------------------------------------
// Plan items 4, 5 and 6 — deployment defaults
// ---------------------------------------------------------------------------
describe("CORS origin policy", () => {
  // Imported, not reproduced. An earlier version of these tests defined their
  // own copy of the predicate, which would have kept passing while the server's
  // real logic was reverted.

  it("refuses every browser origin when the allowlist is empty in production", () => {
    // The defect: an empty ALLOWED_ORIGINS used to return true, so an unset
    // variable meant "allow every origin" on a server that sends credentialed
    // cookies.
    const policy = { allowedOrigins: [], nodeEnv: "production" };
    for (const origin of [
      "https://evil.example",
      "https://app.example.com",
      "http://localhost:5173",
      "null",
    ]) {
      assert.equal(isOriginAllowed(origin, policy), false, `${origin} must be refused`);
    }
  });

  it("still permits a request with no Origin header", () => {
    // curl, server-to-server calls and same-origin navigations send none.
    assert.equal(isOriginAllowed(undefined, { allowedOrigins: [], nodeEnv: "production" }), true);
  });

  it("permits only listed origins in production", () => {
    const policy = { allowedOrigins: ["https://app.example.com"], nodeEnv: "production" };
    assert.equal(isOriginAllowed("https://app.example.com", policy), true);
    assert.equal(isOriginAllowed("https://app.example.com.evil.test", policy), false, "no suffix matching");
    assert.equal(isOriginAllowed("https://APP.example.com", policy), false, "no case folding");
    assert.equal(isOriginAllowed("http://app.example.com", policy), false, "no scheme downgrade");
  });

  it("allows any localhost port in development, for test projects", () => {
    const policy = { allowedOrigins: [], nodeEnv: "development" };
    assert.equal(isOriginAllowed("http://localhost:5173", policy), true);
    assert.equal(isOriginAllowed("http://localhost:4173", policy), true);
    assert.equal(isOriginAllowed("https://evil.example", policy), false, "the allowance is localhost only");
  });

  it("honours the setup server's additional loopback origins", () => {
    const policy = {
      allowedOrigins: [],
      nodeEnv: "production",
      additionallyAllowed: ["http://localhost:4001", "http://127.0.0.1:4001"],
    };
    assert.equal(isOriginAllowed("http://localhost:4001", policy), true);
    assert.equal(isOriginAllowed("http://127.0.0.1:4001", policy), true);
    for (const origin of ["https://evil.example", "http://localhost:9999", "http://127.0.0.1:9999"]) {
      assert.equal(isOriginAllowed(origin, policy), false, `${origin} must be refused by the setup server`);
    }
  });
});

describe("Production deployment defaults", () => {
  const original = { ...process.env };

  afterEach(() => {
    for (const key of ["NODE_ENV", "COOKIE_SECURE"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  /** The expression `config.ts` uses, evaluated against a given environment. */
  function cookieSecureFor(env: Record<string, string | undefined>): boolean {
    const nodeEnv = env.NODE_ENV ?? "development";
    const fallback = nodeEnv === "production" ? "true" : "false";
    return (env.COOKIE_SECURE ?? fallback) === "true";
  }

  it("marks cookies Secure in production without an explicit setting", () => {
    // The previous default was "false", so an operator who did not set
    // COOKIE_SECURE got session cookies that would be sent over plain HTTP.
    assert.equal(cookieSecureFor({ NODE_ENV: "production" }), true);
  });

  it("leaves cookies insecure-by-default in development, for plain-HTTP testing", () => {
    assert.equal(cookieSecureFor({ NODE_ENV: "development" }), false);
    assert.equal(cookieSecureFor({}), false);
  });

  it("honours an explicit override in either direction", () => {
    assert.equal(cookieSecureFor({ NODE_ENV: "production", COOKIE_SECURE: "false" }), false);
    assert.equal(cookieSecureFor({ NODE_ENV: "development", COOKIE_SECURE: "true" }), true);
  });

  it("the default SameSite is already strict in production", () => {
    // Already correct; pinned so it cannot regress.
    const sameSite = (env: Record<string, string | undefined>) =>
      env.COOKIE_SAME_SITE ?? ((env.NODE_ENV ?? "development") === "production" ? "strict" : "lax");
    assert.equal(sameSite({ NODE_ENV: "production" }), "strict");
    assert.equal(sameSite({ NODE_ENV: "development" }), "lax");
  });
});

describe("Setup server exposure", () => {
  it("defaults to loopback even when the main server binds to all interfaces", () => {
    // `HOST` defaults to 0.0.0.0, which is right for the main server and wrong
    // for the one that creates the owner account.
    const setupBindHost = (env: Record<string, string | undefined>): string => {
      const explicit = env.KEYSTONE_SETUP_HOST?.trim();
      if (explicit) return explicit;
      const host = env.HOST ?? "0.0.0.0";
      return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    };

    assert.equal(setupBindHost({}), "127.0.0.1", "must not inherit 0.0.0.0");
    assert.equal(setupBindHost({ HOST: "0.0.0.0" }), "127.0.0.1");
    assert.equal(setupBindHost({ HOST: "::" }), "127.0.0.1");
    assert.equal(setupBindHost({ HOST: "10.0.0.5" }), "10.0.0.5", "a private interface is honoured");
    assert.equal(setupBindHost({ KEYSTONE_SETUP_HOST: "0.0.0.0" }), "0.0.0.0", "an explicit choice wins");
  });
});
