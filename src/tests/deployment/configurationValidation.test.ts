import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PLACEHOLDER_SECRET,
  formatFinding,
  validateConfiguration,
  type ConfigValidationInput,
} from "../../services/config-validation.js";

/**
 * §6.1. The production configuration validator.
 *
 * Every case below is written against the input struct rather than the live
 * `config` object, because `config` is a load-time snapshot: `NODE_ENV` cannot be
 * flipped mid-process, so a validator that read it directly could only be tested by
 * spawning a process per case. That is the same seam `isOriginAllowed` was given.
 */

function productionInput(overrides: Partial<ConfigValidationInput> = {}): ConfigValidationInput {
  return {
    environment: "production",
    databaseUrl: "postgresql://user:pass@db:5432/keystone",
    redisUrl: "redis://redis:6379",
    queueProvider: "bullmq",
    encryptionKey: "a".repeat(64),
    totpEncryptionKey: "b".repeat(64),
    internalApiKey: "c".repeat(64),
    cookieSecure: true,
    cookieSameSite: "strict",
    cookieName: "__Host-keystone-session",
    allowedOrigins: ["https://app.example.com"],
    allowPrivateWebhookTargets: false,
    allowPrivateSsoEndpoints: false,
    allowInsecureWebhook: "",
    webhookSigningSecret: "d".repeat(64),
    trustedProxies: "10.0.0.0/8",
    allowDevDefaults: false,
    logLevel: "info",
    authPublicUrl: "https://id.example.com",
    otelEndpoint: "",
    ...overrides,
  };
}

const codes = (input: ConfigValidationInput, level?: "error" | "warning" | "info"): string[] =>
  validateConfiguration(input)
    .findings.filter((finding) => level === undefined || finding.level === level)
    .map((finding) => finding.code);

describe("production configuration validation", () => {
  it("passes a correctly configured production deployment", () => {
    const report = validateConfiguration(productionInput());
    assert.equal(report.profile, "production");
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
    assert.equal(report.fatal, false);
  });

  it("refuses a plaintext session cookie", () => {
    const report = validateConfiguration(productionInput({ cookieSecure: false }));
    assert.ok(report.errors.some((finding) => finding.code === "CONFIG_INSECURE_COOKIE"));
    assert.equal(report.fatal, true);
  });

  it("refuses a placeholder or short TOTP key", () => {
    for (const key of ["", "short", PLACEHOLDER_SECRET]) {
      const report = validateConfiguration(productionInput({ totpEncryptionKey: key, internalApiKey: "" }));
      assert.equal(report.fatal, true, `key ${JSON.stringify(key)} should be refused`);
      assert.ok(report.errors.some((finding) => finding.code === "CONFIG_WEAK_TOTP_KEY"));
    }
  });

  it("refuses an in-process queue in production", () => {
    const report = validateConfiguration(productionInput({ queueProvider: "in-process" }));
    assert.ok(report.errors.some((finding) => finding.code === "CONFIG_IN_PROCESS_QUEUE"));
    assert.equal(report.fatal, true);
  });

  it("allows the in-process queue in staging, as a warning", () => {
    const report = validateConfiguration(
      productionInput({ environment: "staging", queueProvider: "in-process" })
    );
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.some((finding) => finding.code === "CONFIG_IN_PROCESS_QUEUE"));
    assert.equal(report.fatal, false);
  });

  it("refuses the insecure-webhook escape hatch in production", () => {
    const report = validateConfiguration(productionInput({ allowInsecureWebhook: "localhost" }));
    assert.ok(report.errors.some((finding) => finding.code === "CONFIG_INSECURE_WEBHOOK_ALLOWED"));
    assert.equal(report.fatal, true);
  });

  it("reports, but does not refuse, the remaining unsafe settings", () => {
    const report = validateConfiguration(
      productionInput({
        encryptionKey: "",
        internalApiKey: "",
        allowPrivateWebhookTargets: true,
        allowPrivateSsoEndpoints: true,
        webhookSigningSecret: "",
        allowedOrigins: [],
        cookieSameSite: "none",
        trustedProxies: "",
        authPublicUrl: "http://id.example.com",
        logLevel: "debug",
      })
    );
    const warned = report.warnings.map((finding) => finding.code);
    for (const code of [
      "CONFIG_MISSING_ENCRYPTION_KEY",
      "CONFIG_WEAK_INTERNAL_API_KEY",
      "CONFIG_PRIVATE_WEBHOOK_TARGETS",
      "CONFIG_PRIVATE_SSO_ENDPOINTS",
      "CONFIG_UNSIGNED_WEBHOOKS",
      "CONFIG_EMPTY_CORS",
      "CONFIG_COOKIE_SAMESITE_NONE",
      "CONFIG_UNTRUSTED_PROXY",
      "CONFIG_HTTP_ISSUER",
      "CONFIG_DEBUG_LOGGING",
    ]) {
      assert.ok(warned.includes(code), `${code} should be warned; got ${warned.join(", ")}`);
    }
    assert.equal(report.fatal, false);
  });

  it("does not refuse when the escape hatch is enabled, but says so", () => {
    const report = validateConfiguration(
      productionInput({ cookieSecure: false, queueProvider: "in-process", allowDevDefaults: true })
    );
    assert.equal(report.errors.length, 2);
    assert.equal(report.fatal, false);
    assert.ok(report.warnings.some((finding) => finding.code === "CONFIG_DEV_DEFAULTS_ENABLED"));
  });

  it("reports an unknown NODE_ENV rather than silently treating it as production", () => {
    const report = validateConfiguration(productionInput({ environment: "prod" }));
    assert.equal(report.profile, "development");
    assert.ok(codes(productionInput({ environment: "prod" }), "warning").includes("CONFIG_UNKNOWN_ENVIRONMENT"));
  });

  it("keeps a test environment free of warnings", () => {
    const report = validateConfiguration(
      productionInput({ environment: "test", cookieSecure: false, queueProvider: "in-process" })
    );
    assert.deepEqual(report.warnings, []);
    assert.equal(report.fatal, false);
    assert.ok(report.findings.some((finding) => finding.code === "CONFIG_PROFILE"));
  });

  it("warns about a weak TOTP key in development, where it still writes data", () => {
    const report = validateConfiguration(
      productionInput({ environment: "development", totpEncryptionKey: "", internalApiKey: "" })
    );
    assert.ok(report.warnings.some((finding) => finding.code === "CONFIG_WEAK_TOTP_KEY"));
  });

  it("orders findings by severity so the first line of a log is the worst", () => {
    const report = validateConfiguration(
      productionInput({ cookieSecure: false, logLevel: "debug", encryptionKey: "" })
    );
    assert.equal(report.findings[0].level, "error");
    const levels = report.findings.map((finding) => finding.level);
    const lastError = levels.lastIndexOf("error");
    const firstWarning = levels.indexOf("warning");
    assert.ok(lastError < firstWarning, `errors must precede warnings: ${levels.join(",")}`);
  });

  it("never echoes a secret into a finding", () => {
    const secret = "super-secret-value-that-must-not-leak";
    const report = validateConfiguration(
      productionInput({
        encryptionKey: "",
        internalApiKey: secret,
        webhookSigningSecret: "",
        authPublicUrl: "http://id.example.com",
      })
    );
    const text = report.findings.map(formatFinding).join("\n");
    assert.equal(text.includes(secret), false);
  });
});
