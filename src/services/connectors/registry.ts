import { config } from "../../config.js";
import { getConnectorFactory } from "../plugins/registry.js";
import type { IdentityConnector, ConnectorConfig } from "./types.js";
import { OidcConnector } from "./oidc.js";
import { GoogleConnector } from "./google.js";
import { ZitadelConnector } from "./zitadel.js";

type ConnectorEnv = {
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  jwksUri: string;
};

/**
 * Per-prefix connector credentials and endpoint overrides, read once through
 * `config` instead of `process.env` per call. Keys are the `${prefix}_...`
 * names derived from the connector type (`type.toUpperCase()`).
 */
const connectorEnvByPrefix: Record<string, ConnectorEnv> = {
  GOOGLE: {
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    issuer: config.GOOGLE_ISSUER,
    authorizationEndpoint: config.GOOGLE_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: config.GOOGLE_TOKEN_ENDPOINT,
    userinfoEndpoint: config.GOOGLE_USERINFO_ENDPOINT,
    jwksUri: config.GOOGLE_JWKS_URI,
  },
  GITHUB: {
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
    issuer: config.GITHUB_ISSUER,
    authorizationEndpoint: config.GITHUB_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: config.GITHUB_TOKEN_ENDPOINT,
    userinfoEndpoint: config.GITHUB_USERINFO_ENDPOINT,
    jwksUri: config.GITHUB_JWKS_URI,
  },
  AZURE: {
    clientId: config.AZURE_CLIENT_ID,
    clientSecret: config.AZURE_CLIENT_SECRET,
    issuer: config.AZURE_ISSUER,
    authorizationEndpoint: config.AZURE_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: config.AZURE_TOKEN_ENDPOINT,
    userinfoEndpoint: config.AZURE_USERINFO_ENDPOINT,
    jwksUri: config.AZURE_JWKS_URI,
  },
  OKTA: {
    clientId: config.OKTA_CLIENT_ID,
    clientSecret: config.OKTA_CLIENT_SECRET,
    issuer: config.OKTA_ISSUER,
    authorizationEndpoint: config.OKTA_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: config.OKTA_TOKEN_ENDPOINT,
    userinfoEndpoint: config.OKTA_USERINFO_ENDPOINT,
    jwksUri: config.OKTA_JWKS_URI,
  },
  KEYCLOAK: {
    clientId: config.KEYCLOAK_CLIENT_ID,
    clientSecret: config.KEYCLOAK_CLIENT_SECRET,
    issuer: config.KEYCLOAK_ISSUER,
    authorizationEndpoint: config.KEYCLOAK_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: config.KEYCLOAK_TOKEN_ENDPOINT,
    userinfoEndpoint: config.KEYCLOAK_USERINFO_ENDPOINT,
    jwksUri: config.KEYCLOAK_JWKS_URI,
  },
};

const wellKnownIssuers: Record<string, { issuer: string; authorizationEndpoint?: string; tokenEndpoint?: string; userinfoEndpoint?: string; jwksUri?: string }> = {
  google: {
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
  },
  github: {
    issuer: "https://github.com",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    userinfoEndpoint: "https://api.github.com/user",
  },
  azure: {
    issuer: "https://login.microsoftonline.com/common/v2.0",
    authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfoEndpoint: "https://graph.microsoft.com/oidc/userinfo",
    jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
  },
  // Okta and Keycloak have no vendor-wide defaults: the issuer and endpoints
  // exist only as deployment-specific configuration, so they fall back to "" and
  // the not-configured errors below stay pointed at the right variables.
  okta: {
    issuer: connectorEnvByPrefix.OKTA.issuer,
    authorizationEndpoint: connectorEnvByPrefix.OKTA.authorizationEndpoint,
    tokenEndpoint: connectorEnvByPrefix.OKTA.tokenEndpoint,
    userinfoEndpoint: connectorEnvByPrefix.OKTA.userinfoEndpoint,
    jwksUri: connectorEnvByPrefix.OKTA.jwksUri,
  },
  keycloak: {
    issuer: connectorEnvByPrefix.KEYCLOAK.issuer,
    authorizationEndpoint: connectorEnvByPrefix.KEYCLOAK.authorizationEndpoint,
    tokenEndpoint: connectorEnvByPrefix.KEYCLOAK.tokenEndpoint,
    userinfoEndpoint: connectorEnvByPrefix.KEYCLOAK.userinfoEndpoint,
    jwksUri: connectorEnvByPrefix.KEYCLOAK.jwksUri,
  },
};

