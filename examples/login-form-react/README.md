# Connect a Login/Signup Form to Keystone

This example shows the simplest way to connect an existing React login/signup page (with email/password and "Login with Google") to Hilbras Keystone.

## What you need

1. A Keystone server running (e.g. `http://localhost:4001`).
2. Google OAuth credentials (Client ID + Client Secret).
3. Your React app running on a domain that Keystone accepts cookies for.

## Step 1 — Configure Keystone

Add these environment variables to Keystone's `.env`:

```env
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret

# Cookie must be valid for both Keystone and your frontend.
# If Keystone runs on localhost:4001 and your app on localhost:5173, use:
COOKIE_DOMAIN=localhost
COOKIE_SECURE=false

# Allow your frontend to call the API
ALLOWED_ORIGINS=http://localhost:5173
AUTH_API_PUBLIC_URL=http://localhost:4001
```

Restart Keystone.

## Step 2 — Add the auth helper to your React app

Copy `keystone-auth.ts` into your project. It exports:

- `loginWithPassword(email, password)`
- `registerAccount(username, email, password, name)`
- `loginWithGoogle()`
- `logout()`
- `getCurrentUser()`

## Step 3 — Wire it into your form

Copy `LoginPage.example.tsx` and adapt it to your styling.

## How it works

### Email / password

Your form calls `POST http://localhost:4001/auth/login`. Keystone validates the password, creates a session, and returns an HTTP-only cookie plus the public user object.

### Google

Clicking the Google button opens `http://localhost:4001/auth/oauth/google`. Keystone redirects to Google, the user consents, then Keystone creates/updates the user account and redirects back to your app with a session cookie.

### Checking login status

After either flow, call `GET http://localhost:4001/auth/me` with `credentials: "include"`. If the cookie is valid, Keystone returns the current user.

## Important: CORS and cookies

For cookies to travel between your React app and Keystone, both must be considered the "same site" by the browser. The easiest local setup:

- Serve both from `localhost` (different ports are fine).
- Set `COOKIE_DOMAIN=localhost` in Keystone.
- Make every fetch request with `credentials: "include"`.
- Set `ALLOWED_ORIGINS` to your frontend URL.

For production, run both apps under the same root domain, e.g.:

- `https://keystone-api.yourapp.com`
- `https://app.yourapp.com`

And set `COOKIE_DOMAIN=.yourapp.com`.
