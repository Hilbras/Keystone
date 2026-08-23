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
