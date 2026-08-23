import { buildConnector } from "./connectors/registry.js";
import { upsertOAuthUser } from "./users.js";
import { createTokenSet } from "./tokens.js";
import type { User } from "../db/schema.js";
import type { IdentityConnector } from "./connectors/types.js";

export function getFederationConnector(providerType: string): IdentityConnector {
  return buildConnector(providerType);
}

export async function getFederationAuthorizeUrl(providerType: string, state: string, redirectUri: string): Promise<string> {
  const connector = getFederationConnector(providerType);
  return connector.getAuthorizeUrl({
    state,
    redirectUri,
    scopes: ["openid", "profile", "email"],
  });
}

export async function completeFederationLogin(
  providerType: string,
  code: string,
  redirectUri: string
): Promise<{ user: User; tokens: { accessToken: string; refreshToken: string } }> {
  const connector = getFederationConnector(providerType);
  const identity = await connector.exchangeCode(code, redirectUri);
  const user = await upsertOAuthUser(identity, providerType);
  const tokens = await createTokenSet(user);
  return { user, tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } };
}
