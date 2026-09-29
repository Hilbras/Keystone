import http from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from "jose";

/**
 * A fake OpenID Provider, for tests.
 *
 * §4.3 asked for per-connector tests of the exchange path, and the only honest way
 * to test one is to have a provider to exchange with. This serves a real
 * discovery document, a real JWKS and a real token endpoint, and signs ID tokens
 * with a real RSA key — so `jwtVerify` in the connector does actual work: real
 * signature checking, real issuer and audience matching, real expiry handling,
 * and a real nonce comparison.
 *
 * What the connector rejects is therefore exercised for the reason it would
 * reject it in production, rather than by asserting on a stub's return value.
 *
 * The alternative — handing the connector a `fetch` that returns a canned body —
 * would test that the connector parses what it is given, which is a much smaller
 * claim, and would leave every signature and claim check untested.
 *
 * `ALLOW_PRIVATE_SSO_ENDPOINTS` is what makes this reachable: the SSO endpoint
 * policy refuses loopback and private addresses as an SSRF control, so without
 * that switch a test server is unreachable by design.
 */
export class FakeOidcProvider {
  private server: http.Server | undefined;
  private privateKey: CryptoKey | undefined;
  private publicJwk: JWK | undefined;
  readonly keyId = "fake-key-1";

  /** Overridable so a test can issue a deliberately wrong token. */
  issuer = "";
  authorizationEndpoint = "";
  tokenEndpoint = "";
  jwksUri = "";

  /** The nonce the last token request asked for, for asserting it was forwarded. */
  lastTokenRequest: Record<string, string> | undefined;

  /** When set, the token endpoint returns this instead of a signed ID token. */
  nextIdTokenOverride: string | undefined;

  /** The claims the next issued ID token will carry, merged over the defaults. */
  nextClaims: Record<string, unknown> = {};

  async start(): Promise<void> {
    const pair = await generateKeyPair("RS256", { extractable: true });
    this.privateKey = pair.privateKey;
    this.publicJwk = { ...(await exportJWK(pair.publicKey)), kid: this.keyId, alg: "RS256", use: "sig" };

    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;

    // The issuer is the bare origin with no trailing slash, which is what every
    // real provider uses and what `jwtVerify` compares against.
    this.issuer = `http://127.0.0.1:${port}`;
    this.authorizationEndpoint = `${this.issuer}/authorize`;
    this.tokenEndpoint = `${this.issuer}/token`;
    this.jwksUri = `${this.issuer}/jwks`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  /** Mint an ID token. Every claim can be overridden, including to be wrong. */
  async issueIdToken(overrides: Record<string, unknown> = {}): Promise<string> {
    if (!this.privateKey) throw new Error("provider not started");
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      email: "person@example.test",
      email_verified: true,
      name: "Test Person",
      preferred_username: "testperson",
      ...this.nextClaims,
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: this.keyId })
      .setIssuer(String(overrides.iss ?? this.issuer))
      .setAudience(String(overrides.aud ?? "test-client-id"))
      .setSubject(String(overrides.sub ?? "external-subject-1"))
      .setIssuedAt(Number(overrides.iat ?? now))
      .setExpirationTime(Number(overrides.exp ?? now + 300))
      .sign(this.privateKey);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", this.issuer || "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: this.authorizationEndpoint,
        token_endpoint: this.tokenEndpoint,
        jwks_uri: this.jwksUri,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }

    if (url.pathname === "/jwks") {
      return json(200, { keys: [this.publicJwk] });
    }

    if ((url.pathname === "/token" || url.pathname === "/oauth/v2/token") && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        this.lastTokenRequest = Object.fromEntries(new URLSearchParams(body));
        void this.issueIdToken({ nonce: this.lastTokenRequest!.nonce })
          .then((id_token) =>
            json(200, {
              access_token: "fake-access-token",
              token_type: "Bearer",
              expires_in: 300,
              id_token: this.nextIdTokenOverride ?? id_token,
            })
          )
          .catch((err: unknown) => json(500, { error: String(err) }));
      });
      return;
    }

    return json(404, { error: "not_found" });
  }
}
