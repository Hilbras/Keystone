export interface ExternalIdentity {
  sub: string;
  email: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  username?: string;
  raw?: Record<string, unknown>;
}

export interface AuthorizeUrlOptions {
  state: string;
  redirectUri: string;
  scopes?: string[];
  extraParams?: Record<string, string>;
  /**
   * Binds the ID token to this authorization request. The connector sends it to
   * the provider and the returned ID token must carry the same value.
   */
  nonce?: string;
}

export interface IdentityConnector {
  id: string;
  name: string;
  type: string;
  getAuthorizeUrl(opts: AuthorizeUrlOptions): string | Promise<string>;
  /**
   * `nonce` is the value sent in the authorization request. When supplied, the
   * returned ID token must carry it, which is what binds the token to this
   * login attempt rather than to any other.
   */
  exchangeCode(code: string, redirectUri: string, opts?: { nonce?: string }): Promise<ExternalIdentity>;
  /**
   * Verify an ID token.
   *
   * `expectedNonce` is the value sent in the authorization request. When supplied,
   * the token must carry it — that is what binds the token to this login attempt
   * rather than to any other, and it is the parameter's absence from this
   * signature that let one connector ship without nonce verification for years
   * while the others were fixed (SEC-052).
   */
  verifyToken?(token: string, expectedNonce?: string): Promise<ExternalIdentity>;
}

export interface ConnectorConfig {
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  idpHint?: string;
  attributeMapping?: Record<string, string>;
}
