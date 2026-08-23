import { config as rawConfig } from "../config.js";

export interface RuntimeConfiguration {
  nodeEnv: string;
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  publicUrl?: string;
  cookieDomain?: string;
  cookieSecure: boolean;
  internalApiKey?: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  secretsProvider: "database" | "environment";
  queueProvider: "in-process" | "bullmq";
  hibpCheckEnabled: boolean;
  magicLinkTtlSeconds: number;
  oauthCodeTtlSeconds: number;
  totpIssuer: string;
  emailProvider: string;
  smsProvider: string;
  auditWebhookUrl?: string;
  auditConsoleExport: boolean;
  featureFlags: Record<string, boolean>;
  plugins: string[];
  allowedOrigins: string[];
  zitadel?: {
    domain?: string;
    orgId?: string;
    projectId?: string;
    serviceClientId?: string;
    serviceClientSecret?: string;
    servicePat?: string;
    clientId?: string;
    clientSecret?: string;
    googleIdpId?: string;
    githubIdpId?: string;
  };
}

export class ConfigurationService {
  private readonly values: RuntimeConfiguration;

  constructor(overrides: Partial<RuntimeConfiguration> = {}) {
    this.values = this.load(overrides);
  }

  private load(overrides: Partial<RuntimeConfiguration>): RuntimeConfiguration {
    const featureFlags = this.parseFeatureFlags(process.env.KEYSTONE_FEATURE_FLAGS);

    return {
      nodeEnv: rawConfig.NODE_ENV,
      port: rawConfig.PORT,
      host: rawConfig.HOST,
      databaseUrl: rawConfig.DATABASE_URL,
      redisUrl: rawConfig.REDIS_URL,
      publicUrl: rawConfig.AUTH_API_PUBLIC_URL,
      cookieDomain: rawConfig.COOKIE_DOMAIN,
      cookieSecure: rawConfig.COOKIE_SECURE,
      internalApiKey: rawConfig.INTERNAL_API_KEY,
      accessTokenTtlSeconds: rawConfig.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: rawConfig.REFRESH_TOKEN_TTL_SECONDS,
      secretsProvider: rawConfig.KEYSTONE_SECRETS_PROVIDER as RuntimeConfiguration["secretsProvider"],
      queueProvider: rawConfig.KEYSTONE_QUEUE_PROVIDER as RuntimeConfiguration["queueProvider"],
      hibpCheckEnabled: rawConfig.HIBP_CHECK_ENABLED,
      magicLinkTtlSeconds: rawConfig.MAGIC_LINK_TTL_SECONDS,
      oauthCodeTtlSeconds: rawConfig.OAUTH_CODE_TTL_SECONDS,
      totpIssuer: rawConfig.TOTP_ISSUER,
      emailProvider: rawConfig.EMAIL_PROVIDER,
      smsProvider: rawConfig.SMS_PROVIDER,
      auditWebhookUrl: rawConfig.AUDIT_WEBHOOK_URL,
      auditConsoleExport: rawConfig.AUDIT_CONSOLE_EXPORT === "true",
      featureFlags: { ...featureFlags, ...overrides.featureFlags },
      plugins: (rawConfig.KEYSTONE_PLUGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
      allowedOrigins: rawConfig.ALLOWED_ORIGINS,
      zitadel: {
        domain: rawConfig.ZITADEL_DOMAIN,
        orgId: rawConfig.ZITADEL_ORG_ID,
        projectId: rawConfig.ZITADEL_PROJECT_ID,
        serviceClientId: rawConfig.ZITADEL_SERVICE_CLIENT_ID,
        serviceClientSecret: rawConfig.ZITADEL_SERVICE_CLIENT_SECRET,
        servicePat: rawConfig.ZITADEL_SERVICE_PAT,
        clientId: rawConfig.ZITADEL_CLIENT_ID,
        clientSecret: rawConfig.ZITADEL_CLIENT_SECRET,
        googleIdpId: rawConfig.ZITADEL_GOOGLE_IDP_ID,
        githubIdpId: rawConfig.ZITADEL_GITHUB_IDP_ID,
      },
      ...overrides,
    };
  }

  private parseFeatureFlags(value?: string): Record<string, boolean> {
    if (!value) return {};
    const flags: Record<string, boolean> = {};
    for (const part of value.split(",")) {
      const [key, val] = part.trim().split("=");
      if (key) flags[key] = val === "true" || val === "1";
    }
    return flags;
  }

  get(): RuntimeConfiguration {
    return this.values;
  }

  getValue<K extends keyof RuntimeConfiguration>(key: K): RuntimeConfiguration[K] {
    return this.values[key];
  }

  isEnabled(flag: string): boolean {
    return this.values.featureFlags[flag] === true;
  }

  isProduction(): boolean {
    return this.values.nodeEnv === "production";
  }
}

export const configurationService = new ConfigurationService();
