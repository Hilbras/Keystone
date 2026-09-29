import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdentityConnector, ExternalIdentity, AuthorizeUrlOptions, ConnectorConfig } from "./types.js";
import { normalizePayload } from "./oidc.js";
import { customFetch, fetchSsoEndpoint, safeJwksFetch } from "../ssoEndpointPolicy.js";

/**
 * Zitadel, as an OpenID Connect provider.
 *
 * This connector was the odd one out in two ways, and both are fixed here.
 *
 * **It read a global instead of its own configuration.** Every other connector
 * takes its endpoints from the `ConnectorConfig` it is constructed with; this one
 * called `zitadelBaseUrl()` and read `config.ZITADEL_DOMAIN`, so it could not be
 * pointed anywhere. That is not only untestable — it means a deployment using
 * Zitadel *and* any other provider has two connectors reading the same global
 * differently, and the Zitadel one cannot be configured per organization even
 * though `identity_providers` has a row per organization with its own issuer.
 *
 * **It did not bind the token to the request.** `getAuthorizeUrl` never sent a
 * `nonce`, `exchangeCode` accepted no options, and `verifyToken` took one
 * argument. The OIDC connector gained all three in 2.4.0 after SEC-020; Zitadel
 * never had them and, because no test drove a Zitadel exchange, nothing said so.
 * An ID token minted for a *different* Zitadel login verified correctly: issuer,
 * audience and signature are all still valid, and only the nonce proves the token
 * belongs to the request that started.
 *
 * It also pinned no algorithm and required no claims, so `alg` was whatever the
 * published JWKS happened to allow — the algorithm-confusion surface — and a
 * token with no `exp` would have been accepted forever.
 */
export class ZitadelConnector implements IdentityConnector {
  id = "zitadel";
  name = "Zitadel";
  type = "zitadel";
  private cfg: ConnectorConfig;
  private cachedJwksUrl: string | null = null;

  constructor(cfg: ConnectorConfig) {
    if (!cfg.issuer) throw new Error("Zitadel connector requires an issuer");
    this.cfg = cfg;
  }

  /**
   * The base URL, from this connector's own configuration.
   *
   * A bare hostname is accepted and given a scheme, which is how `ZITADEL_DOMAIN`
   * has always been documented. The result is cached because it is a pure
   * function of a value that cannot change for the life of the connector.
   */
  private baseUrl(): string {
    const issuer = this.cfg.issuer!.replace(/\/$/, "");
    return issuer.startsWith("http") ? issuer : `https://${issuer}`;
  }

  getAuthorizeUrl(opts: AuthorizeUrlOptions): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: opts.redirectUri,
      response_type: "code",
      scope: (opts.scopes ?? this.cfg.scopes ?? ["openid", "profile", "email"]).join(" "),
      state: opts.state,
    });
    if (opts.nonce) {
      params.set("nonce", opts.nonce);
    }
    if (this.cfg.idpHint) {
      params.set("idp_hint", this.cfg.idpHint);
    }
    return `${this.baseUrl()}/oauth/v2/authorize?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    opts: { nonce?: string } = {}
  ): Promise<ExternalIdentity> {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const res = await fetchSsoEndpoint(`${this.baseUrl()}/oauth/v2/token`, "tokenEndpoint", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zitadel token exchange failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { id_token: string };
    if (!data.id_token) {
      throw new Error("Zitadel provider did not return an id_token");
    }
    return this.verifyToken(data.id_token, opts.nonce);
  }

  async verifyToken(token: string, expectedNonce?: string): Promise<ExternalIdentity> {
    const jwksUrl = await this.getJwksUrl();
    const JWKS = createRemoteJWKSet(new URL(jwksUrl), { [customFetch]: safeJwksFetch });
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: this.baseUrl(),
      audience: this.cfg.clientId,
      // Pinned rather than taken from the key material, which is what leaves room
      // for an algorithm-confusion attempt. `none` is not in the list, so an
      // unsigned token cannot be presented as a signed one.
      algorithms: ["RS256", "ES256", "PS256"],
      // Required rather than merely validated when present: a token with no expiry
      // would otherwise be accepted forever, and Zitadel is an enterprise IdP
      // whose tokens are long-lived by design, so this is not hypothetical.
      requiredClaims: ["exp", "iat", "iss", "aud", "sub"],
      clockTolerance: 5,
    });

    if (expectedNonce) {
      const presented = typeof payload.nonce === "string" ? payload.nonce : undefined;
      if (presented !== expectedNonce) {
        throw new Error("Zitadel id_token nonce does not match the authorization request");
      }
    }

    return normalizePayload(payload as Record<string, unknown>, this.cfg.attributeMapping);
  }

  private async getJwksUrl(): Promise<string> {
    if (this.cachedJwksUrl) return this.cachedJwksUrl;
    const res = await fetchSsoEndpoint(
      `${this.baseUrl()}/.well-known/openid-configuration`,
      "issuer"
    );
    if (!res.ok) throw new Error(`Zitadel discovery failed: ${res.status}`);
    const discovery = (await res.json()) as Record<string, unknown>;
    this.cachedJwksUrl =
      (discovery.jwks_uri as string) || `${this.baseUrl()}/oauth/v2/keys`;
    return this.cachedJwksUrl;
  }
}
