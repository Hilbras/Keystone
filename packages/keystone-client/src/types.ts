/**
 * Response shapes the server actually returns.
 *
 * Keystone responses carry domain-specific fields this package does not enumerate
 * (organisation plans, application branding, audit metadata). Each interface has an
 * index signature so those fields remain visible rather than being silently dropped
 * from the type, while the fields clients branch on are named.
 */

export type JsonObject = Record<string, unknown>;

export interface PublicUser {
  id: string;
  email: string;
  username?: string;
  name?: string | null;
  role?: string;
  platformRole?: string | null;
  mfaEnabled?: boolean;
  [key: string]: unknown;
}

export interface Session {
  id: string;
  createdAt?: string;
  expiresAt?: string;
  ip?: string | null;
  userAgent?: string | null;
  [key: string]: unknown;
}

export interface ApiKey {
  id: string;
  name?: string;
  prefix?: string;
  scopes?: string[];
  createdAt?: string;
  [key: string]: unknown;
}

export interface Organization {
  id: string;
  name: string;
  slug?: string | null;
  plan?: string | null;
  [key: string]: unknown;
}

export interface Application {
  id: string;
  name?: string;
  clientId?: string;
  clientType?: string;
  isActive?: boolean;
  [key: string]: unknown;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events?: string[];
  isActive?: boolean;
  [key: string]: unknown;
}

export interface WebhookDelivery {
  id: string;
  endpointId?: string;
  status?: string;
  attempts?: number;
  [key: string]: unknown;
}

export interface AuditLog {
  id: string;
  event: string;
  userId?: string | null;
  orgId?: string | null;
  createdAt?: string;
  [key: string]: unknown;
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description?: string | null;
  [key: string]: unknown;
}

export interface HealthCheck {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
  [key: string]: unknown;
}

export interface HealthReport {
  status: string;
  checks?: Record<string, HealthCheck>;
  [key: string]: unknown;
}

export interface LoginResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  factor?: string;
  user?: PublicUser;
  mfaRequired?: boolean;
  challenge?: string;
  [key: string]: unknown;
}

export interface RegisterResponse {
  user: PublicUser;
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  [key: string]: unknown;
}

export interface Pagination {
  limit?: number;
  offset?: number;
}

export interface AuditQuery extends Pagination {
  event?: string;
  orgId?: string;
  userId?: string;
  format?: "json" | "csv";
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  name?: string;
  client_id?: string;
  metadata?: JsonObject;
}

export interface LoginInput {
  email: string;
  password: string;
  client_id?: string;
}

export interface MfaVerifyInput {
  challenge: string;
  code: string;
  factor?: "totp" | "backup_code";
}

export interface ProfileUpdateInput {
  name?: string;
  [key: string]: unknown;
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  plan?: string;
}

export interface UpdateOrganizationInput {
  name?: string;
  branding?: JsonObject;
}

export interface CreateApplicationInput {
  name: string;
  clientType?: "confidential" | "public";
  allowedScopes?: string[];
  redirectUris?: string[];
  allowedOrigins?: string[];
  allowedIps?: unknown[];
  blockedIps?: unknown[];
}

export interface CreateWebhookInput {
  url: string;
  events?: string[];
  appId?: string;
  [key: string]: unknown;
}

export interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type?: "code";
  scope?: string;
  state?: string;
  code_challenge: string;
  code_challenge_method?: "S256";
  nonce?: string;
}

export interface AuthorizationCodeGrant {
  grant_type?: "authorization_code";
  code: string;
  redirect_uri: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
}

export interface RefreshTokenGrant {
  grant_type: "refresh_token";
  refresh_token: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
}

export interface ClientCredentialsGrant {
  grant_type: "client_credentials";
  client_id?: string;
  client_secret?: string;
  scope?: string;
}
