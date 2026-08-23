import { config, zitadelBaseUrl } from "../config.js";

interface ServiceToken {
  token: string;
  expiresAt: number;
}

let cachedServiceToken: ServiceToken | null = null;
let cachedJwksUrl: string | null = null;
let cachedDiscovery: Record<string, unknown> | null = null;

export async function getServiceToken(): Promise<string | undefined> {
  if (config.ZITADEL_SERVICE_PAT) {
    return config.ZITADEL_SERVICE_PAT;
  }
  if (!config.ZITADEL_SERVICE_CLIENT_ID || !config.ZITADEL_SERVICE_CLIENT_SECRET) {
    return undefined;
  }

  const now = Date.now();
  if (cachedServiceToken && cachedServiceToken.expiresAt > now + 60_000) {
    return cachedServiceToken.token;
  }

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", config.ZITADEL_SERVICE_CLIENT_ID);
  params.set("client_secret", config.ZITADEL_SERVICE_CLIENT_SECRET);
  params.set("scope", serviceAccountScope());

  const res = await fetch(`${zitadelBaseUrl()}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zitadel service token failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  cachedServiceToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };
  return cachedServiceToken.token;
}

function serviceAccountScope(): string {
  const scopes = ["urn:zitadel:iam:org:project:id:zitadel:aud"];
  if (config.ZITADEL_ORG_ID) {
    scopes.push(`urn:zitadel:iam:org:id:${config.ZITADEL_ORG_ID}:aud`);
  }
  return scopes.join(" ");
}

function orgHeader(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.ZITADEL_ORG_ID) {
    headers["x-zitadel-orgid"] = config.ZITADEL_ORG_ID;
  }
  return headers;
}

export interface CreateHumanUserInput {
  userId?: string;
  username: string;
  email: string;
  name: string;
  password: string;
}

export async function createHumanUser(input: CreateHumanUserInput): Promise<string> {
  const token = await getServiceToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...orgHeader(),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const names = splitName(input.name || input.username);
  const body: Record<string, unknown> = {
    username: input.username,
    profile: {
      givenName: names.givenName,
      familyName: names.familyName,
    },
    email: {
      email: input.email,
      isVerified: true,
    },
    password: {
      password: input.password,
      changeRequired: false,
    },
  };
  if (input.userId) body.userId = input.userId;
  if (config.ZITADEL_ORG_ID) {
    body.organization = { orgId: config.ZITADEL_ORG_ID };
  }

  const res = await fetch(`${zitadelBaseUrl()}/v2/users/human`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zitadel create user failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { userId?: string; user?: { userId?: string } };
  return data.userId ?? data.user?.userId ?? "";
}

export async function verifyPassword(email: string, password: string): Promise<boolean> {
  const token = await getServiceToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...orgHeader(),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${zitadelBaseUrl()}/v2/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      checks: {
        user: { loginName: email },
        password: { password },
      },
      lifetime: "3600s",
    }),
  });

  // Consume/close the session? Zitadel does not require explicit cleanup for short-lived sessions.
  return res.ok;
}

export async function requestPasswordReset(zitadelUserId: string, redirectUrl: string): Promise<void> {
  const token = await getServiceToken();
  if (!token) throw new Error("Zitadel service token not available for password reset");

  const res = await fetch(`${zitadelBaseUrl()}/v2/users/${zitadelUserId}/password_reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...orgHeader(),
    },
    body: JSON.stringify({
      sendLink: {
        notificationType: "NOTIFICATION_TYPE_Email",
        urlTemplate: redirectUrl,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zitadel password reset failed: ${res.status} ${text}`);
  }
}

export async function setPassword(
  zitadelUserId: string,
  verificationCode: string,
  newPassword: string
): Promise<void> {
  const token = await getServiceToken();
  if (!token) throw new Error("Zitadel service token not available for password reset");

  const res = await fetch(`${zitadelBaseUrl()}/v2/users/${zitadelUserId}/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...orgHeader(),
    },
    body: JSON.stringify({
      newPassword: {
        password: newPassword,
        changeRequired: false,
      },
      verificationCode,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zitadel set password failed: ${res.status} ${text}`);
  }
}

export function buildAuthorizeUrl(provider: "google" | "github", state: string): string {
  const redirectUri = `${configPublicUrl()}/auth/callback/${provider}`;
  const params = new URLSearchParams({
    client_id: config.ZITADEL_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
  });

  const idpId = provider === "google" ? config.ZITADEL_GOOGLE_IDP_ID : config.ZITADEL_GITHUB_IDP_ID;
  if (idpId) {
    params.set("idp_hint", idpId);
  }

  return `${zitadelBaseUrl()}/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeOAuthCode(
  provider: "google" | "github",
  code: string
): Promise<{ idToken: string; accessToken: string; refreshToken?: string }> {
  const redirectUri = `${configPublicUrl()}/auth/callback/${provider}`;
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.ZITADEL_CLIENT_ID,
    client_secret: config.ZITADEL_CLIENT_SECRET,
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

  const data = (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
  };
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

export async function getZitadelJwksUrl(): Promise<string> {
  if (cachedJwksUrl) return cachedJwksUrl;
  const discovery = await getDiscovery();
  const url = (discovery.jwks_uri as string) || `${zitadelBaseUrl()}/oauth/v2/keys`;
  cachedJwksUrl = url;
  return url;
}

export async function getDiscovery(): Promise<Record<string, unknown>> {
  if (cachedDiscovery) return cachedDiscovery;
  const res = await fetch(`${zitadelBaseUrl()}/.well-known/openid-configuration`);
  if (!res.ok) {
    throw new Error(`Zitadel discovery failed: ${res.status}`);
  }
  cachedDiscovery = (await res.json()) as Record<string, unknown>;
  return cachedDiscovery;
}

function configPublicUrl(): string {
  return process.env.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
}

function splitName(name: string): { givenName: string; familyName: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { givenName: parts[0], familyName: "" };
  return { givenName: parts[0], familyName: parts.slice(1).join(" ") };
}
