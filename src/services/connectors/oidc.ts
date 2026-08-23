import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdentityConnector, ExternalIdentity, AuthorizeUrlOptions, ConnectorConfig } from "./types.js";
import { cache } from "../cache.js";

export class OidcConnector implements IdentityConnector {
  id: string;
  name: string;
  type: string;
  protected config: ConnectorConfig;

  constructor(id: string, name: string, type: string, config: ConnectorConfig) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.config = config;
  }

  getAuthorizeUrl(opts: AuthorizeUrlOptions): string {
    const scopes = opts.scopes ?? this.config.scopes ?? ["openid", "profile", "email"];
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: opts.redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state: opts.state,
    });
    if (this.config.idpHint) {
      params.set("idp_hint", this.config.idpHint);
    }
    if (opts.extraParams) {
      for (const [k, v] of Object.entries(opts.extraParams)) {
        params.set(k, v);
      }
    }
    return `${this.config.authorizationEndpoint}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<ExternalIdentity> {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const res = await fetch(this.config.tokenEndpoint!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OIDC token exchange failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { id_token: string; access_token?: string };
    if (!data.id_token) {
      throw new Error("OIDC provider did not return an id_token");
    }
    return this.verifyToken(data.id_token);
  }

  async verifyToken(token: string): Promise<ExternalIdentity> {
    const jwksUrl = this.config.jwksUri || ((await this.discovery())?.jwks_uri as string);
    if (!jwksUrl) {
      throw new Error("OIDC connector missing jwks_uri");
    }
    const JWKS = createRemoteJWKSet(new URL(jwksUrl));
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: this.config.issuer,
      audience: this.config.clientId,
    });
    return normalizePayload(payload as Record<string, unknown>, this.config.attributeMapping);
  }

  private async discovery(): Promise<Record<string, unknown>> {
    if (!this.config.issuer) throw new Error("OIDC connector missing issuer for discovery");
    const key = `oidc:discovery:${this.config.issuer}`;
    const cached = await cache.get<Record<string, unknown>>(key);
    if (cached) return cached;

    const res = await fetch(`${this.config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    await cache.set(key, data, 3600);
    return data;
  }
}

export function normalizePayload(
  payload: Record<string, unknown>,
  mapping?: Record<string, string>
): ExternalIdentity {
  const m = mapping ?? {};
  const get = (key: string): unknown => payload[m[key] || key];
  const email = String(get("email") || "");
  if (!email) {
    throw new Error("Identity provider did not return an email address");
  }
  return {
    sub: String(get("sub") || ""),
    email,
    emailVerified: get("email_verified") === true,
    name: get("name") ? String(get("name")) : undefined,
    picture: get("picture") ? String(get("picture")) : undefined,
    username: get("preferred_username") ? String(get("preferred_username")) : undefined,
    raw: payload,
  };
}
