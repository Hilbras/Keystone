const API_BASE = import.meta.env.VITE_KEYSTONE_API_URL || "http://localhost:4001";

export interface SetupStatus {
  needsSetup: boolean;
  setupToken: boolean;
}

export interface SetupInitInput {
  email: string;
  password: string;
  name?: string;
  username?: string;
}

export interface SetupInitResponse {
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
}

export interface ValidateDatabaseInput {
  databaseUrl: string;
}

export interface ValidateRedisInput {
  redisUrl: string;
}

export interface ValidateEmailInput {
  provider: "none" | "console" | "smtp" | "sendgrid" | "mailgun";
  from: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpSecure?: boolean;
  sendgridApiKey?: string;
  mailgunApiKey?: string;
  mailgunDomain?: string;
  to: string;
}

export interface ValidateSmsInput {
  provider: "none" | "console" | "twilio";
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  twilioMessagingServiceSid?: string;
  to: string;
}

export interface SetupConfigInput {
  env: Record<string, string>;
}

export interface SetupConfigResponse {
  ok: boolean;
  backupPath?: string;
}

export interface DiagnosticCheck {
  name: string;
  status: "ok" | "error" | "warning" | "skipped";
  message?: string;
}

export interface SetupDiagnosticsResponse {
  checks: DiagnosticCheck[];
  ready: boolean;
}

export interface HealthStatus {
  status: string;
  database?: boolean;
  redis?: boolean;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginTokenResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    username: string;
    name: string | null;
    avatarUrl: string | null;
    emailVerified: boolean;
    plan: string;
    role: string;
    provider: string;
  };
}

export interface BrandingInput {
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  companyName?: string;
  supportEmail?: string;
  loginTitle?: string;
  loginSubtitle?: string;
}

export function getKeystoneAccessToken(): string | null {
  return localStorage.getItem("keystone-access-token")?.trim() || null;
}