function getProviderEnvPrefix(type: string): string {
  return type.toUpperCase();
}

export function buildConnector(type: string, overrides?: Partial<ConnectorConfig>): IdentityConnector {
  const pluginFactory = getConnectorFactory(type);
  if (pluginFactory) {
    return pluginFactory(overrides);
  }

  if (type === "zitadel") {
    // The overrides are merged *after* the environment, so a caller that supplies
    // an issuer wins — which is what makes this connector constructible for a
    // per-organization `identity_providers` row rather than only from the global
    // ZITADEL_DOMAIN. It used to ignore `overrides` entirely and read the global,
    // so it could not be pointed anywhere but the one deployment (SEC-052).
    const issuer = overrides?.issuer ?? config.ZITADEL_DOMAIN;
    if (!issuer) {
      throw new Error("Zitadel connector is not configured. Set ZITADEL_DOMAIN, or pass an issuer.");
    }
    return new ZitadelConnector({
      clientId: config.ZITADEL_CLIENT_ID || "",
      clientSecret: config.ZITADEL_CLIENT_SECRET || "",
      scopes: ["openid", "profile", "email"],
      ...overrides,
      issuer,
    });
  }

  const prefix = getProviderEnvPrefix(type);
  const env = connectorEnvByPrefix[prefix];
  const envClientId = env?.clientId || "";
  const envClientSecret = env?.clientSecret || "";
  const envIssuer = env?.issuer || "";

  const wellKnown = wellKnownIssuers[type];
  if (!wellKnown && !envIssuer) {
    throw new Error(`${type} connector is not configured. Set ${prefix}_ISSUER, ${prefix}_CLIENT_ID, and ${prefix}_CLIENT_SECRET.`);
  }

  const cfg: ConnectorConfig = {
    issuer: envIssuer || wellKnown?.issuer,
    authorizationEndpoint: env?.authorizationEndpoint || wellKnown?.authorizationEndpoint,
    tokenEndpoint: env?.tokenEndpoint || wellKnown?.tokenEndpoint,
    userinfoEndpoint: env?.userinfoEndpoint || wellKnown?.userinfoEndpoint,
    jwksUri: env?.jwksUri || wellKnown?.jwksUri,
    clientId: envClientId || overrides?.clientId || "",
    clientSecret: envClientSecret || overrides?.clientSecret || "",
    scopes: ["openid", "profile", "email"],
    ...overrides,
  };

  if (!cfg.clientId || !cfg.clientSecret || !cfg.issuer) {
    throw new Error(`${type} connector is not fully configured. Set ${prefix}_CLIENT_ID, ${prefix}_CLIENT_SECRET, and ${prefix}_ISSUER.`);
  }

  if (type === "google") {
    return new GoogleConnector(type, type, type, cfg);
  }

  return new OidcConnector(type, type, type, cfg);
}

export function listSupportedProviders(): string[] {
  return ["zitadel", "google", "github", "azure", "okta", "keycloak"];
}

/**
 * Returns supported providers annotated with whether they are currently
 * configured with client credentials in the environment.
 */
export function listConfiguredProviders(): Array<{ type: string; name: string; configured: boolean }> {
  return listSupportedProviders().map((type) => {
    const prefix = type.toUpperCase();
    let configured = false;

    if (type === "zitadel") {
      configured = Boolean(config.ZITADEL_DOMAIN && config.ZITADEL_CLIENT_ID);
    } else {
      const env = connectorEnvByPrefix[prefix];
      configured = Boolean(env?.clientId && env?.clientSecret);
    }

    return { type, name: type.charAt(0).toUpperCase() + type.slice(1), configured };
  });
}
