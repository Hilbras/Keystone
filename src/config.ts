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
  // Kernel/container hostname set by the runtime, used for worker identity in
  // log lines — not the bind address above.
  HOSTNAME: getEnv("HOSTNAME", "local"),

  DATABASE_URL: requireEnvUnlessSetup("DATABASE_URL"),
  REDIS_URL: getEnv("REDIS_URL", "redis://localhost:6379"),
  /**
   * How long a single Redis command may take before it is abandoned (§8.1).
   *
   * ioredis has no command timeout by default. A Redis that is *slow* — the
   * socket is open, the server is answering, just later than it should — makes
   * every command wait forever, and the rate limiter is in front of every
   * request, so a degraded Redis takes the whole API down rather than just the
   * limiter. A dropped connection is a different failure: ioredis reconnects
   * and `maxRetriesPerRequest` eventually rejects. Only the slow case is
   * unbounded, and only a timeout closes it.
   *
   * One second is generous for a local Redis and short enough that the
   * emergency local limiter engages while the caller still has a request worth
   * serving.
   */
  REDIS_COMMAND_TIMEOUT_MS: Number(getEnv("KEYSTONE_REDIS_COMMAND_TIMEOUT_MS", "1000")),

  // Public application URLs. Registered here so routes and services read
  // `config.*` once instead of re-reading `process.env` per request — six route
  // files previously carried their own `process.env.CLIENT_APP_URL ||
  // "http://localhost:5173"` fallbacks, which drift from each other and from
  // whatever config is told at boot.
  CLIENT_APP_URL: getEnv("CLIENT_APP_URL", "http://localhost:5173"),
  RESET_PASSWORD_URL: getEnv("RESET_PASSWORD_URL"),

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

  // OIDC connector credentials and endpoint overrides, grouped by the provider
  // prefix `services/connectors/registry.ts` derives from the connector type
  // (e.g. `GOOGLE_CLIENT_ID` for type "google"). AZURE_CLIENT_ID and
  // AZURE_CLIENT_SECRET double as the Azure Key Vault credentials further down —
  // the env names are one Azure identity, not two settings.
  GOOGLE_CLIENT_ID: getEnv("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: getEnv("GOOGLE_CLIENT_SECRET"),
  GOOGLE_ISSUER: getEnv("GOOGLE_ISSUER"),
  GOOGLE_AUTHORIZATION_ENDPOINT: getEnv("GOOGLE_AUTHORIZATION_ENDPOINT"),
  GOOGLE_TOKEN_ENDPOINT: getEnv("GOOGLE_TOKEN_ENDPOINT"),
  GOOGLE_USERINFO_ENDPOINT: getEnv("GOOGLE_USERINFO_ENDPOINT"),
  GOOGLE_JWKS_URI: getEnv("GOOGLE_JWKS_URI"),
  GITHUB_CLIENT_ID: getEnv("GITHUB_CLIENT_ID"),
  GITHUB_CLIENT_SECRET: getEnv("GITHUB_CLIENT_SECRET"),
  GITHUB_ISSUER: getEnv("GITHUB_ISSUER"),
  GITHUB_AUTHORIZATION_ENDPOINT: getEnv("GITHUB_AUTHORIZATION_ENDPOINT"),
  GITHUB_TOKEN_ENDPOINT: getEnv("GITHUB_TOKEN_ENDPOINT"),
  GITHUB_USERINFO_ENDPOINT: getEnv("GITHUB_USERINFO_ENDPOINT"),
  GITHUB_JWKS_URI: getEnv("GITHUB_JWKS_URI"),
  AZURE_CLIENT_ID: getEnv("AZURE_CLIENT_ID"),
  AZURE_CLIENT_SECRET: getEnv("AZURE_CLIENT_SECRET"),
  AZURE_ISSUER: getEnv("AZURE_ISSUER"),
  AZURE_AUTHORIZATION_ENDPOINT: getEnv("AZURE_AUTHORIZATION_ENDPOINT"),
  AZURE_TOKEN_ENDPOINT: getEnv("AZURE_TOKEN_ENDPOINT"),
  AZURE_USERINFO_ENDPOINT: getEnv("AZURE_USERINFO_ENDPOINT"),
  AZURE_JWKS_URI: getEnv("AZURE_JWKS_URI"),
  OKTA_CLIENT_ID: getEnv("OKTA_CLIENT_ID"),
  OKTA_CLIENT_SECRET: getEnv("OKTA_CLIENT_SECRET"),
  OKTA_ISSUER: getEnv("OKTA_ISSUER"),
  OKTA_AUTHORIZATION_ENDPOINT: getEnv("OKTA_AUTHORIZATION_ENDPOINT"),
  OKTA_TOKEN_ENDPOINT: getEnv("OKTA_TOKEN_ENDPOINT"),
  OKTA_USERINFO_ENDPOINT: getEnv("OKTA_USERINFO_ENDPOINT"),
  OKTA_JWKS_URI: getEnv("OKTA_JWKS_URI"),
  KEYCLOAK_CLIENT_ID: getEnv("KEYCLOAK_CLIENT_ID"),
  KEYCLOAK_CLIENT_SECRET: getEnv("KEYCLOAK_CLIENT_SECRET"),
  KEYCLOAK_ISSUER: getEnv("KEYCLOAK_ISSUER"),
  KEYCLOAK_AUTHORIZATION_ENDPOINT: getEnv("KEYCLOAK_AUTHORIZATION_ENDPOINT"),
  KEYCLOAK_TOKEN_ENDPOINT: getEnv("KEYCLOAK_TOKEN_ENDPOINT"),
  KEYCLOAK_USERINFO_ENDPOINT: getEnv("KEYCLOAK_USERINFO_ENDPOINT"),
  KEYCLOAK_JWKS_URI: getEnv("KEYCLOAK_JWKS_URI"),

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
  /**
   * Permit a webhook to be delivered over plain HTTP (plan §1.2).
   *
   * Only the literal value `localhost` enables it, and only outside production,
   * and only to a loopback host. A webhook body carries an HMAC signature over
   * the payload — a credential — so sending it over plaintext puts that
   * credential into every proxy log and every hop between Keystone and the
   * consumer. A developer pointing a webhook at their own machine needs it;
   * nothing else does. Not a boolean, because "true" would read as "HTTP is
   * fine everywhere".
   */
  ALLOW_INSECURE_WEBHOOK: getEnv("KEYSTONE_ALLOW_INSECURE_WEBHOOK"),

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
  // External secrets backends, consumed by `services/secrets/*`. The Azure
  // client id/secret arrive with the connector keys above — one Azure identity
  // shared by both.
  VAULT_ADDR: getEnv("VAULT_ADDR"),
  VAULT_TOKEN: getEnv("VAULT_TOKEN"),
  VAULT_MOUNT_PATH: getEnv("VAULT_MOUNT_PATH") || "secret",
  AZURE_KEY_VAULT_URL: getEnv("AZURE_KEY_VAULT_URL"),
  AZURE_TENANT_ID: getEnv("AZURE_TENANT_ID"),
  KMS_KEY_ID: optionalString("KMS_KEY_ID"),

  // Queue provider: "in-process" (default/fallback), "bullmq", or "" to auto-select bullmq when REDIS_URL is set.
  KEYSTONE_QUEUE_PROVIDER: getEnv("KEYSTONE_QUEUE_PROVIDER", "in-process"),
  /**
   * Jobs one instance runs at once (§2.5).
   *
   * Was hardcoded to 5 inside the BullMQ driver. Concurrency is the main lever on how
   * much load one instance puts on its database and on every downstream HTTP
   * consumer, so an operator could not choose it — which in a multi-instance
   * deployment (§2.7) means capacity cannot be divided between instances at all.
   *
   * Clamped to at least 1, because `concurrency: 0` is silently accepted by BullMQ
   * and means *never process anything*: a worker that appears healthy and drains
   * nothing.
   */
  QUEUE_CONCURRENCY: Math.max(1, Number(getEnv("KEYSTONE_QUEUE_CONCURRENCY", "5")) || 5),

  // Cache key prefix for Redis/in-memory cache entries.
  CACHE_KEY_PREFIX: getEnv("CACHE_KEY_PREFIX", "keystone:"),

  // Comma-separated list of plugin module paths to load at startup.
  KEYSTONE_PLUGINS: getEnv("KEYSTONE_PLUGINS"),
  // Comma-separated `flag=value` pairs consumed by ConfigurationService.
  FEATURE_FLAGS: getEnv("KEYSTONE_FEATURE_FLAGS"),

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
  /**
   * Budget for `POST /v1/admin/organizations` — five per hour, per address.
   *
   * Configurable rather than written into the route because every other
   * limiter of its kind reads its budget from here, and a hardcoded one cannot
   * be raised by the suite that exercises it. The budget is keyed on the
   * client address, so it is shared by everything arriving from that address —
   * which in a test run is the whole suite.
   */
  ORG_CREATE_MAX_ATTEMPTS: Number(getEnv("ORG_CREATE_MAX_ATTEMPTS", "5")),
  ORG_CREATE_WINDOW_SECONDS: Number(getEnv("ORG_CREATE_WINDOW_SECONDS", "3600")),
  /**
   * Per-prefix budget for `POST /auth/refresh`. The route writes on every
   * attempt, so it gets its own named limiter instead of relying purely on the
   * global one — and a Redis outage must not unbound that write.
   */
  REFRESH_RATE_MAX: positiveInt("REFRESH_RATE_MAX", "120"),
  REFRESH_RATE_WINDOW: positiveInt("REFRESH_RATE_WINDOW", "60"),

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
  /**
   * Setup-wizard entrypoint: `index.ts` delegates to the standalone setup
   * server instead of booting the main application, which is what makes
   * `KEYSTONE_SETUP_MODE=true node dist/index.js` (the container entrypoint)
   * actually serve `/setup`.
   */
  SETUP_MODE: getEnv("KEYSTONE_SETUP_MODE", "false") === "true",
  /**
   * Escape hatch for a production boot with deliberately weak defaults — the
   * TOTP key guard in index.ts refuses to start without this set to true.
   */
  ALLOW_DEV_DEFAULTS: getEnv("KEYSTONE_ALLOW_DEV_DEFAULTS", "false") === "true",
  // Static setup token supplied through the environment; a token is generated
  // in-process when this is unset.
  SETUP_TOKEN: getEnv("KEYSTONE_SETUP_TOKEN"),
  /** Operator opt-in to print the setup token once; never honoured in production. */
  PRINT_SETUP_TOKEN: getEnv("KEYSTONE_PRINT_SETUP_TOKEN", "false") === "true",
  /** Where configuration is persisted: "json" or, when unset, the env file. */
  CONFIG_MODE: optionalString("KEYSTONE_CONFIG_MODE"),
  /**
   * §6.3. Deadline for the graceful-shutdown sequence.
   *
   * A dependency that never settles must not make a deploy hang until the
   * orchestrator SIGKILLs it. On expiry the process exits non-zero and names the
   * step it was on, so the next run has a diagnosis. Keep the orchestrator's grace
   * period longer than this; Kubernetes defaults to 30s.
   */
  SHUTDOWN_TIMEOUT_MS: positiveInt("KEYSTONE_SHUTDOWN_TIMEOUT_MS", "10000"),
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
  // Billing integration: "none" (default) registers no provider factory.
  BILLING_PROVIDER: getEnv("KEYSTONE_BILLING_PROVIDER") || "none",
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
