import { HttpClient, stripTrailingSlashes, type HttpClientOptions, type RequestOptions } from "./http.js";
import type {
  ApiKey,
  Application,
  AuditLog,
  AuditQuery,
  AuthorizeParams,
  AuthorizationCodeGrant,
  ClientCredentialsGrant,
  CreateApplicationInput,
  CreateOrganizationInput,
  CreateWebhookInput,
  FeatureFlag,
  HealthReport,
  JsonObject,
  LoginInput,
  LoginResponse,
  MfaVerifyInput,
  Organization,
  Pagination,
  ProfileUpdateInput,
  PublicUser,
  RefreshTokenGrant,
  RegisterInput,
  RegisterResponse,
  Session,
  TokenResponse,
  UpdateOrganizationInput,
  WebhookDelivery,
  WebhookEndpoint,
} from "./types.js";

export interface KeystoneClientOptions extends Omit<HttpClientOptions, "baseUrl"> {
  /** Instance base URL, e.g. `https://auth.example.com`. */
  baseUrl: string;
}

const id = (value: string) => encodeURIComponent(value);

function pageQuery(pagination?: Pagination): Record<string, number | undefined> {
  return { limit: pagination?.limit, offset: pagination?.offset };
}

/** `/auth` — passwords, MFA, sessions and the current user's profile. */
export class AuthResource {
  constructor(private readonly http: HttpClient) {}

  register(input: RegisterInput): Promise<RegisterResponse> {
    return this.http.request("/auth/register", { method: "POST", body: input });
  }

  login(input: LoginInput): Promise<LoginResponse> {
    return this.http.request("/auth/login", { method: "POST", body: input });
  }

  loginWithToken(token: string): Promise<LoginResponse> {
    return this.http.request("/auth/token-login", { method: "POST", body: { token } });
  }

  verifyMfa(input: MfaVerifyInput): Promise<LoginResponse> {
    return this.http.request("/auth/mfa/verify", { method: "POST", body: input });
  }

  me(): Promise<{ user: PublicUser | null }> {
    return this.http.request("/auth/me");
  }

  refresh(clientId?: string): Promise<{ success: boolean }> {
    return this.http.request("/auth/refresh", {
      method: "POST",
      body: clientId ? { client_id: clientId } : {},
    });
  }

  /**
   * Revokes the session cookie presented with the request.
   *
   * Token-based clients do not hold that cookie; `OAuthResource.revoke` revokes a
   * refresh token directly.
   */
  logout(): Promise<{ success: boolean }> {
    return this.http.request("/auth/logout", { method: "POST", body: {} });
  }

  getProfile(): Promise<{ user: PublicUser }> {
    return this.http.request("/auth/profile");
  }

  updateProfile(input: ProfileUpdateInput): Promise<{ user: PublicUser }> {
    return this.http.request("/auth/profile", { method: "PATCH", body: input });
  }
}

/** `/auth/sessions` — list and revoke active sessions. */
export class SessionsResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<{ sessions: Session[] }> {
    return this.http.request("/auth/sessions");
  }

  revoke(sessionId: string): Promise<{ success: boolean }> {
    return this.http.request(`/auth/sessions/${id(sessionId)}`, { method: "DELETE" });
  }

  revokeAll(): Promise<{ success: boolean }> {
    return this.http.request("/auth/sessions/revoke-all", { method: "POST", body: {} });
  }
}

/** `/auth/api-keys` — personal API keys. */
export class ApiKeysResource {
  constructor(private readonly http: HttpClient) {}

  /** Returns the plaintext key once; it is not retrievable afterwards. */
  create(input: { name: string; scopes?: string[] }): Promise<{ key: string; apiKey: ApiKey }> {
    return this.http.request("/auth/api-keys", { method: "POST", body: input });
  }

  list(): Promise<{ keys: ApiKey[] }> {
    return this.http.request("/auth/api-keys");
  }

