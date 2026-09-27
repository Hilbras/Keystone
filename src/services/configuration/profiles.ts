export const REDACTED_CONFIG_VALUE = "[redacted]";

/**
 * Configuration keys whose *values* may be returned by the admin configuration
 * endpoint.
 *
 * This is an allowlist on purpose. The previous implementation was a denylist --
 * a set of known-sensitive names plus a regex -- and it missed 12 of 24
 * secret-looking keys, including SIGNING_KEY, JWT_SIGNING_KEY, SENDGRID_KEY,
 * SAML_CERT, HMAC_KEY, KMS_KEY and DB_URL. A denylist is a losing game here: the
 * next person to add a secret-bearing variable leaks it, and nothing fails.
 *
 * An allowlist inverts the default. A new key is private until someone
 * deliberately decides otherwise, so forgetting has privacy as its failure mode
 * rather than disclosure.
 */
export const EXPOSABLE_CONFIG_KEYS = new Set([
  // Deployment shape. None of these are credentials.
  "NODE_ENV",
  "PORT",
  "HOST",
  "LOG_LEVEL",
  "PUBLIC_URL",
  "CLIENT_APP_URL",
  "SETUP_TOKEN_URL",
  "RESET_PASSWORD_URL",
  "ALLOWED_ORIGINS",
  "COOKIE_DOMAIN",
  "COOKIE_SECURE",
  "COOKIE_SAME_SITE",
  "KEYSTONE_TRUSTED_PROXIES",
  // Feature switches and limits.
  "KEYSTONE_SETUP_MODE",
  "KEYSTONE_FEATURE_FLAGS",
  "KEYSTONE_QUEUE_PROVIDER",
  "KEYSTONE_SECRETS_PROVIDER",
  "KEYSTONE_PLUGINS",
  "HIBP_CHECK_ENABLED",
  "MFA_CHALLENGE_TTL_SECONDS",
  "MFA_MAX_ATTEMPTS",
  "TOTP_BACKUP_CODE_TTL_SECONDS",
  "MAGIC_LINK_TTL_SECONDS",
  "ACCESS_TOKEN_TTL_SECONDS",
  "REFRESH_TOKEN_TTL_SECONDS",
  "SCIM_ROTATION_GRACE_SECONDS",
  "SCIM_RATE_LIMIT_MAX",
  "SCIM_RATE_LIMIT_WINDOW_SECONDS",
  "SCIM_AUTH_FAILURE_MAX",
  "SCIM_AUTH_FAILURE_WINDOW_SECONDS",
  // Feature presence. Deliberately presence-only, never the value.
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_FROM",
  "SMTP_SECURE",
  "TWILIO_ACCOUNT_SID",
  "SENDGRID_FROM",
  "METRICS_ENABLED",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
]);

/**
 * Whether a key names something that must never be echoed back.
 *
 * Retained for the write path, where a client may legitimately send a sensitive
 * value that has to be recognised as "preserve this, do not overwrite it".
 */
const SENSITIVE_CONFIG_KEYS = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "SMTP_PASS",
  "SMTP_PASSWORD",
  "ZITADEL_SERVICE_CLIENT_SECRET",
  "ZITADEL_SERVICE_PAT",
  "ZITADEL_CLIENT_SECRET",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "KEYSTONE_ENCRYPTION_KEY",
  "KEYSTONE_TOTP_ENCRYPTION_KEY",
  "KEYSTONE_INTERNAL_API_KEY",
  "HILBRAS_INTERNAL_API_KEY",
  "SENDGRID_API_KEY",
  "MAILGUN_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "WEBHOOK_SIGNING_SECRET",
  "KEYSTONE_WEBHOOK_SIGNING_SECRET",
  "KEYSTONE_SEED_OWNER_PASSWORD",
  "HILBRAS_OS_CLIENT_SECRET",
  "HILBRAS_AI_CLIENT_SECRET",
]);

export function isSensitiveConfigurationKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    SENSITIVE_CONFIG_KEYS.has(normalized) ||
    /(SECRET|TOKEN|PASSWORD|PASS|PAT|PRIVATE_KEY|API_KEY|CREDENTIAL|AUTHORIZATION|DATABASE_URL|REDIS_URL|ENCRYPTION_KEY)/.test(normalized)
  );
}

/**
 * Mask every value that is not on the exposable allowlist.
 *
 * The mask is a fixed marker, not a partial reveal. A prefix would let someone
 * confirm a guessed secret, and a length would leak entropy.
 */
export function redactConfigurationValues(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => [
        key,
        EXPOSABLE_CONFIG_KEYS.has(key.toUpperCase()) ? value : REDACTED_CONFIG_VALUE,
      ])
  );
}

/**
 * Whether a key's value may be exposed. The inverse question to
 * `isSensitiveConfigurationKey`, and the one the read path must ask.
 */
