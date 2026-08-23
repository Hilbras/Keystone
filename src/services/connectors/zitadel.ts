import { createRemoteJWKSet, jwtVerify } from "jose";
import { config, zitadelBaseUrl } from "../../config.js";
import type { IdentityConnector, ExternalIdentity, AuthorizeUrlOptions, ConnectorConfig } from "./types.js";
import { normalizePayload } from "./oidc.js";

export class ZitadelConnector implements IdentityConnector {
  id = "zitadel";
  name = "Zitadel";
  type = "zitadel";
  private cfg: ConnectorConfig;
  private cachedJwksUrl: string | null = null;

  constructor(cfg: ConnectorConfig) {
    this.cfg = cfg;
  }

  getAuthorizeUrl(opts: AuthorizeUrlOptions): string {
    const redirectUri = opts.redirectUri;
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: (opts.scopes ?? ["openid", "profile", "email"]).join(" "),
      state: opts.state,
    });
    if (this.cfg.idpHint) {
      params.set("idp_hint", this.cfg.idpHint);
    }
    return `${zitadelBaseUrl()}/oauth/v2/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ExternalIdentity> {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const res = await fetch(`${zitadelBaseUrl()}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zitadel token exchange failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { id_token: string };
    return this.verifyToken(data.id_token);
  }

  async verifyToken(token: string): Promise<ExternalIdentity> {
    const jwksUrl = await this.getJwksUrl();
    const JWKS = createRemoteJWKSet(new URL(jwksUrl));
    const issuer = config.ZITADEL_DOMAIN!.startsWith("http")
      ? config.ZITADEL_DOMAIN!
      : `https://${config.ZITADEL_DOMAIN!}`;
    const { payload } = await jwtVerify(token, JWKS, {
      issuer,
      audience: this.cfg.clientId,
    });
    return normalizePayload(payload as Record<string, unknown>, this.cfg.attributeMapping);
  }

  private async getJwksUrl(): Promise<string> {
    if (this.cachedJwksUrl) return this.cachedJwksUrl;
    const res = await fetch(`${zitadelBaseUrl()}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`Zitadel discovery failed: ${res.status}`);
    const discovery = (await res.json()) as Record<string, unknown>;
    this.cachedJwksUrl = (discovery.jwks_uri as string) || `${zitadelBaseUrl()}/oauth/v2/keys`;
    return this.cachedJwksUrl;
  }
}
