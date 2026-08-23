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
}

export interface IdentityConnector {
  id: string;
  name: string;
  type: string;
  getAuthorizeUrl(opts: AuthorizeUrlOptions): string | Promise<string>;
  exchangeCode(code: string, redirectUri: string): Promise<ExternalIdentity>;
  verifyToken?(token: string): Promise<ExternalIdentity>;
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
