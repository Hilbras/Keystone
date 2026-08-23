# Integrating Keystone with Your Projects

Keystone exposes **standard OIDC/OAuth2** endpoints, a **REST API**, and **machine credentials**, so any application — web, mobile, CLI, or microservice — can use it as its identity provider.

---

## 1. Web / SPA: OIDC Authorization Code + PKCE

The recommended flow for React, Vue, Angular, Svelte, Next.js (client-side), and mobile apps.

### Discovery

```bash
curl http://localhost:4001/.well-known/openid-configuration
```

### Example: React helper

```ts
// auth.ts
const ISSUER = "http://localhost:4001";
const CLIENT_ID = "your-app-client-id"; // from /v1/admin/organizations/:id/applications

export function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(plain: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function startLogin() {
  const verifier = generateCodeVerifier();
  const challenge = await sha256(verifier);
  localStorage.setItem("keystone-code-verifier", verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: "http://localhost:5173/callback",
    scope: "openid profile email",
    state: crypto.randomUUID(),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  window.location.href = `${ISSUER}/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCode(code: string) {
  const verifier = localStorage.getItem("keystone-code-verifier");
  if (!verifier) throw new Error("Missing PKCE verifier");

  const res = await fetch(`${ISSUER}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:5173/callback",
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  const data = await res.json();
  localStorage.setItem("keystone-access-token", data.access_token);
  localStorage.setItem("keystone-refresh-token", data.refresh_token);
  return data;
}
```

### Callback page

```tsx
// pages/callback.tsx
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { exchangeCode } from "./auth";

export default function Callback() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const code = params.get("code");
    if (!code) return;
    exchangeCode(code).then(() => router.replace("/dashboard"));
  }, [params, router]);

  return <p>Signing in…</p>;
}
```

---

## 2. Server-side web app (Next.js App Router / SSR)

Use Keystone as an external OAuth provider with NextAuth.js, Auth.js, or a custom server-side OAuth flow.

### NextAuth.js provider example

```ts
// auth.ts (NextAuth v5 / Auth.js)
import NextAuth from "next-auth";
import { OAuthConfig } from "next-auth/providers";

const keystoneProvider: OAuthConfig<any> = {
  id: "keystone",
  name: "Keystone",
  type: "oauth",
  issuer: "http://localhost:4001",
  authorization: { params: { scope: "openid profile email" } },
  checks: ["pkce", "state"],
  clientId: process.env.KEYSTONE_CLIENT_ID!,
  clientSecret: process.env.KEYSTONE_CLIENT_SECRET!,
  profile(profile) {
    return {
      id: profile.sub,
      email: profile.email,
      name: profile.name,
      image: profile.picture,
    };
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [keystoneProvider],
});
```

> Store `clientSecret` server-side only.

---

## 3. Backend / microservice: API keys

For service-to-service or machine-to-machine calls, create an API key in the dashboard or via the API, then send it as a bearer token.

### Create an API key

```bash
curl -X POST http://localhost:4001/auth/api-keys \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"payment-service","scopes":["read:users","write:orders"]}'
```

Response includes `key` once. Save it securely.

### Use the API key

```bash
curl http://localhost:4001/auth/me \
  -H "Authorization: Bearer $API_KEY"
```

### Check authorization

```bash
curl -X POST http://localhost:4001/v1/authz/check \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "subjectId": "api-key-id",
    "resource": "order",
    "action": "create",
    "context": { "orgId": "..." }
  }'
```

---

## 4. Python / FastAPI backend

```python
import httpx
from jose import jwt, jwk
from jose.utils import base64url_decode
import requests

KEYSTONE_URL = "http://localhost:4001"
JWKS = requests.get(f"{KEYSTONE_URL}/.well-known/jwks.json").json()

def get_signing_key(token: str):
    header = jwt.get_unverified_header(token)
    for key in JWKS["keys"]:
        if key["kid"] == header["kid"]:
            return key
    raise ValueError("Signing key not found")

def verify_token(token: str):
    key = get_signing_key(token)
    return jwt.decode(token, key, algorithms=["RS256"], issuer=KEYSTONE_URL)

async def fetch_user(token: str):
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{KEYSTONE_URL}/oauth2/userinfo",
            headers={"Authorization": f"Bearer {token}"}
        )
        r.raise_for_status()
        return r.json()
```

---

## 5. Mobile apps

Mobile apps should use the same **Authorization Code + PKCE** flow as SPAs. Use a system browser (ASWebAuthenticationSession on iOS, Custom Tabs on Android) to open:

```
http://localhost:4001/oauth2/authorize?response_type=code&client_id=...&redirect_uri=myapp://callback&scope=openid%20profile%20email&code_challenge=...&code_challenge_method=S256&state=...
```

Register `myapp://callback` as the redirect scheme in your mobile app.

---

## 6. CLI / scripts

For CLI tools, use `/auth/token-login` with a user's email/password (if you accept password input) or issue a service account / API key.

```bash
export TOKEN=$(curl -s -X POST http://localhost:4001/auth/token-login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@example.com","password":"..."}' | jq -r .accessToken)

curl -H "Authorization: Bearer $TOKEN" http://localhost:4001/auth/me
```

---

## 7. Federation: let users sign in through external IdPs

Keystone acts as the broker. Your app only ever talks to Keystone.

```
User → Google / Azure / Okta → Keystone → Keystone access token
```

From your app's perspective, the flow is identical to section 1 — redirect to Keystone's OAuth2 authorize endpoint. Keystone handles the external IdP dance and returns your app a Keystone token.

Enable providers in the admin dashboard or by setting environment variables (`GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID`, etc.).

---

## 8. Register your application in Keystone

Before any OAuth2 flow, register your app under an organization:

```bash
curl -X POST http://localhost:4001/v1/admin/organizations/:orgId/applications \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My SaaS",
    "redirectUris": ["http://localhost:5173/callback"],
    "allowedOrigins": ["http://localhost:5173"]
  }'
```

Response:

```json
{
  "id": "...",
  "clientId": "my-saas-...",
  "clientSecret": "..." // store securely
}
```

---

## 9. Token verification summary

| Token type | Verify at | Use case |
|------------|-----------|----------|
| JWT access token | `/.well-known/jwks.json` | User sessions, SPAs, mobile |
| API key | `/auth/me` or locally against hash | Machine-to-machine |
| Refresh token | `/auth/refresh` | Silent re-authentication |
| ID token | JWKS + issuer + audience | OIDC clients |

---

## 10. Security checklist

- Always use **PKCE** for public clients (SPAs, mobile, desktop).
- Store `clientSecret` server-side only.
- Verify the JWT issuer (`iss`) and audience (`aud`) if you set them.
- Use short-lived access tokens and rotate refresh tokens.
- Scope API keys to the minimum permissions required.
- Call `/v1/authz/check` for sensitive actions even if the user is authenticated.

---

## Quick start for a new project

1. Run Keystone locally: `./start.sh`
2. Complete setup and create an owner account.
3. Create an organization and application via the admin dashboard.
4. Copy the `clientId` and `clientSecret`.
5. Use the OIDC endpoints above in your app.
6. Validate tokens with `/.well-known/jwks.json`.
