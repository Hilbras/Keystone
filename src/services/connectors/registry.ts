import { config, isZitadelConfigured } from "../../config.js";
import { getConnectorFactory } from "../plugins/registry.js";
import type { IdentityConnector, ConnectorConfig } from "./types.js";
import { OidcConnector } from "./oidc.js";
import { GoogleConnector } from "./google.js";
import { ZitadelConnector } from "./zitadel.js";

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
  okta: {
    issuer: process.env.OKTA_ISSUER || "",
    authorizationEndpoint: process.env.OKTA_AUTHORIZATION_ENDPOINT || "",
    tokenEndpoint: process.env.OKTA_TOKEN_ENDPOINT || "",
    userinfoEndpoint: process.env.OKTA_USERINFO_ENDPOINT || "",
    jwksUri: process.env.OKTA_JWKS_URI || "",
  },
  keycloak: {
    issuer: process.env.KEYCLOAK_ISSUER || "",
    authorizationEndpoint: process.env.KEYCLOAK_AUTHORIZATION_ENDPOINT || "",
    tokenEndpoint: process.env.KEYCLOAK_TOKEN_ENDPOINT || "",
    userinfoEndpoint: process.env.KEYCLOAK_USERINFO_ENDPOINT || "",
    jwksUri: process.env.KEYCLOAK_JWKS_URI || "",
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
    if (!isZitadelConfigured()) {
      throw new Error("Zitadel connector is not configured. Set ZITADEL_DOMAIN and ZITADEL_CLIENT_ID.");
    }
    return new ZitadelConnector({
      issuer: config.ZITADEL_DOMAIN,
      clientId: config.ZITADEL_CLIENT_ID!,
      clientSecret: config.ZITADEL_CLIENT_SECRET || "",
      scopes: ["openid", "profile", "email"],
      ...overrides,
    });
  }

  const prefix = getProviderEnvPrefix(type);
  const envClientId = process.env[`${prefix}_CLIENT_ID`] || "";
  const envClientSecret = process.env[`${prefix}_CLIENT_SECRET`] || "";
  const envIssuer = process.env[`${prefix}_ISSUER`] || "";

  const wellKnown = wellKnownIssuers[type];
  if (!wellKnown && !envIssuer) {
    throw new Error(`${type} connector is not configured. Set ${prefix}_ISSUER, ${prefix}_CLIENT_ID, and ${prefix}_CLIENT_SECRET.`);
  }

  const cfg: ConnectorConfig = {
    issuer: envIssuer || wellKnown?.issuer,
    authorizationEndpoint: process.env[`${prefix}_AUTHORIZATION_ENDPOINT`] || wellKnown?.authorizationEndpoint,
    tokenEndpoint: process.env[`${prefix}_TOKEN_ENDPOINT`] || wellKnown?.tokenEndpoint,
    userinfoEndpoint: process.env[`${prefix}_USERINFO_ENDPOINT`] || wellKnown?.userinfoEndpoint,
    jwksUri: process.env[`${prefix}_JWKS_URI`] || wellKnown?.jwksUri,
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
      configured = Boolean(process.env.ZITADEL_DOMAIN && process.env.ZITADEL_CLIENT_ID);
    } else {
      configured = Boolean(
        process.env[`${prefix}_CLIENT_ID`] && process.env[`${prefix}_CLIENT_SECRET`]
      );
    }

    return { type, name: type.charAt(0).toUpperCase() + type.slice(1), configured };
  });
}
