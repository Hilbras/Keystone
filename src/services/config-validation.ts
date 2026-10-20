import { config } from "../config.js";
import {
  isKnownProfile,
  resolveProfile,
  securityDefaults,
  type SecurityProfile,
} from "../config/profiles.js";

/**
 * §6.1. One production-configuration validator, run at boot.
 *
 * The checks existed before this file, but scattered: three fatals in `index.ts`,
 * a warn in `services/diagnostics.ts`, two more in `services/secrets/environment.ts`,
 * and a set of conditions that were documented as "not checked by a gate" in
 * `docs/DEPLOYMENT.md`. A check that lives at its point of use can only be found by
 * reading that point of use, and the conditions that matter most — an in-process
 * queue in a multi-instance deployment, an HTTP webhook allowlist left switched on,
 * debug logging in production — had no check at all.
 *
 * ## What is fatal and what is not
 *
 * `error` refuses to start unless `KEYSTONE_ALLOW_DEV_DEFAULTS=true`. That set is
 * deliberately small and every member is unambiguously unsafe in a production-like
 * profile:
 *
 * - sessions over plaintext (`COOKIE_SECURE=false`)
 * - TOTP secrets encrypted with a publicly known key
 * - an in-process queue in production (work is lost on restart and not shared)
 * - an insecure-webhook escape hatch switched on in production
 *
 * Everything else is a warning, because refusing to boot on a missing optional
 * integration turns a hardening release into an outage. `staging` is production-like
 * and strict: it exists to fail the way production would before production exists.
 *
 * ## Testability
 *
 * The input is an explicit struct rather than the live `config` object. `config` is
 * a load-time snapshot — `NODE_ENV` cannot be flipped mid-process — so a validator
 * that read it directly could only be tested by spawning a process per case. This
 * is the same seam `isOriginAllowed(origin, policy)` was given.
 */
export type FindingLevel = "error" | "warning" | "info";

export interface ConfigFinding {
  level: FindingLevel;
  /** Stable machine-readable id, e.g. `CONFIG_INSECURE_COOKIE`. */
  code: string;
  message: string;
  /** What to do about it. Never a value from the environment. */
  hint?: string;
}

export interface ConfigValidationReport {
  profile: SecurityProfile;
  environment: string;
  findings: ConfigFinding[];
  errors: ConfigFinding[];
  warnings: ConfigFinding[];
  /** True when an error must stop the process (strict profile, no override). */
  fatal: boolean;
}

export interface ConfigValidationInput {
  environment: string;
  databaseUrl: string;
  redisUrl: string;
  queueProvider: string;
  encryptionKey: string;
  totpEncryptionKey: string;
  internalApiKey: string;
  cookieSecure: boolean;
  cookieSameSite: string;
  cookieName: string;
  allowedOrigins: string[];
  allowPrivateWebhookTargets: boolean;
  allowPrivateSsoEndpoints: boolean;
  allowInsecureWebhook: string;
  webhookSigningSecret: string;
  trustedProxies: string;
  allowDevDefaults: boolean;
  logLevel: string | undefined;
  authPublicUrl: string;
  otelEndpoint: string;
}

/**
 * Long enough to pass a length check but public: the value shipped in
 * `.env.example` and the k8s examples. Exported so the startup path and this
 * validator cannot disagree about what "placeholder" means.
 */
export const PLACEHOLDER_SECRET = "change-me-to-a-random-32-char-secret";

const MIN_SECRET_LENGTH = 32;