  revoke(keyId: string): Promise<{ success: boolean }> {
    return this.http.request(`/auth/api-keys/${id(keyId)}`, { method: "DELETE" });
  }

  /** Whether the credential on this client is accepted, and who it belongs to. */
  validate(): Promise<{ valid: boolean; user: PublicUser }> {
    return this.http.request("/auth/validate");
  }
}

/** `/v1/admin/organizations` — tenant administration. */
export class OrganizationsResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<{ organizations: Organization[] }> {
    return this.http.request("/v1/admin/organizations");
  }

  get(organizationId: string): Promise<{ organization: Organization }> {
    return this.http.request(`/v1/admin/organizations/${id(organizationId)}`);
  }

  create(input: CreateOrganizationInput): Promise<{ organization: Organization }> {
    return this.http.request("/v1/admin/organizations", { method: "POST", body: input });
  }

  update(
    organizationId: string,
    input: UpdateOrganizationInput
  ): Promise<{ organization: Organization }> {
    return this.http.request(`/v1/admin/organizations/${id(organizationId)}`, {
      method: "PATCH",
      body: input,
    });
  }

  listMembers(organizationId: string): Promise<{ members: unknown[] }> {
    return this.http.request(`/v1/admin/organizations/${id(organizationId)}/members`);
  }

  updateMember(
    organizationId: string,
    userId: string,
    role: "owner" | "admin" | "member"
  ): Promise<JsonObject> {
    return this.http.request(
      `/v1/admin/organizations/${id(organizationId)}/members/${id(userId)}`,
      { method: "PATCH", body: { role } }
    );
  }

  removeMember(organizationId: string, userId: string): Promise<{ success: boolean }> {
    return this.http.request(
      `/v1/admin/organizations/${id(organizationId)}/members/${id(userId)}`,
      { method: "DELETE" }
    );
  }

  invite(
    organizationId: string,
    input: { email: string; role?: "owner" | "admin" | "member" }
  ): Promise<JsonObject> {
    return this.http.request(`/v1/admin/organizations/${id(organizationId)}/invites`, {
      method: "POST",
      body: input,
    });
  }

  listApplications(organizationId: string): Promise<{ applications: Application[] }> {
    return this.http.request(`/v1/admin/organizations/${id(organizationId)}/applications`);
  }

  createApplication(
    organizationId: string,
    input: CreateApplicationInput
  ): Promise<{ application: Application; clientSecret?: string }> {
    return this.http.request(`/v1/admin/organizations/${id(organizationId)}/applications`, {
      method: "POST",
      body: input,
    });
  }

  updateApplication(
    organizationId: string,
    applicationId: string,
    input: JsonObject
  ): Promise<{ application: Application }> {
    return this.http.request(
      `/v1/admin/organizations/${id(organizationId)}/applications/${id(applicationId)}`,
      { method: "PATCH", body: input }
    );
  }

  listUsers(
    organizationId: string,
    pagination?: Pagination
  ): Promise<{ users: PublicUser[] }> {
    return this.http.request(`/v1/admin/organizations/${id(organizationId)}/users`, {
      query: pageQuery(pagination),
    });
  }

  getUser(organizationId: string, userId: string): Promise<{ user: PublicUser }> {
    return this.http.request(
      `/v1/admin/organizations/${id(organizationId)}/users/${id(userId)}`
    );
  }

  updateUser(organizationId: string, userId: string, input: JsonObject): Promise<JsonObject> {
    return this.http.request(
      `/v1/admin/organizations/${id(organizationId)}/users/${id(userId)}`,
      { method: "PATCH", body: input }
    );
  }

  removeUser(organizationId: string, userId: string): Promise<{ success: boolean }> {
    return this.http.request(
      `/v1/admin/organizations/${id(organizationId)}/users/${id(userId)}`,
      { method: "DELETE" }
    );
  }

  listApiKeys(organizationId: string): Promise<{ keys: ApiKey[] }> {
    return this.http.request(`/v1/admin/organizations/${id(organizationId)}/api-keys`);
  }

  revokeApiKey(organizationId: string, keyId: string): Promise<{ success: boolean }> {
    return this.http.request(
      `/v1/admin/organizations/${id(organizationId)}/api-keys/${id(keyId)}`,
      { method: "DELETE" }
    );
  }

  listAuditLogs(
    organizationId: string,
    query: AuditQuery = {}
  ): Promise<{ logs: AuditLog[] }> {
    return this.http.request(`/v1/admin/organizations/${id(organizationId)}/audit-logs`, {
      query: {
        event: query.event,
        limit: query.limit,
        offset: query.offset,
      },
    });
  }
}

