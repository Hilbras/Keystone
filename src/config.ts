import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config();

function getEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

/**
 * Read a positive integer setting. A malformed or non-positive value would
 * otherwise silently break authentication (an MFA challenge budget of 0 makes
 * every login impossible), so fall back to the default and warn.
 */
function nonNegativeInt(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `[config] ${name} must be a non-negative integer (got ${JSON.stringify(raw)}); using ${fallback}`
    );
    return Number(fallback);
  }
  return parsed;
}

function positiveInt(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      `[config] ${name} must be a positive integer (got ${JSON.stringify(raw)}); using ${fallback}`
    );
    return Number(fallback);
  }
  return parsed;
}

function requireEnvUnlessSetup(name: string): string {
  const value = process.env[name];
  if (!value && process.env.KEYSTONE_SETUP_MODE !== "true") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value || "";
}

function getList(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** An environment variable that is genuinely optional: unset stays `undefined`. */
function optionalString(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

const cookieName = getEnv(
  "COOKIE_NAME",
  getEnv("NODE_ENV", "development") === "production" ? "__Host-keystone-session" : "keystone-session"
);
const isHostCookie = cookieName.startsWith("__Host-");

export const config = {
  NODE_ENV: getEnv("NODE_ENV", "development"),
  /**
   * Pino log level, when set.
   *
   * Exists for `npm run bench:hot`, which injects tens of thousands of requests
   * and spends more time serialising log lines than serving them — so the
   * benchmark was partly measuring its own logging. Unset everywhere else, and
   * the fallback below is unchanged, so this cannot alter any other context.
   */
  LOG_LEVEL: optionalString("KEYSTONE_LOG_LEVEL"),
  PORT: Number(getEnv("PORT", "4001")),
  HOST: getEnv("HOST", "0.0.0.0"),

  DATABASE_URL: requireEnvUnlessSetup("DATABASE_URL"),
  REDIS_URL: getEnv("REDIS_URL", "redis://localhost:6379"),

  // Zitadel is now an optional identity connector, not a hard dependency.
  ZITADEL_DOMAIN: getEnv("ZITADEL_DOMAIN"),
  ZITADEL_ORG_ID: getEnv("ZITADEL_ORG_ID"),
  ZITADEL_PROJECT_ID: getEnv("ZITADEL_PROJECT_ID"),

  // Service account used to call Zitadel management/user APIs.
  ZITADEL_SERVICE_CLIENT_ID: getEnv("ZITADEL_SERVICE_CLIENT_ID"),
  ZITADEL_SERVICE_CLIENT_SECRET: getEnv("ZITADEL_SERVICE_CLIENT_SECRET"),
  ZITADEL_SERVICE_PAT: getEnv("ZITADEL_SERVICE_PAT"),

  // Keystone OIDC app registered in Zitadel (for OAuth callbacks).
  ZITADEL_CLIENT_ID: getEnv("ZITADEL_CLIENT_ID"),
  ZITADEL_CLIENT_SECRET: getEnv("ZITADEL_CLIENT_SECRET"),

  // Optional IdP IDs to skip the Zitadel login selector and go straight to Google/GitHub.
  ZITADEL_GOOGLE_IDP_ID: getEnv("ZITADEL_GOOGLE_IDP_ID"),
  ZITADEL_GITHUB_IDP_ID: getEnv("ZITADEL_GITHUB_IDP_ID"),

  COOKIE_NAME: cookieName,
  COOKIE_DOMAIN: isHostCookie ? undefined : getEnv("COOKIE_DOMAIN", ".local.hilbras.ai"),
  // Secure by default in production. The previous default was "false", so an
  // operator who did not set it explicitly got session cookies without the
  // Secure attribute, which are then sent over plain HTTP. A __Host- prefixed
  // cookie name implies Secure and still wins; otherwise production defaults to
  // true and development to false, with an explicit override either way.
  COOKIE_SECURE:
    isHostCookie ||
    getEnv("COOKIE_SECURE", getEnv("NODE_ENV", "development") === "production" ? "true" : "false") === "true",
  COOKIE_SAME_SITE: getEnv("COOKIE_SAME_SITE", getEnv("NODE_ENV", "development") === "production" ? "strict" : "lax") as "strict" | "lax" | "none",
  ALLOW_PRIVATE_SSO_ENDPOINTS: getEnv("ALLOW_PRIVATE_SSO_ENDPOINTS", "false") === "true",
  /**
   * Permit a webhook to target a loopback or private address.
   *
   * Separate from `ALLOW_PRIVATE_SSO_ENDPOINTS` because that flag also disables
   * DNS resolution and address pinning, which a developer's `http://localhost:3000`
   * does not need switched off. A webhook pointing at `169.254.169.254` does.
   *
   * Defaults to the SSO flag so an existing development setup that already
   * opted out keeps working and there is one decision to make, not two. It is a
   * development and test affordance: in production both default to `false`.
   */
  ALLOW_PRIVATE_WEBHOOK_TARGETS: getEnv(
    "ALLOW_PRIVATE_WEBHOOK_TARGETS",
    getEnv("ALLOW_PRIVATE_SSO_ENDPOINTS", "false")
  ) === "true",

  AUTH_API_PUBLIC_URL: getEnv("AUTH_API_PUBLIC_URL"),
  ACCESS_TOKEN_TTL_SECONDS: Number(getEnv("JWT_ACCESS_TOKEN_TTL", "900")),
  REFRESH_TOKEN_TTL_SECONDS: Number(getEnv("JWT_REFRESH_TOKEN_TTL", "604800")),

  // RSA PEM keys. If not provided, a new key pair is generated at startup (dev only).
  JWT_PRIVATE_KEY: getEnv("JWT_PRIVATE_KEY"),
  JWT_PUBLIC_KEY: getEnv("JWT_PUBLIC_KEY"),

  // Optional master encryption key. If omitted, a random key is stored in the secrets table (dev only).
  KEYSTONE_ENCRYPTION_KEY: getEnv("KEYSTONE_ENCRYPTION_KEY"),

  // Secrets provider: "database" (default) or "environment".
  KEYSTONE_SECRETS_PROVIDER: getEnv("KEYSTONE_SECRETS_PROVIDER", "database"),

  // Queue provider: "in-process" (default/fallback), "bullmq", or "" to auto-select bullmq when REDIS_URL is set.
  KEYSTONE_QUEUE_PROVIDER: getEnv("KEYSTONE_QUEUE_PROVIDER", "in-process"),

  // Cache key prefix for Redis/in-memory cache entries.
  CACHE_KEY_PREFIX: getEnv("CACHE_KEY_PREFIX", "keystone:"),

  // Comma-separated list of plugin module paths to load at startup.
  KEYSTONE_PLUGINS: getEnv("KEYSTONE_PLUGINS"),

  INTERNAL_API_KEY: getEnv("KEYSTONE_INTERNAL_API_KEY") || getEnv("HILBRAS_INTERNAL_API_KEY", ""),

  SEED_OWNER_EMAIL: getEnv("KEYSTONE_SEED_OWNER_EMAIL"),

  ALLOWED_ORIGINS: getList("ALLOWED_ORIGINS"),

  RATE_LIMIT_ATTEMPTS: Number(getEnv("RATE_LIMIT_ATTEMPTS", "5")),
  RATE_LIMIT_WINDOW_SECONDS: Number(getEnv("RATE_LIMIT_WINDOW_SECONDS", "900")),
  /**
   * Budgets for `POST /auth/login` and `POST /auth/token-login`.
   *
   * Configurable because they now have to be. Until 3.2.0 the per-address budget
   * was not enforced (SEC-047) and the submitted address was part of its key
   * (SEC-048), so the numbers were decorative: raising them appeared to do nothing
   * and lowering them broke nothing. Both are fixed, so the numbers are real, and
   * a deployment legitimately needs to set them — a NAT, a corporate proxy, or a
   * large tenant on one egress address.
   *
   * The per-account budget is deliberately much tighter than the per-address one.
   * The address budget exists to bound spraying across many accounts, which is
   * cheap for an attacker and expensive for a legitimate user who fat-fingers a
   * password a few times; the account budget exists to stop guessing one account,
   * which is what password reuse turns into a breach elsewhere.
   */
  LOGIN_MAX_ATTEMPTS: positiveInt("LOGIN_MAX_ATTEMPTS", "5"),
  LOGIN_PER_ADDRESS_MAX: positiveInt("LOGIN_PER_ADDRESS_MAX", "30"),
  LOGIN_WINDOW_SECONDS: positiveInt("LOGIN_WINDOW_SECONDS", "900"),
  GLOBAL_RATE_LIMIT_MAX: Number(getEnv("GLOBAL_RATE_LIMIT_MAX", "100")),
  GLOBAL_RATE_LIMIT_WINDOW: Number(getEnv("GLOBAL_RATE_LIMIT_WINDOW", "60")),

  ACCOUNT_LOCKOUT_THRESHOLD: Number(getEnv("ACCOUNT_LOCKOUT_THRESHOLD", "5")),
  ACCOUNT_LOCKOUT_DURATION_SECONDS: Number(getEnv("ACCOUNT_LOCKOUT_DURATION_SECONDS", "1800")),

  HIBP_CHECK_ENABLED: getEnv("HIBP_CHECK_ENABLED", "false") === "true",
  // When true, new registrations start unverified and a verification email
  // is sent automatically; login still works but emailVerified stays false
  // until the user clicks the link.
  EMAIL_VERIFICATION_REQUIRED: getEnv("EMAIL_VERIFICATION_REQUIRED", "false") === "true",
  MAGIC_LINK_TTL_SECONDS: Number(getEnv("MAGIC_LINK_TTL_SECONDS", "900")),
  OAUTH_CODE_TTL_SECONDS: Number(getEnv("OAUTH_CODE_TTL_SECONDS", "60")),
  TOTP_ISSUER: getEnv("TOTP_ISSUER", "Hilbras"),
  TOTP_ENCRYPTION_KEY: getEnv("KEYSTONE_TOTP_ENCRYPTION_KEY"),
  // SCIM. `SCIM_BEARER_TOKEN` / `SCIM_ORG_ID` are legacy: they are read once at
  // startup to create a per-organization connection, then superseded by the
  // connection API. New deployments should use the connection API only.
  SCIM_BEARER_TOKEN: getEnv("SCIM_BEARER_TOKEN"),
  SCIM_ORG_ID: getEnv("SCIM_ORG_ID"),
  /** How long a rotated-out SCIM token keeps working. */
  // Default 0: rotating in response to a leak must not leave the old token
  // working for a day. A grace window is an explicit, audited opt-in.
  SCIM_ROTATION_GRACE_SECONDS: nonNegativeInt("SCIM_ROTATION_GRACE_SECONDS", "0"),
  /** Rate limit applied to every SCIM request, keyed by credential. */
  SCIM_RATE_LIMIT_MAX: positiveInt("SCIM_RATE_LIMIT_MAX", "600"),
  SCIM_RATE_LIMIT_WINDOW_SECONDS: positiveInt("SCIM_RATE_LIMIT_WINDOW_SECONDS", "60"),
  /** Budget for unauthenticated SCIM requests, which run before the credential limiter. */
  SCIM_AUTH_FAILURE_MAX: positiveInt("SCIM_AUTH_FAILURE_MAX", "60"),
  SCIM_AUTH_FAILURE_WINDOW_SECONDS: positiveInt("SCIM_AUTH_FAILURE_WINDOW_SECONDS", "60"),
  /**
   * Comma-separated IP addresses and CIDR ranges of reverse proxies allowed to
   * set client-identity headers (`x-forwarded-for`, `x-forwarded-client-cert`,
   * ...). Empty means trust nothing: the peer address is used and those headers
   * are stripped. Set this only when Keystone genuinely sits behind a proxy you
   * control — an over-broad value lets any client behind it forge an identity.
   */
  TRUSTED_PROXIES: getEnv("KEYSTONE_TRUSTED_PROXIES"),
  MFA_CHALLENGE_TTL_SECONDS: positiveInt("MFA_CHALLENGE_TTL_SECONDS", "300"),
  MFA_MAX_ATTEMPTS: positiveInt("MFA_MAX_ATTEMPTS", "5"),
  TOTP_BACKUP_CODE_TTL_SECONDS: positiveInt("TOTP_BACKUP_CODE_TTL_SECONDS", "7776000"),
  EMAIL_PROVIDER: getEnv("EMAIL_PROVIDER", "none"),
  EMAIL_FROM: getEnv("EMAIL_FROM", "keystone@local.hilbras.ai"),
  SMTP_HOST: getEnv("SMTP_HOST"),
  SMTP_PORT: Number(getEnv("SMTP_PORT", "587")),
  SMTP_USER: getEnv("SMTP_USER"),
  SMTP_PASS: getEnv("SMTP_PASS"),
  SMTP_SECURE: getEnv("SMTP_SECURE", "false") === "true",
  SENDGRID_API_KEY: getEnv("SENDGRID_API_KEY"),
  MAILGUN_API_KEY: getEnv("MAILGUN_API_KEY"),
  MAILGUN_DOMAIN: getEnv("MAILGUN_DOMAIN"),
  SMS_PROVIDER: getEnv("SMS_PROVIDER", "none"),
  TWILIO_ACCOUNT_SID: getEnv("TWILIO_ACCOUNT_SID"),
  TWILIO_AUTH_TOKEN: getEnv("TWILIO_AUTH_TOKEN"),
  TWILIO_FROM_NUMBER: getEnv("TWILIO_FROM_NUMBER"),
  TWILIO_MESSAGING_SERVICE_SID: getEnv("TWILIO_MESSAGING_SERVICE_SID"),
  OTEL_EXPORTER_OTLP_ENDPOINT: getEnv("OTEL_EXPORTER_OTLP_ENDPOINT"),
  AUDIT_WEBHOOK_URL: getEnv("AUDIT_WEBHOOK_URL"),
  AUDIT_CONSOLE_EXPORT: getEnv("AUDIT_CONSOLE_EXPORT", "false"),
  WEBHOOK_SIGNING_SECRET: getEnv("WEBHOOK_SIGNING_SECRET") || getEnv("KEYSTONE_WEBHOOK_SIGNING_SECRET"),
  /**
   * Persist a truncated copy of a webhook consumer's response body.
   *
   * **Off by default, and the default is the fix.** SEC-079: the delivery row
   * used to store the first 2000 bytes of whatever the consumer returned, and
   * `GET /platform/webhook-deliveries/:id` serves it back. The consumer is a third
   * party, so that content belongs to it, not to a table this project backs up
   * and replicates.
   *
   * On, the stored value keeps a 512-byte redacted prefix *and says so in the
   * value itself* (`body(captured): …`), so a row cannot be mistaken for a
   * default-mode summary. For debugging a consumer you control, and only then.
   */
  WEBHOOK_DEBUG_CAPTURE_BODY: getEnv("WEBHOOK_DEBUG_CAPTURE_BODY", "false") === "true",
} as const;

export function zitadelBaseUrl(): string {
  if (!config.ZITADEL_DOMAIN) {
    throw new Error("Zitadel is not configured");
  }
  const domain = config.ZITADEL_DOMAIN.replace(/\/$/, "");
  return domain.startsWith("http") ? domain : `https://${domain}`;
}

export function isZitadelConfigured(): boolean {
  return Boolean(config.ZITADEL_DOMAIN && config.ZITADEL_CLIENT_ID);
}