let authReloadInProgress = false;

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const setupToken = localStorage.getItem("keystone-setup-token")?.trim();
  if (setupToken) {
    headers["X-Setup-Token"] = setupToken;
  }
  const accessToken = getKeystoneAccessToken();
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    headers: { ...headers, ...init?.headers },
    credentials: "include",
    ...init,
  });
  if (!response.ok) {
    // If the server rejects the token (401), clear it and reload so the user
    // sees the login screen again. We do not reload on 403 (forbidden) because
    // that means the user is authenticated but lacks permission for one action.
    if (response.status === 401 && accessToken && !authReloadInProgress) {
      authReloadInProgress = true;
      localStorage.removeItem("keystone-access-token");
      window.location.reload();
      return new Promise(() => {});
    }
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  getStatus: () => fetchJson<SetupStatus>("/setup/status"),
  validateDatabase: (input: ValidateDatabaseInput) =>
    fetchJson<{ ok: boolean }>("/setup/validate/db", { method: "POST", body: JSON.stringify(input) }),
  validateRedis: (input: ValidateRedisInput) =>
    fetchJson<{ ok: boolean }>("/setup/validate/redis", { method: "POST", body: JSON.stringify(input) }),
  validateEmail: (input: ValidateEmailInput) =>
    fetchJson<{ ok: boolean }>("/setup/validate/email", { method: "POST", body: JSON.stringify(input) }),
  validateSms: (input: ValidateSmsInput) =>
    fetchJson<{ ok: boolean }>("/setup/validate/sms", { method: "POST", body: JSON.stringify(input) }),
  applyConfig: (input: SetupConfigInput) =>
    fetchJson<SetupConfigResponse>("/setup/config", { method: "POST", body: JSON.stringify(input) }),
  runMigrations: () =>
    fetchJson<{ ok: boolean }>("/setup/migrate", { method: "POST", body: JSON.stringify({}) }),
  getSetupDiagnostics: () => fetchJson<SetupDiagnosticsResponse>("/setup/diagnostics"),
  restart: () =>
    fetchJson<{ ok: boolean }>("/setup/restart", { method: "POST", body: JSON.stringify({}) }),
  init: (input: SetupInitInput) =>
    fetchJson<SetupInitResponse>("/setup/init", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // Public discovery / health endpoints used by the post-setup dashboard.
  getHealth: () => fetchJson<HealthStatus>("/health"),
  getOpenIdConfig: () => fetchJson<Record<string, unknown>>("/.well-known/openid-configuration"),

  // Token-based authentication and platform admin endpoints.
  loginToken: (input: LoginInput) =>
    fetchJson<LoginTokenResponse>("/auth/token-login", { method: "POST", body: JSON.stringify(input) }),
  getMe: () => fetchJson<{ user: unknown }>("/auth/me"),
  getUsers: () => fetchJson<{ users: unknown[] }>("/v1/admin/platform/users"),
  getOrganizations: () => fetchJson<{ organizations: unknown[] }>("/v1/admin/platform/organizations"),
  getApplications: () => fetchJson<{ applications: unknown[] }>("/v1/admin/platform/applications"),
  getAuditLogs: (event?: string) =>
    fetchJson<{ logs: unknown[] }>(`/v1/admin/platform/audit-logs${event ? `?event=${encodeURIComponent(event)}` : ""}`),
  // Queue monitoring and dead-letter handling
  getQueueStatus: () => fetchJson<{ queue: string; stats: Array<{ type: string; count: number; failed?: number; delayed?: number }> }>("/v1/admin/platform/queue"),
  getQueueFailed: (limit?: number) =>
    fetchJson<{ failed: Array<{ id: string; type: string; payload: unknown; attempts?: number; createdAt?: string }> }>(`/v1/admin/platform/queue/failed?limit=${limit ?? 50}`),
  retryQueueJob: (id: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/platform/queue/failed/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({}) }),
  retryAllQueueJobs: () =>
    fetchJson<{ success: boolean }>("/v1/admin/platform/queue/retry-all", { method: "POST", body: JSON.stringify({}) }),
  getSigningKeys: () => fetchJson<{ keys: Array<{ keyId: string; createdAt: string; expiresAt?: string | null }>; provider: string }>("/v1/admin/platform/keys"),
  rotateSigningKey: () => fetchJson<{ keyId: string; provider: string }>("/v1/admin/platform/keys/rotate", { method: "POST" }),
  getFederationProviders: () => fetchJson<{ providers: Array<{ type: string; name: string; configured: boolean }> }>("/federation/providers"),
  getPlugins: () => fetchJson<{ plugins: Array<{ metadata: { name: string; version: string; description?: string; author?: string; homepage?: string }; extensionPoints: string[] }> }>("/v1/admin/platform/plugins"),
  getPluginExtensionPoints: () => fetchJson<{ extensionPoints: Array<{ name: string; description: string; registered: string[] }> }>("/v1/admin/platform/plugins/extensions"),
  unregisterPlugin: (name: string) => fetchJson<{ success: boolean }>(`/v1/admin/platform/plugins/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // Feature flags and configuration profiles
  getFeatureFlags: () => fetchJson<{ flags: Array<{ key: string; enabled: boolean; description: string | null; source: "database" | "environment" }> }>("/v1/admin/platform/feature-flags"),
  setFeatureFlag: (key: string, enabled: boolean, description?: string) =>
    fetchJson<{ key: string; enabled: boolean }>(`/v1/admin/platform/feature-flags/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled, description }),
    }),
  deleteFeatureFlag: (key: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/platform/feature-flags/${encodeURIComponent(key)}`, { method: "DELETE" }),
  getConfigurationProfiles: () => fetchJson<{ profiles: Array<{ id: string; name: string; description: string }> }>("/v1/admin/platform/configuration-profiles"),
  getConfigurationProfile: (id: string) => fetchJson<{ profile: { name: string; description: string; values: Record<string, string> } }>(`/v1/admin/platform/configuration-profiles/${encodeURIComponent(id)}`),

  // Enterprise SSO
  getSamlConnections: (orgId: string) =>
    fetchJson<{ connections: Array<{ id: string; name: string; idpEntityId: string | null; idpSsoUrl: string | null; spEntityId: string; spAcsUrl: string; isActive: boolean; createdAt: string }> }>(`/v1/admin/organizations/${orgId}/saml-connections`),
  createSamlConnection: (orgId: string, input: { name: string; spEntityId: string; spAcsUrl: string; idpEntityId?: string; idpSsoUrl?: string; idpCertificate?: string; attributeMapping?: Record<string, string[]>; isActive?: boolean }) =>
    fetchJson<{ id: string }>(`/v1/admin/organizations/${orgId}/saml-connections`, { method: "POST", body: JSON.stringify(input) }),
  deleteSamlConnection: (orgId: string, connectionId: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/organizations/${orgId}/saml-connections/${connectionId}`, { method: "DELETE" }),
  getSamlMetadata: (connectionId: string) =>
    fetch(`${API_BASE}/v1/admin/organizations/_/saml-connections/${connectionId}/metadata`).then((r) => r.text()),
  getOidcConnections: (orgId: string) =>
    fetchJson<{ connections: Array<{ id: string; name: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; userinfoEndpoint: string | null; jwksUri: string | null; clientId: string; scopes: string[]; isActive: boolean; createdAt: string }> }>(`/v1/admin/organizations/${orgId}/oidc-connections`),
  createOidcConnection: (orgId: string, input: { name: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; userinfoEndpoint?: string; jwksUri?: string; clientId: string; clientSecret: string; scopes?: string[]; attributeMapping?: Record<string, string[]>; isActive?: boolean }) =>
    fetchJson<{ id: string }>(`/v1/admin/organizations/${orgId}/oidc-connections`, { method: "POST", body: JSON.stringify(input) }),
  deleteOidcConnection: (orgId: string, connectionId: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/organizations/${orgId}/oidc-connections/${connectionId}`, { method: "DELETE" }),
  getScimConfig: (orgId: string) =>
    fetchJson<{ enabled: boolean; baseUrl: string; orgId: string }>(`/v1/admin/organizations/${orgId}/scim-config`),

  // Workflows
  getWorkflows: () => fetchJson<{ workflows: Array<{ id: string; name: string; trigger: string; definition: { steps: Array<{ type: string; name?: string }> }; isActive: boolean; createdAt: string }> }>("/v1/admin/workflows"),
  createWorkflow: (input: { name: string; trigger: string; definition: { steps: Array<{ type: string; name?: string }> } }) =>
    fetchJson<{ id: string }>("/v1/admin/workflows", { method: "POST", body: JSON.stringify(input) }),
  deleteWorkflow: (id: string) => fetchJson<{ success: boolean }>(`/v1/admin/workflows/${id}`, { method: "DELETE" }),
  getWorkflowRuns: (id: string) =>
    fetchJson<{ runs: Array<{ id: string; status: string; triggerEvent: string; startedAt: string | null; finishedAt: string | null; log: Array<{ step: string; status: string; error?: string }> }> }>(`/v1/admin/workflows/${id}/runs`),

  // Billing
  getPlans: () => fetchJson<{ plans: Array<{ id: string; name: string; description: string }> }>("/v1/admin/billing/plans"),
  getBillingSummary: (orgId: string) =>
    fetchJson<{ plan: string; provider?: string; subscription?: Record<string, unknown> }>(`/v1/admin/organizations/${orgId}/billing`),
  updateOrganizationPlan: (orgId: string, plan: string) =>
    fetchJson<{ plan: string }>(`/v1/admin/organizations/${orgId}/plan`, { method: "PATCH", body: JSON.stringify({ plan }) }),
  provisionBillingCustomer: (orgId: string) =>
    fetchJson<Record<string, unknown>>(`/v1/admin/organizations/${orgId}/billing/customer`, { method: "POST" }),

  getSecuritySummary: () => fetchJson<{
    last24h: { logins: number; failedLogins: number };
    activeSessions: number;
    mfa: { enabled: number; total: number };
    anomalies?: {
      newDevices24h: number;
      recentFailedLogins: Array<{ id: string; event: string; userId: string | null; ipAddress: string | null; userAgent: string | null; createdAt: string }>;
    };
    recentLogins: Array<{ id: string; event: string; userId: string | null; ipAddress: string | null; userAgent: string | null; createdAt: string }>;
  }>("/v1/admin/platform/security-summary"),

  // Platform admin CRUD
  createOrganization: (input: { name: string; slug?: string; plan?: string }) =>
    fetchJson<{ id: string }>("/v1/admin/organizations", { method: "POST", body: JSON.stringify(input) }),
  createApplication: (orgId: string, input: { name: string; redirectUris?: string[]; allowedOrigins?: string[] }) =>
    fetchJson<{ id: string; clientId: string; clientSecret: string }>(`/v1/admin/organizations/${orgId}/applications`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateApplication: (orgId: string, appId: string, input: Partial<{ name: string; redirectUris: string[]; allowedOrigins: string[]; allowedIps: string[]; blockedIps: string[]; isActive: boolean; branding: BrandingInput }>) =>
    fetchJson<unknown>(`/v1/admin/organizations/${orgId}/applications/${appId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  inviteUser: (orgId: string, input: { email: string; role: "owner" | "admin" | "member" }) =>
    fetchJson<{ user: { id: string } }>(`/v1/admin/organizations/${orgId}/invites`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateUser: (userId: string, input: Partial<{ name: string; username: string; role: string; emailVerified: boolean }>) =>
    fetchJson<unknown>(`/v1/admin/platform/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deactivateUser: (userId: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/platform/users/${userId}`, { method: "DELETE" }),

  // Profile (self-service)
  getProfile: () => fetchJson<{ user: { id: string; email: string; username: string; name: string | null; avatarUrl: string | null; emailVerified: boolean; phoneNumber?: string | null; phoneVerified?: boolean; metadata: Record<string, unknown> } }>("/auth/profile"),
  updateProfile: (input: Partial<{ name: string; avatarUrl: string | null; phoneNumber: string | null; metadata: Record<string, unknown> }>) =>
    fetchJson<{ user: unknown }>("/auth/profile", { method: "PATCH", body: JSON.stringify(input) }),

  // Email verification
  sendEmailVerification: () =>
    fetchJson<{ success: boolean; alreadyVerified?: boolean }>("/auth/email-verification/send", { method: "POST", body: JSON.stringify({}) }),
  verifyEmail: (token: string) =>
    fetchJson<{ success: boolean; email: string }>(`/auth/email-verification/verify?token=${encodeURIComponent(token)}`),

  // Webhooks
  getWebhooks: (appId?: string) =>
    fetchJson<{ endpoints: Array<{ id: string; appId: string | null; url: string; description: string | null; events: string[]; isActive: boolean; createdAt: string }> }>(`/v1/admin/platform/webhooks${appId ? `?appId=${encodeURIComponent(appId)}` : ""}`),
  createWebhook: (input: { appId?: string | null; url: string; description?: string; events?: string[] }) =>
    fetchJson<{ endpoint: { id: string }; signingSecret: string }>("/v1/admin/platform/webhooks", { method: "POST", body: JSON.stringify(input) }),
  updateWebhook: (id: string, input: Partial<{ url: string; description: string | null; events: string[]; isActive: boolean }>) =>
    fetchJson<{ endpoint: unknown }>(`/v1/admin/platform/webhooks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteWebhook: (id: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/platform/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  rotateWebhookSecret: (id: string) =>
    fetchJson<{ signingSecret: string }>(`/v1/admin/platform/webhooks/${encodeURIComponent(id)}/rotate-secret`, { method: "POST", body: JSON.stringify({}) }),
  getWebhookDeliveries: (id: string) =>
    fetchJson<{ deliveries: Array<{ id: string; endpointId: string; eventType: string; status: string; attempts: number; responseStatus: number | null; responseBody: string | null; lastAttemptAt: string | null; createdAt: string }> }>(`/v1/admin/platform/webhooks/${encodeURIComponent(id)}/deliveries`),
  retryWebhookDelivery: (id: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/platform/webhook-deliveries/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({}) }),

  // Usage analytics
  getUsageMetrics: (days = 30) =>
    fetchJson<{ days: number; series: Array<{ date: string; logins: number; failedLogins: number; signups: number; dau: number }> }>(`/v1/admin/platform/metrics/usage?days=${days}`),
  getSessions: () =>
    fetchJson<{ sessions: Array<{ id: string; deviceFingerprint: string | null; ipAddress: string | null; userAgent: string | null; lastSeenAt: string; expiresAt: string; createdAt: string }> }>("/auth/sessions"),
  revokeSession: (id: string) =>
    fetchJson<{ success: boolean }>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  revokeAllSessions: () =>
    fetchJson<{ success: boolean }>("/auth/sessions/revoke-all", { method: "POST", body: JSON.stringify({}) }),

  // Passwordless: magic links
  sendMagicLink: (email: string) =>
    fetchJson<{ success: boolean }>("/auth/magic-link/send", { method: "POST", body: JSON.stringify({ email }) }),
  verifyMagicLink: (token: string) =>
    fetchJson<{ user: unknown; accessToken: string; refreshToken: string }>(`/auth/magic-link/verify?token=${encodeURIComponent(token)}`),

  // Passwordless: WebAuthn / passkeys
  webauthnRegisterOptions: () => fetchJson<Record<string, unknown>>("/auth/webauthn/register/options"),
  webauthnRegisterVerify: (response: unknown, deviceName?: string) =>
    fetchJson<{ success: boolean }>("/auth/webauthn/register/verify", { method: "POST", body: JSON.stringify({ response, deviceName }) }),
  webauthnAuthOptions: (email?: string) =>
    fetchJson<Record<string, unknown>>("/auth/webauthn/authenticate/options", { method: "POST", body: JSON.stringify({ email }) }),
  webauthnAuthVerify: (response: unknown) =>
    fetchJson<{ user: unknown; accessToken: string; refreshToken: string }>("/auth/webauthn/authenticate/verify", { method: "POST", body: JSON.stringify({ response }) }),

  // Platform configuration
  getConfig: () => fetchJson<{ values: Record<string, string> }>("/v1/admin/config"),
  updateConfig: (input: { values: Record<string, string> }) =>
    fetchJson<{ ok: boolean }>("/v1/admin/config", { method: "PUT", body: JSON.stringify(input) }),
  restartServer: () => fetchJson<{ ok: boolean }>("/v1/admin/config/restart", { method: "POST" }),

  // RBAC: permissions and role assignments
  getPermissions: () =>
    fetchJson<{ permissions: Array<{ id: string; resource: string; action: string; description: string | null; createdAt: string }> }>("/v1/admin/permissions"),
  createPermission: (input: { resource: string; action: string; description?: string }) =>
    fetchJson<{ id: string }>("/v1/admin/permissions", { method: "POST", body: JSON.stringify(input) }),
  deletePermission: (id: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/permissions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getRoles: () => fetchJson<{ roles: string[] }>("/v1/admin/roles"),
  getRolePermissions: (role: string) =>
    fetchJson<{ role: string; permissions: Array<{ id: string; resource: string; action: string; description: string | null }> }>(`/v1/admin/roles/${encodeURIComponent(role)}/permissions`),
  assignRolePermission: (role: string, permissionId: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/roles/${encodeURIComponent(role)}/permissions`, { method: "POST", body: JSON.stringify({ permissionId }) }),
  removeRolePermission: (role: string, permissionId: string) =>
    fetchJson<{ success: boolean }>(`/v1/admin/roles/${encodeURIComponent(role)}/permissions/${encodeURIComponent(permissionId)}`, { method: "DELETE" }),

  // Organization / application branding
  updateOrganization: (orgId: string, input: Partial<{ name: string; branding: BrandingInput }>) =>
    fetchJson<unknown>(`/v1/admin/organizations/${encodeURIComponent(orgId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  getPublicBranding: (clientId: string) =>
    fetchJson<{ name?: string; logoUrl?: string; primaryColor?: string; accentColor?: string; supportEmail?: string; loginTitle?: string; loginSubtitle?: string }>(`/sdk/branding/${encodeURIComponent(clientId)}`),

  // Audit log export (returns a downloadable blob)
  downloadAuditExport: async (event?: string, format: "csv" | "json" = "csv"): Promise<void> => {
    const token = getKeystoneAccessToken();
    const params = new URLSearchParams({ format, limit: "10000" });
    if (event) params.set("event", event);
    const response = await fetch(`${API_BASE}/v1/admin/platform/audit-logs/export?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
    });
    if (!response.ok) throw new Error(`Export failed: ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `keystone-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
