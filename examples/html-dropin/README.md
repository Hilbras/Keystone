# Keystone HTML Drop-in Example

Add Keystone authentication to any plain HTML project with **one script tag**.

## What it demonstrates

- Password login
- Password registration
- Google OAuth sign-in
- Automatic session detection on page load
- Logout

## Prerequisites

Auth endpoints (`/auth/*`, `/sdk/*`, `/auth/oauth/*`) are only available after Keystone setup is complete:

1. Finish the setup wizard at `http://localhost:5173`.
2. Make sure `.keystone-setup-complete` exists in the project root.
3. Restart Keystone in normal mode.

## Run it locally

1. Start Keystone in normal/production mode:
   ```bash
   ./start.sh --production
   ```

2. Serve this folder from a local web server (not `file://`):
   ```bash
   cd examples/html-dropin
   npx serve .
   # or
   python3 -m http.server 5500
   ```

3. Open the URL it prints, usually `http://localhost:3000` or `http://localhost:5500`.

4. Sign up, sign in, or use Google.

## The one-line integration

```html
<script src="http://localhost:4001/sdk/keystone-dropin.js"
        data-keystone-url="http://localhost:4001"
        data-keystone-project-id="my-html-project"
        data-keystone-callback="/callback.html"
        data-keystone-autowire="true"
        data-keystone-check-session="true"></script>
```

That single script:

1. Connects the project to Keystone via `/sdk/connect`.
2. Auto-wires forms and buttons by ID or data attribute.
3. Checks whether the user is already signed in.
4. Toggles the page state using `html[data-keystone-authenticated="true"]`.

## Supported IDs and attributes

| Element | ID | Data attribute |
|---|---|---|
| Login form | `id="keystone-login-form"` | `data-keystone-form="login"` |
| Register form | `id="keystone-register-form"` | `data-keystone-form="register"` |
| Google button | `id="keystone-google-btn"` | `data-keystone-google` |
| Logout button | `id="keystone-logout"` | `data-keystone-logout` |
| Email input | `id="keystone-email"` or class `.keystone-email` | `data-keystone-input="email"` |
| Password input | `id="keystone-password"` or `.keystone-password` | `data-keystone-input="password"` |
| Username input | `id="keystone-username"` or `.keystone-username` | `data-keystone-input="username"` |
| Name input | `id="keystone-name"` or `.keystone-name` | `data-keystone-input="name"` |
| Display email | — | `data-keystone-field="email"` |
| Display name | — | `data-keystone-field="name"` |
| Display username | — | `data-keystone-field="username"` |

Use CSS to show/hide authenticated content:

```css
.auth-only { display: none; }
html[data-keystone-authenticated="true"] .auth-only { display: block; }
html[data-keystone-authenticated="true"] .guest-only { display: none; }
```

## Deploying to a server

When you upload Keystone to a server, change the script `src` and `data-keystone-url` from `http://localhost:4001` to your real Keystone URL:

```html
<script src="https://keystone.yourdomain.com/sdk/keystone-dropin.js"
        data-keystone-url="https://keystone.yourdomain.com"
        data-keystone-project-id="my-production-project"
        data-keystone-callback="https://yourapp.com/callback.html"
        data-keystone-autowire="true"
        data-keystone-check-session="true"></script>
```

Also update your `.env` on the server:

```env
AUTH_API_PUBLIC_URL=https://keystone.yourdomain.com
ALLOWED_ORIGINS=https://yourapp.com,https://admin.yourapp.com
COOKIE_SECURE=true
COOKIE_DOMAIN=.yourdomain.com
```

For production, create the application inside the Keystone admin dashboard instead of relying on the public `/sdk/connect` endpoint.

## Manual SDK usage

If you prefer JavaScript:

```js
await Keystone.connect("my-project", "http://localhost:5500/callback.html");
const user = await Keystone.getUser();
await Keystone.login(email, password);
await Keystone.register(username, email, password, name);
Keystone.loginWithGoogle();
await Keystone.logout();
```

## Important notes

- **Do not open `index.html` directly from the file system.** Browsers send `Origin: null` for `file://` URLs, which breaks cookies. Always serve it from `http://localhost:PORT` or a real domain.
- The `Keystone.connect()` endpoint creates a public application entry in Keystone. In production, create applications from the Keystone admin dashboard instead.
- For Google OAuth to work, configure Google client credentials in Keystone (Dashboard → Identity Providers → Google) and add `https://keystone.yourdomain.com/auth/callback/google` as an authorized redirect URI in Google Cloud Console.
- If you see `CORS header missing` or `500` errors on `/auth/register`, Keystone is probably still in setup mode. Finish setup and restart with `./start.sh --production`.