/** Build the validator's input from the live configuration snapshot. */
export function configValidationInput(): ConfigValidationInput {
  return {
    environment: config.NODE_ENV,
    databaseUrl: config.DATABASE_URL,
    redisUrl: config.REDIS_URL,
    queueProvider: config.KEYSTONE_QUEUE_PROVIDER,
    encryptionKey: config.KEYSTONE_ENCRYPTION_KEY,
    totpEncryptionKey: config.TOTP_ENCRYPTION_KEY,
    internalApiKey: config.INTERNAL_API_KEY,
    cookieSecure: config.COOKIE_SECURE,
    cookieSameSite: config.COOKIE_SAME_SITE,
    cookieName: config.COOKIE_NAME,
    allowedOrigins: config.ALLOWED_ORIGINS,
    allowPrivateWebhookTargets: config.ALLOW_PRIVATE_WEBHOOK_TARGETS,
    allowPrivateSsoEndpoints: config.ALLOW_PRIVATE_SSO_ENDPOINTS,
    allowInsecureWebhook: config.ALLOW_INSECURE_WEBHOOK,
    webhookSigningSecret: config.WEBHOOK_SIGNING_SECRET,
    trustedProxies: config.TRUSTED_PROXIES,
    allowDevDefaults: config.ALLOW_DEV_DEFAULTS,
    logLevel: config.LOG_LEVEL,
    authPublicUrl: config.AUTH_API_PUBLIC_URL,
    otelEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}

/**
 * The effective TOTP key, matching what `services/totp.ts` derives.
 *
 * Read through one helper so the validator cannot bless a key that the cipher
 * refuses, or vice versa.
 */
export function totpKeyOf(input: Pick<ConfigValidationInput, "totpEncryptionKey" | "internalApiKey">): string {
  return input.totpEncryptionKey || input.internalApiKey;
}

function isWeakSecret(value: string): boolean {
  return !value || value.length < MIN_SECRET_LENGTH || value === PLACEHOLDER_SECRET;
}

function isDebugLevel(level: string | undefined): boolean {
  return level === "debug" || level === "trace";
}

/**
 * Validate a configuration snapshot.
 *
 * Pure: no environment access, no logging, no side effects. The caller decides
 * what to do with `fatal`.
 */
export function validateConfiguration(input: ConfigValidationInput): ConfigValidationReport {
  const profile = resolveProfile(input.environment);
  const defaults = securityDefaults(profile);
  const findings: ConfigFinding[] = [];

  const add = (
    level: FindingLevel,
    code: string,
    message: string,
    hint?: string
  ): void => {
    findings.push({ level, code, message, ...(hint ? { hint } : {}) });
  };

  // Always reported, in every profile: silently treating an unknown environment
  // as development is how a typo becomes a production deployment with relaxed
  // defaults.
  if (!isKnownProfile(input.environment)) {
    add(
      "warning",
      "CONFIG_UNKNOWN_ENVIRONMENT",
      `NODE_ENV=${JSON.stringify(input.environment)} is not a known profile; it is treated as development.`,
      `Use one of: development, test, staging, production.`
    );
  }

  if (!defaults.productionLike) {
    // Development and test are not deployments. The one condition worth saying out
    // loud is a weak TOTP key, which the boot path already warned about, because
    // the database it writes to may later be pointed at production.
    if (profile === "development" && isWeakSecret(totpKeyOf(input))) {
      add(
        "warning",
        "CONFIG_WEAK_TOTP_KEY",
        "TOTP secrets are encrypted with the development default key.",
        "Set KEYSTONE_TOTP_ENCRYPTION_KEY (or a 32+ character KEYSTONE_INTERNAL_API_KEY) before this database is used by anything real."
      );
    }
    if (input.allowDevDefaults) {
      add(
        "info",
        "CONFIG_DEV_DEFAULTS_ENABLED",
        "KEYSTONE_ALLOW_DEV_DEFAULTS is enabled; production safety checks are bypassed when this profile becomes strict."
      );
    }
    add(
      "info",
      "CONFIG_PROFILE",
      `Profile ${profile}: production safety checks do not apply.`,
      undefined
    );
    return finish(profile, input.environment, findings, false);
  }

  // ---- Production-like: credential and transport posture --------------------

  if (!input.cookieSecure) {
    add(
      "error",
      "CONFIG_INSECURE_COOKIE",
      "COOKIE_SECURE is false — session cookies would travel in plaintext.",
      "Set COOKIE_SECURE=true. If this really is a development deployment, use a non-production NODE_ENV or KEYSTONE_ALLOW_DEV_DEFAULTS=true."
    );
  }

  if (isWeakSecret(totpKeyOf(input))) {
    add(
      "error",
      "CONFIG_WEAK_TOTP_KEY",
      "TOTP secrets would be encrypted with a missing, short, or publicly known key.",
      "Set KEYSTONE_TOTP_ENCRYPTION_KEY to a random secret of at least 32 characters."
    );
  }

  if (isWeakSecret(input.internalApiKey)) {
    add(
      "warning",
      "CONFIG_WEAK_INTERNAL_API_KEY",
      "KEYSTONE_INTERNAL_API_KEY is missing or shorter than 32 characters.",
      "It signs cookies and SAML relay state; SAML refuses to sign in production without it, and the cookie plugin falls back to unsigned cookies."
    );
  }

  if (!input.encryptionKey) {
    add(
      "warning",
      "CONFIG_MISSING_ENCRYPTION_KEY",
      "KEYSTONE_ENCRYPTION_KEY is not set: the JWT signing keypair in the secrets table is stored unwrapped.",
      "Set it so a database dump alone cannot mint tokens."
    );
  }

  if (input.allowDevDefaults) {
    add(
      "warning",
      "CONFIG_DEV_DEFAULTS_ENABLED",
      "KEYSTONE_ALLOW_DEV_DEFAULTS is enabled in a production-like profile; unsafe settings will not stop the process.",
      "Unset it once the configuration is correct."
    );
  }

  // ---- Queue / Redis --------------------------------------------------------

  if (input.queueProvider === "in-process") {
    if (defaults.inProcessQueueAllowed) {
      add(
        "warning",
        "CONFIG_IN_PROCESS_QUEUE",
        "KEYSTONE_QUEUE_PROVIDER is in-process: background work is not shared between instances and does not survive a restart.",
        "Set KEYSTONE_QUEUE_PROVIDER=bullmq and a reachable REDIS_URL before running more than one instance."
      );
    } else {
      add(
        "error",
        "CONFIG_IN_PROCESS_QUEUE",
        "KEYSTONE_QUEUE_PROVIDER is in-process in production: background work is not shared between instances and does not survive a restart.",
        "Set KEYSTONE_QUEUE_PROVIDER=bullmq and REDIS_URL. Override with KEYSTONE_ALLOW_DEV_DEFAULTS=true only for a deliberate single-process deployment."
      );
    }
  }

  if (!input.redisUrl) {
    add(
      "warning",
      "CONFIG_MISSING_REDIS",
      "REDIS_URL is empty: rate limiting falls back to per-instance state and the queue cannot be shared.",
      "Set REDIS_URL to a reachable Redis instance."
    );
  }

  // ---- Outbound policy ------------------------------------------------------

  if (input.allowInsecureWebhook) {
    add(
      "error",
      "CONFIG_INSECURE_WEBHOOK_ALLOWED",
      `KEYSTONE_ALLOW_INSECURE_WEBHOOK=${JSON.stringify(input.allowInsecureWebhook)} enables plaintext webhook delivery.`,
      "Unset it in production. The escape hatch only permits loopback in a non-production environment."
    );
  }

  if (input.allowPrivateWebhookTargets) {
    add(
      "warning",
      "CONFIG_PRIVATE_WEBHOOK_TARGETS",
      "ALLOW_PRIVATE_WEBHOOK_TARGETS is enabled: webhooks may reach loopback, private, link-local and metadata addresses.",
      "Unset it unless every webhook endpoint is operator-controlled."
    );
  }

  if (input.allowPrivateSsoEndpoints) {
    add(
      "warning",
      "CONFIG_PRIVATE_SSO_ENDPOINTS",
      "ALLOW_PRIVATE_SSO_ENDPOINTS is enabled: SSO and OIDC endpoints may reach private addresses.",
      "It also defaults ALLOW_PRIVATE_WEBHOOK_TARGETS to true, so it widens two surfaces."
    );
  }

  if (!input.webhookSigningSecret) {
    add(
      "warning",
      "CONFIG_UNSIGNED_WEBHOOKS",
      "WEBHOOK_SIGNING_SECRET is not set: webhook deliveries are sent without a signature.",
      "Consumers cannot then distinguish a Keystone event from anyone who learns the URL."
    );
  }

  // ---- HTTP surface ---------------------------------------------------------

  if (input.allowedOrigins.length === 0) {
    add(
      "warning",
      "CONFIG_EMPTY_CORS",
      "ALLOWED_ORIGINS is empty: every cross-origin request is refused.",
      "Set it to the exact origins that serve your frontend."
    );
  }

  if (input.cookieSameSite === "none") {
    add(
      "warning",
      "CONFIG_COOKIE_SAMESITE_NONE",
      "COOKIE_SAME_SITE=none permits the session cookie on cross-site requests.",
      "Use strict, or lax when a cross-site redirect must carry the session."
    );
  }

  if (!input.trustedProxies) {
    add(
      "warning",
      "CONFIG_UNTRUSTED_PROXY",
      "KEYSTONE_TRUSTED_PROXIES is not set: behind a reverse proxy every request appears to come from the proxy.",
      "Set it to the proxy's addresses so per-address limits and audit logs see the client."
    );
  }

  if (/^http:\/\//i.test(input.authPublicUrl)) {
    add(
      "warning",
      "CONFIG_HTTP_ISSUER",
      "AUTH_API_PUBLIC_URL is an http:// URL.",
      "It becomes the OIDC issuer and is embedded in discovery and tokens; clients may reject an http issuer."
    );
  }

  if (isDebugLevel(input.logLevel)) {
    add(
      "warning",
      "CONFIG_DEBUG_LOGGING",
      `Log level is ${input.logLevel} in a production-like profile.`,
      "Debug logs are larger, slower, and more likely to include request detail. Use info."
    );
  }

  if (input.otelEndpoint) {
    add(
      "info",
      "CONFIG_OTEL_ENABLED",
      "OpenTelemetry export is configured."
    );
  }

  add(
    "info",
    "CONFIG_PROFILE",
    `Profile ${profile}: ${findings.filter((f) => f.level === "error").length} error(s), ` +
      `${findings.filter((f) => f.level === "warning").length} warning(s).`
  );

  const fatal = defaults.strict && !input.allowDevDefaults && findings.some((f) => f.level === "error");
  return finish(profile, input.environment, findings, fatal);
}

function finish(
  profile: SecurityProfile,
  environment: string,
  findings: ConfigFinding[],
  fatal: boolean
): ConfigValidationReport {
  const order: Record<FindingLevel, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return {
    profile,
    environment,
    findings,
    errors: findings.filter((f) => f.level === "error"),
    warnings: findings.filter((f) => f.level === "warning"),
    fatal,
  };
}

/** One line per finding, for a CLI or a log line. */
export function formatFinding(finding: ConfigFinding): string {
  return `${finding.level.toUpperCase()} [${finding.code}] ${finding.message}${
    finding.hint ? ` — ${finding.hint}` : ""
  }`;
}

/**
 * Emit the report through a structured logger.
 *
 * `fatal` is used for error-level findings and only for them, so a log search for
 * `level=60` means "the process is about to refuse to start" rather than "some
 * check was unhappy".
 */
export function logConfigurationReport(
  report: ConfigValidationReport,
  log: { fatal: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void }
): void {
  for (const finding of report.findings) {
    const fields = { code: finding.code, profile: report.profile };
    if (finding.level === "error") log.fatal(fields, formatFinding(finding));
    else if (finding.level === "warning") log.warn(fields, formatFinding(finding));
    else log.info(fields, formatFinding(finding));
  }
}
