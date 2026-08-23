import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface KeystoneNodeConfig {
  /** Keystone API base URL, e.g. https://auth.example.com */
  url: string;
  /** Expected issuer claim (defaults to config.url) */
  issuer?: string;
  /** Expected audience claim (optional) */
  audience?: string;
  /** Service API key for admin calls (optional) */
  apiKey?: string;
}

export interface KeystoneTokenClaims extends JWTPayload {
  email?: string;
  username?: string;
  name?: string;
  plan?: string;
  role?: string;
  provider?: string;
  org_id?: string;
  app_id?: string;
  client_id?: string;
}

export interface VerifiedToken {
  valid: boolean;
  claims?: KeystoneTokenClaims;
  error?: string;
}

/**
 * Server-side Keystone client. Verifies RS256 access tokens against the
 * instance's JWKS endpoint (cached by jose) and exposes admin API helpers.
 */
export class KeystoneNodeClient {
  private url: string;
  private issuer?: string;
  private audience?: string;
  private apiKey?: string;
  private jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: KeystoneNodeConfig) {
    this.url = config.url.replace(/\/$/, "");
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.apiKey = config.apiKey;
    this.jwks = createRemoteJWKSet(new URL(`${this.url}/.well-known/jwks.json`));
  }

  /** Verify a Keystone access token. Returns claims when valid. */
  async verifyToken(token: string): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      return { valid: true, claims: payload as KeystoneTokenClaims };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : "Invalid token" };
    }
  }

  /** Extract and verify a Bearer token from an Authorization header value. */
  async verifyAuthorizationHeader(header: string | undefined | null): Promise<VerifiedToken> {
    if (!header || !header.startsWith("Bearer ")) {
      return { valid: false, error: "Missing or malformed Authorization header" };
    }
    return this.verifyToken(header.slice(7));
  }

  private async adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.apiKey) throw new Error("apiKey is required for admin calls");
    const res = await fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  /** Look up a user by id via the admin API (requires apiKey). */
  async getUser(userId: string) {
    return this.adminRequest<{ user: unknown }>(`/v1/admin/platform/users/${encodeURIComponent(userId)}`);
  }

  /** List users (requires apiKey). */
  async listUsers() {
    return this.adminRequest<{ users: unknown[] }>("/v1/admin/platform/users");
  }
}

export function createKeystoneNodeClient(config: KeystoneNodeConfig): KeystoneNodeClient {
  return new KeystoneNodeClient(config);
}