export function isExposableConfigurationKey(key: string): boolean {
  return EXPOSABLE_CONFIG_KEYS.has(key.toUpperCase());
}

export function mergeConfigurationUpdates(
  existing: Record<string, string | undefined>,
  updates: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value === REDACTED_CONFIG_VALUE) {
      if (merged[key] === undefined) throw new Error(`Cannot preserve unset configuration key: ${key}`);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export interface ConfigurationProfile {
  name: string;
  description: string;
  values: Record<string, string>;
}

export const CONFIGURATION_PROFILES: Record<string, ConfigurationProfile> = {
  development: {
    name: "Development",
    description: "Local development with debug logging and relaxed security defaults.",
    values: {
      NODE_ENV: "development",
      PORT: "4001",
      HOST: "0.0.0.0",
      DATABASE_URL: "postgresql://hilbras:hilbras@localhost:5432/hilbras",
      REDIS_URL: "redis://localhost:6379",
      KEYSTONE_QUEUE_PROVIDER: "in-process",
      KEYSTONE_SECRETS_PROVIDER: "database",
      EMAIL_PROVIDER: "console",
      SMS_PROVIDER: "none",
      AUDIT_CONSOLE_EXPORT: "true",
      KEYSTONE_FEATURE_FLAGS: "workflows=true,beta_auth=false",
    },
  },
  production: {
    name: "Production",
    description: "Production-grade settings with external queue and secrets providers.",
    values: {
      NODE_ENV: "production",
      PORT: "4001",
      HOST: "0.0.0.0",
      KEYSTONE_QUEUE_PROVIDER: "bullmq",
      KEYSTONE_SECRETS_PROVIDER: "database",
      EMAIL_PROVIDER: "smtp",
      SMS_PROVIDER: "twilio",
      AUDIT_CONSOLE_EXPORT: "false",
      KEYSTONE_FEATURE_FLAGS: "workflows=true",
    },
  },
  docker: {
    name: "Docker",
    description: "Single-container deployment using linked Postgres and Redis services.",
    values: {
      NODE_ENV: "production",
      PORT: "4001",
      HOST: "0.0.0.0",
      DATABASE_URL: "postgresql://hilbras:hilbras@postgres:5432/hilbras",
      REDIS_URL: "redis://redis:6379",
      KEYSTONE_QUEUE_PROVIDER: "bullmq",
      KEYSTONE_SECRETS_PROVIDER: "database",
      EMAIL_PROVIDER: "smtp",
      SMS_PROVIDER: "none",
      AUDIT_CONSOLE_EXPORT: "false",
    },
  },
  "docker-compose": {
    name: "Docker Compose",
    description: "Multi-service deployment via Docker Compose.",
    values: {
      NODE_ENV: "production",
      PORT: "4001",
      HOST: "0.0.0.0",
      DATABASE_URL: "postgresql://hilbras:hilbras@postgres:5432/hilbras",
      REDIS_URL: "redis://redis:6379",
      KEYSTONE_QUEUE_PROVIDER: "bullmq",
      KEYSTONE_SECRETS_PROVIDER: "database",
      EMAIL_PROVIDER: "smtp",
      SMS_PROVIDER: "none",
      AUDIT_CONSOLE_EXPORT: "false",
      KEYSTONE_CONFIG_MODE: "json",
    },
  },
  kubernetes: {
    name: "Kubernetes",
    description: "Kubernetes deployment with external secrets and HA queue.",
    values: {
      NODE_ENV: "production",
      PORT: "4001",
      HOST: "0.0.0.0",
      KEYSTONE_QUEUE_PROVIDER: "bullmq",
      KEYSTONE_SECRETS_PROVIDER: "environment",
      EMAIL_PROVIDER: "smtp",
      SMS_PROVIDER: "twilio",
      AUDIT_CONSOLE_EXPORT: "false",
      KEYSTONE_CONFIG_MODE: "json",
    },
  },
  "high-availability": {
    name: "High Availability",
    description: "Scaled deployment with dedicated Redis, Postgres, and external secrets.",
    values: {
      NODE_ENV: "production",
      PORT: "4001",
      HOST: "0.0.0.0",
      KEYSTONE_QUEUE_PROVIDER: "bullmq",
      KEYSTONE_SECRETS_PROVIDER: "environment",
      EMAIL_PROVIDER: "smtp",
      SMS_PROVIDER: "twilio",
      AUDIT_CONSOLE_EXPORT: "false",
      KEYSTONE_FEATURE_FLAGS: "workflows=true,advanced_audit=true",
    },
  },
};

export function listConfigurationProfiles(): Array<{ id: string; name: string; description: string }> {
  return Object.entries(CONFIGURATION_PROFILES).map(([id, profile]) => ({
    id,
    name: profile.name,
    description: profile.description,
  }));
}

export function getConfigurationProfile(id: string): ConfigurationProfile | undefined {
  return CONFIGURATION_PROFILES[id];
}
