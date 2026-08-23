import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config();

function getEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
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

export const config = {
  NODE_ENV: getEnv("NODE_ENV", "development"),
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

  COOKIE_NAME: getEnv("COOKIE_NAME", "__Host-keystone-session"),
  COOKIE_DOMAIN: getEnv("COOKIE_DOMAIN", ".local.hilbras.ai"),
  COOKIE_SECURE: getEnv("COOKIE_SECURE", "false") === "true",
  COOKIE_SAME_SITE: getEnv("COOKIE_SAME_SITE", getEnv("NODE_ENV", "development") === "production" ? "strict" : "lax") as "strict" | "lax" | "none",

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