/** `/oauth2` — the authorization server endpoints. */
export class OAuthResource {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string
  ) {}

  /** Builds the browser redirect URL for the authorization-code flow. */
  authorizeUrl(params: AuthorizeParams): string {
    const url = new URL(`${this.baseUrl}/oauth2/authorize`);
    url.searchParams.set("client_id", params.client_id);
    url.searchParams.set("redirect_uri", params.redirect_uri);
    url.searchParams.set("response_type", params.response_type ?? "code");
    url.searchParams.set("code_challenge", params.code_challenge);
    url.searchParams.set("code_challenge_method", params.code_challenge_method ?? "S256");
    if (params.scope) url.searchParams.set("scope", params.scope);
    if (params.state) url.searchParams.set("state", params.state);
    if (params.nonce) url.searchParams.set("nonce", params.nonce);
    return url.toString();
  }

  token(grant: AuthorizationCodeGrant | RefreshTokenGrant | ClientCredentialsGrant): Promise<TokenResponse> {
    return this.http.request("/oauth2/token", { method: "POST", body: grant });
  }

  exchangeCode(grant: AuthorizationCodeGrant): Promise<TokenResponse> {
    return this.token({ ...grant, grant_type: "authorization_code" });
  }

  refresh(grant: RefreshTokenGrant): Promise<TokenResponse> {
    return this.token(grant);
  }

  clientCredentials(grant: ClientCredentialsGrant): Promise<TokenResponse> {
    return this.token(grant);
  }

  userinfo(): Promise<JsonObject> {
    return this.http.request("/oauth2/userinfo");
  }

  revoke(token: string): Promise<{ success: boolean }> {
    return this.http.request("/oauth2/revoke", { method: "POST", body: { token } });
  }

  consent(input: { client_id: string; scopes?: string[]; grant: boolean }): Promise<JsonObject> {
    return this.http.request("/oauth2/consent", { method: "POST", body: input });
  }
}

/** Discovery endpoints — JWKS and the OIDC configuration document. */
export class TokensResource {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string
  ) {}

  jwks(): Promise<{ keys: JsonObject[] }> {
    return this.http.request("/.well-known/jwks.json");
  }

  discovery(): Promise<JsonObject> {
    return this.http.request("/.well-known/openid-configuration");
  }

  /** The published OpenAPI document, as served by this instance. */
  openapi(): Promise<JsonObject> {
    return this.http.request("/openapi.json");
  }

  /** The JWKS URL, for a verifier such as `jose`'s `createRemoteJWKSet`. */
  jwksUrl(): string {
    return `${this.baseUrl}/.well-known/jwks.json`;
  }
}

