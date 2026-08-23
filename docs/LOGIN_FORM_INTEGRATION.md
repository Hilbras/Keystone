# Connect Your Login/Signup Form to Keystone

If you already have a login/signup page with email/password and a "Login with Google" button, this guide shows you exactly how to wire it to Keystone.

---

## The big picture

Your frontend does **not** talk directly to Google. It talks to Keystone. Keystone handles Google, passwords, tokens, and sessions.

```
User
  │
  ▼
Your React login page
  │
  ├── email/password ──► POST /auth/login
  │
  └── Google button ───► GET /auth/oauth/google
                              │
                              ▼
                         Keystone
                              │
                              ▼
                         Google OAuth
                              │
                              ▼
                         Keystone creates/updates user
                              │
                              ▼
                         Redirects back to your app
                              │
                              ▼
                   Your app calls GET /auth/me
```

After either login method, Keystone sets an HTTP-only session cookie. Your frontend uses that cookie to identify the user.

---

## Step 1 — Configure Keystone

Edit Keystone's `.env` file:

```env
# Database and Redis (already set by the setup wizard)
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379

# Google OAuth credentials from https://console.cloud.google.com/
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Cookie settings — very important
COOKIE_DOMAIN=localhost
COOKIE_SECURE=false

# Your frontend URL
ALLOWED_ORIGINS=http://localhost:5173
AUTH_API_PUBLIC_URL=http://localhost:4001

# Optional: where to send users after Google login
CLIENT_APP_URL=http://localhost:5173
```

Restart Keystone after changing `.env`.

### Why `COOKIE_DOMAIN=localhost`?

Your React app runs on `http://localhost:5173` and Keystone on `http://localhost:4001`. Browsers treat these as the same site only if the cookie domain is `localhost`. For production, put both apps under the same root domain (e.g. `app.yoursite.com` and `api.yoursite.com`) and set `COOKIE_DOMAIN=.yoursite.com`.

---

## Step 2 — Choose how to integrate

### Option A: One-line CDN script (fastest — nothing in your project folder)

Add one script tag to your page. The script is served directly by Keystone, so you do not copy any files into your project.

```html
<script
  src="http://localhost:4001/sdk/keystone-dropin.js"
  data-keystone-url="http://localhost:4001"
  data-keystone-after-login="/dashboard"
></script>
```

Then add IDs/classes to your existing form:

```html
<form id="keystone-login-form">
  <input class="keystone-email" type="email" />
  <input class="keystone-password" type="password" />
  <button type="submit">Login</button>
</form>

<button id="keystone-google-btn">Login with Google</button>
```

No other code needed. The script auto-wires the forms and talks to Keystone for you.

To connect/register your project with Keystone, add one more line:

```html
<script>
  Keystone.connect("my-project", "http://localhost:5173/callback")
    .then((c) => console.log("Connected:", c.clientId));
</script>
```

### Option B: Self-hosted drop-in script

If you prefer to host the script yourself, copy `examples/drop-in-login/dropin.js` into your project and include it:

```html
<script>
  window.KEYSTONE_URL = "http://localhost:4001";
  window.KEYSTONE_AFTER_LOGIN = "/dashboard";
</script>
<script src="/keystone-dropin.js"></script>
```

See `examples/drop-in-login/README.md`.

### Option C: React helper

Create `keystone-auth.ts` in your React project and copy the code from `examples/login-form-react/keystone-auth.ts`.

The key thing: every request uses `credentials: "include"` so the browser sends the session cookie.

---

## Step 3 — Replace your form handlers

Before (fake example):

```tsx
async function handleLogin(e) {
  e.preventDefault();
  const res = await fetch("/api/login", { ... });
}
```

After:

```tsx
import { loginWithPassword, registerAccount, loginWithGoogle } from "./keystone-auth";

async function handleLogin(e) {
  e.preventDefault();
  const { user } = await loginWithPassword(email, password);
  setUser(user);
}

async function handleSignup(e) {
  e.preventDefault();
  const { user } = await registerAccount(username, email, password, name);
  setUser(user);
}

// Google button just redirects:
<button onClick={loginWithGoogle}>Login with Google</button>
```

See `examples/login-form-react/LoginPage.example.tsx` for a complete working page.

---

## Step 4 — Check login status on page load

```tsx
import { useEffect, useState } from "react";
import { getCurrentUser } from "./keystone-auth";

function App() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    getCurrentUser().then(setUser);
  }, []);

  // ...
}
```

`GET /auth/me` returns the current user if the cookie is valid.

---

## Step 5 — Protect your backend API

If your backend needs to know who the user is, you have two options.

### Option A: Send the access token to your backend

After login, Keystone also returns an `accessToken` in the response body (for `/auth/token-login`) or in cookies. Your frontend can read it and send:

```ts
fetch("/api/profile", {
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
});
```

Your backend verifies the JWT using Keystone's public keys:

```ts
import { jwtVerify, createLocalJWKSet } from "jose";

const jwks = createLocalJWKSet(await fetch("http://localhost:4001/.well-known/jwks.json").then(r => r.json()));
const { payload } = await jwtVerify(token, jwks, { issuer: "http://localhost:4001" });
// payload.sub = user id, payload.email = email
```

See `examples/login-form-react/backend-example.ts`.

### Option B: Use API keys for server-to-server calls

For microservices or scripts, create an API key in Keystone and send:

```ts
fetch("/api/admin/users", {
  headers: { "X-API-Key": "keystone_xxxxxxxx" },
});
```

---

## Common problems

### CORS error

Make sure `ALLOWED_ORIGINS` includes your frontend URL exactly, including the port.

### Cookie not sent

Make sure every fetch uses `credentials: "include"` and `COOKIE_DOMAIN` is set correctly.

### Google login fails

- Check that the Google OAuth redirect URI is exactly: `http://localhost:4001/auth/callback/google`
- Make sure `AUTH_API_PUBLIC_URL` matches the URL Google redirects to.

### "Invalid OAuth state"

This usually means cookies are blocked. Check the cookie domain and `COOKIE_SECURE` settings.

---

## Next steps

- Add roles and permissions in the Keystone admin portal.
- Use `/v1/authz/check` to ask Keystone "can this user do X?" from your backend.
- Turn on audit logs and webhooks to track logins.
