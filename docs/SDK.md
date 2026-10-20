# SDK — `@hilbras/keystone-client`

The official TypeScript client for the Keystone HTTP API. It is a plain ESM
package with no runtime dependencies: it uses the platform `fetch`, or one you
supply. Works in Node 20+ and in the browser.

```bash
npm install @hilbras/keystone-client
```

```ts
import { KeystoneClient } from "@hilbras/keystone-client";

const keystone = new KeystoneClient({
  baseUrl: "https://auth.example.com",
  apiKey: "ks_live_...",
});

const { user } = await keystone.auth.me();
console.log(user?.email);
```

## Credentials

The client accepts one credential at a time:

| Option | Sent as | Use |
| --- | --- | --- |
| `apiKey` | `x-api-key` | Machine-to-machine, CI, services |
| `accessToken` | `Authorization: Bearer` | Human or service access tokens |
| neither | nothing | Public endpoints (`login`, `register`, JWKS, health) |

`accessToken` may be a string or a function. The function is called once per
request, so a refresh can be wired in without rebuilding the client:

```ts
import { KeystoneClient } from "@hilbras/keystone-client";

let token = "initial-access-token";
const keystone = new KeystoneClient({
  baseUrl: "https://auth.example.com",
  accessToken: () => token,
});

token = "rotated-access-token";
await keystone.sessions.list();
```

After a login, `withAccessToken` returns a new client with the token and without
the previous API key:

```ts
import { KeystoneClient } from "@hilbras/keystone-client";

const anonymous = new KeystoneClient({ baseUrl: "https://auth.example.com" });
const session = await anonymous.auth.login({
  email: "ada@example.com",
  password: "correct horse battery staple",
});

const keystone = anonymous.withAccessToken(session.accessToken ?? "");
const { sessions } = await keystone.sessions.list();
```

For cookie-based browser sessions, construct the client with
`credentials: "include"`. Token-based callers should use `OAuthResource.revoke`
to revoke a refresh token; `auth.logout` revokes the session cookie.

## Resources

| Property | Covers |
| --- | --- |
| `auth` | register, login, token login, MFA verify, `me`, refresh, logout, profile |
| `sessions` | list, revoke one, revoke all |
| `apiKeys` | create, list, revoke, validate |
| `organizations` | organizations, members, invites, applications, users, org API keys, audit |
| `oauth` | authorize URL, token (code / refresh / client credentials), userinfo, revoke, consent |
| `tokens` | JWKS, OIDC discovery, the served OpenAPI document |
| `webhooks` | endpoints, secrets, deliveries, manual retry |
| `admin` | platform users, organizations, applications, audit, usage, queue, keys, plugins, feature flags, profiles |
| `health` | live, ready, startup |

Every method is a thin, typed call. `client.request(path, options)` is the escape
hatch for an endpoint this package does not name yet.

## Errors

Every failure is a subclass of `KeystoneError`, chosen by status, with the
server's `code`, `requestId`, and (for validation) `details` attached.

| Class | Status | Retry? |
| --- | --- | --- |
| `AuthenticationError` | 401 | No — re-authenticate |
| `AuthorizationError` | 403 | No |
| `NotFoundError` | 404 | No |
| `ConflictError` | 409 | No |
| `ValidationError` | 400, 422 | No — fix the request |
| `RateLimitError` | 429 | Yes, after `retryAfterSeconds` |
| `ServerError` | 5xx | Yes for 502/503/504 |
| `NetworkError` | no response | Yes |

```ts
import { KeystoneClient, RateLimitError, ValidationError } from "@hilbras/keystone-client";

const keystone = new KeystoneClient({ baseUrl: "https://auth.example.com" });

try {
  await keystone.auth.register({
    username: "ada",
    email: "ada@example.com",
    password: "correct horse battery staple",
  });
} catch (error) {
  if (error instanceof ValidationError) {
    console.error(error.code, error.requestId, error.details);
  } else if (error instanceof RateLimitError) {
    console.error(`retry in ${error.retryAfterSeconds ?? 1}s`, error.requestId);
  } else {
    throw error;
  }
}
```

Log `requestId` with the failure. It joins the response to the server's access
log and to every job and webhook the request caused.

## Retries

Safe methods — `GET`, `HEAD`, `OPTIONS` — retry twice by default with exponential
backoff, equal jitter, and a cap of five seconds. `429` honours `Retry-After`;
`502`, `503`, `504` and transport failures use the backoff. `400`, `401`, `403`,
`404` and `409` are never retried: the answer will not change.

Writes are **never** retried unless you pass `retry: true`, because only you know
whether repeating the operation is harmless:

```ts
import { KeystoneClient } from "@hilbras/keystone-client";

const keystone = new KeystoneClient({
  baseUrl: "https://auth.example.com",
  apiKey: "ks_live_...",
  maxRetries: 3,
  timeoutMs: 10_000,
  backoffBaseMs: 250,
});

await keystone.request("/v1/admin/organizations", {
  method: "POST",
  body: { name: "Acme" },
  idempotencyKey: "create-org-acme-2026-10-20",
  retry: true,
});
```

`idempotencyKey` is sent as `Idempotency-Key`. Keystone accepts and forwards the
header but **does not yet deduplicate on it**; it is useful when a gateway in
front of Keystone does, and it is the header a future server-side implementation
will read. It does not make a write safe to retry by itself.

## OAuth 2.0 / OIDC

```ts
import { KeystoneClient } from "@hilbras/keystone-client";

const keystone = new KeystoneClient({ baseUrl: "https://auth.example.com" });

const authorizeUrl = keystone.oauth.authorizeUrl({
  client_id: "app_123",
  redirect_uri: "https://app.example.com/callback",
  scope: "openid profile email",
  state: "state-abc",
  code_challenge: "a".repeat(43),
});
console.log(authorizeUrl);
```

Exchange the code once, with the verifier that matches the challenge:

```ts
import { KeystoneClient } from "@hilbras/keystone-client";

const keystone = new KeystoneClient({ baseUrl: "https://auth.example.com" });

const tokens = await keystone.oauth.exchangeCode({
  code: "authorization-code",
  redirect_uri: "https://app.example.com/callback",
  client_id: "app_123",
  client_secret: "confidential-client-secret",
  code_verifier: "a".repeat(43),
});

console.log(tokens.access_token, tokens.refresh_token, tokens.expires_in);
```

Keystone validates the client, the redirect URI and PKCE before consuming the
code, and the consume is atomic. A wrong verifier does not burn the code; a
second redemption is rejected and audited.

## Versioning

All `@hilbras/keystone-*` packages share the server's version and declare the
server range they support in `keystonePeer.server`. Install the client that
matches the server's minor version:

```bash
npm install @hilbras/keystone-client@3.12
```

`npm run verify:sdk` in the Keystone repository enforces the shared version,
the declared range, the entry points and a compile of every package;
`npm run verify:client` drives this client's error and retry contract.

## Related

- `docs/API.md` — endpoints, error model, pagination, retry safety
- `docs/INTEGRATION.md` — end-to-end browser and server integration
- `docs/TROUBLESHOOTING.md` — diagnosing 401/403, rate limits, webhook failures
- `packages/keystone-node` — JWT verification and admin helpers for Node servers
- `packages/keystone-sdk` — browser drop-in that wires forms to `/auth`