/** `/v1/admin/platform/webhooks` — owner-only webhook administration. */
export class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  list(appId?: string): Promise<{ endpoints: WebhookEndpoint[] }> {
    return this.http.request("/v1/admin/platform/webhooks", { query: { appId } });
  }

  create(input: CreateWebhookInput): Promise<{ endpoint: WebhookEndpoint; signingSecret: string }> {
    return this.http.request("/v1/admin/platform/webhooks", { method: "POST", body: input });
  }

  update(endpointId: string, input: JsonObject): Promise<{ endpoint: WebhookEndpoint }> {
    return this.http.request(`/v1/admin/platform/webhooks/${id(endpointId)}`, {
      method: "PATCH",
      body: input,
    });
  }

  remove(endpointId: string): Promise<{ success: boolean }> {
    return this.http.request(`/v1/admin/platform/webhooks/${id(endpointId)}`, {
      method: "DELETE",
    });
  }

  rotateSecret(endpointId: string): Promise<{ signingSecret: string }> {
    return this.http.request(`/v1/admin/platform/webhooks/${id(endpointId)}/rotate-secret`, {
      method: "POST",
      body: {},
    });
  }

  deliveries(endpointId: string): Promise<{ deliveries: WebhookDelivery[] }> {
    return this.http.request(`/v1/admin/platform/webhooks/${id(endpointId)}/deliveries`);
  }

  retryDelivery(deliveryId: string): Promise<{ success: boolean }> {
    return this.http.request(
      `/v1/admin/platform/webhook-deliveries/${id(deliveryId)}/retry`,
      { method: "POST", body: {} }
    );
  }
}

/** `/v1/admin/platform` — platform-owner operations. */
export class AdminResource {
  constructor(private readonly http: HttpClient) {}

  users(): Promise<{ users: PublicUser[] }> {
    return this.http.request("/v1/admin/platform/users");
  }

  updateUser(userId: string, input: JsonObject): Promise<PublicUser> {
    return this.http.request(`/v1/admin/platform/users/${id(userId)}`, {
      method: "PATCH",
      body: input,
    });
  }

  setUserRole(userId: string, role: string): Promise<PublicUser> {
    return this.http.request(`/v1/admin/platform/users/${id(userId)}/role`, {
      method: "PATCH",
      body: { role },
    });
  }

  reviewAccount(userId: string, input: JsonObject): Promise<JsonObject> {
    return this.http.request(`/v1/admin/platform/users/${id(userId)}/account-review`, {
      method: "POST",
      body: input,
    });
  }

  deleteUser(userId: string): Promise<{ success: boolean }> {
    return this.http.request(`/v1/admin/platform/users/${id(userId)}`, { method: "DELETE" });
  }

  organizations(): Promise<{ organizations: Organization[] }> {
    return this.http.request("/v1/admin/platform/organizations");
  }

  applications(): Promise<{ applications: Application[] }> {
    return this.http.request("/v1/admin/platform/applications");
  }

  auditLogs(query: AuditQuery = {}): Promise<{ logs: AuditLog[] }> {
    return this.http.request("/v1/admin/platform/audit-logs", {
      query: { event: query.event, limit: query.limit, offset: query.offset },
    });
  }

  exportAuditLogs(query: AuditQuery = {}): Promise<{ logs: AuditLog[] } | string> {
    return this.http.request("/v1/admin/platform/audit-logs/export", {
      query: {
        event: query.event,
        orgId: query.orgId,
        userId: query.userId,
        limit: query.limit,
        format: query.format,
      },
    });
  }

  usage(days?: number): Promise<JsonObject> {
    return this.http.request("/v1/admin/platform/metrics/usage", { query: { days } });
  }

  securitySummary(): Promise<JsonObject> {
    return this.http.request("/v1/admin/platform/security-summary");
  }

  queue(): Promise<JsonObject> {
    return this.http.request("/v1/admin/platform/queue");
  }

  failedJobs(limit?: number): Promise<JsonObject> {
    return this.http.request("/v1/admin/platform/queue/failed", { query: { limit } });
  }

  retryJob(jobId: string): Promise<{ success: boolean }> {
    return this.http.request(`/v1/admin/platform/queue/failed/${id(jobId)}/retry`, {
      method: "POST",
      body: {},
    });
  }

  retryAllJobs(): Promise<{ success: boolean }> {
    return this.http.request("/v1/admin/platform/queue/retry-all", { method: "POST", body: {} });
  }

  keys(): Promise<JsonObject> {
    return this.http.request("/v1/admin/platform/keys");
  }

  rotateKeys(): Promise<{ keyId: string; provider: string }> {
    return this.http.request("/v1/admin/platform/keys/rotate", { method: "POST", body: {} });
  }

  plugins(): Promise<JsonObject> {
    return this.http.request("/v1/admin/platform/plugins");
  }

  pluginExtensions(): Promise<JsonObject> {
    return this.http.request("/v1/admin/platform/plugins/extensions");
  }

  removePlugin(name: string): Promise<{ success: boolean }> {
    return this.http.request(`/v1/admin/platform/plugins/${id(name)}`, { method: "DELETE" });
  }

  featureFlags(): Promise<{ flags: FeatureFlag[] }> {
    return this.http.request("/v1/admin/platform/feature-flags");
  }

  featureFlag(key: string): Promise<{ key: string; enabled: boolean }> {
    return this.http.request(`/v1/admin/platform/feature-flags/${id(key)}`);
  }

  setFeatureFlag(key: string, enabled: boolean, description?: string): Promise<FeatureFlag> {
    return this.http.request(`/v1/admin/platform/feature-flags/${id(key)}`, {
      method: "PUT",
      body: { enabled, description },
    });
  }

  deleteFeatureFlag(key: string): Promise<{ success: boolean }> {
    return this.http.request(`/v1/admin/platform/feature-flags/${id(key)}`, { method: "DELETE" });
  }

  configurationProfiles(): Promise<{ profiles: JsonObject[] }> {
    return this.http.request("/v1/admin/platform/configuration-profiles");
  }

  configurationProfile(profileId: string): Promise<{ profile: JsonObject }> {
    return this.http.request(`/v1/admin/platform/configuration-profiles/${id(profileId)}`);
  }
}

/** Liveness, readiness and startup probes. */
export class HealthResource {
  constructor(private readonly http: HttpClient) {}

  live(): Promise<{ status: string }> {
    return this.http.request("/health/live");
  }

  ready(): Promise<HealthReport> {
    return this.http.request("/health/ready");
  }

  startup(): Promise<HealthReport> {
    return this.http.request("/health/startup");
  }
}

/**
 * A typed client for one Keystone instance.
 *
 * It carries one credential — `accessToken` (a string or an async provider, so a
 * refresh can be wired in without rebuilding the client) or `apiKey`. A caller
 * acting for two principals uses two clients; `withAccessToken` exists for the
 * common case of logging in and continuing with the new token.
 */
export class KeystoneClient {
  readonly auth: AuthResource;
  readonly sessions: SessionsResource;
  readonly apiKeys: ApiKeysResource;
  readonly organizations: OrganizationsResource;
  readonly oauth: OAuthResource;
  readonly tokens: TokensResource;
  readonly webhooks: WebhooksResource;
  readonly admin: AdminResource;
  readonly health: HealthResource;

  private readonly options: KeystoneClientOptions;
  private readonly http: HttpClient;

  constructor(options: KeystoneClientOptions) {
    this.options = options;
    this.http = new HttpClient(options);
    const baseUrl = stripTrailingSlashes(options.baseUrl);
    this.auth = new AuthResource(this.http);
    this.sessions = new SessionsResource(this.http);
    this.apiKeys = new ApiKeysResource(this.http);
    this.organizations = new OrganizationsResource(this.http);
    this.oauth = new OAuthResource(this.http, baseUrl);
    this.tokens = new TokensResource(this.http, baseUrl);
    this.webhooks = new WebhooksResource(this.http);
    this.admin = new AdminResource(this.http);
    this.health = new HealthResource(this.http);
  }

  /** Escape hatch for an endpoint this package does not name yet. */
  request<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.http.request<T>(path, options);
  }

  withAccessToken(accessToken: string | (() => string | Promise<string>)): KeystoneClient {
    return new KeystoneClient({ ...this.options, accessToken, apiKey: undefined });
  }

  withApiKey(apiKey: string): KeystoneClient {
    return new KeystoneClient({ ...this.options, apiKey, accessToken: undefined });
  }
}
