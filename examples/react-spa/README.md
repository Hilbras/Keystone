# Keystone React SPA Example

Minimal example of connecting a React single-page application to Hilbras Keystone using OAuth2 + PKCE.

## Setup

1. Register an application in Keystone (Admin Portal → Applications → New).
   - Type: `spa`
   - Redirect URI: `http://localhost:5174/callback`
   - Allowed scopes: `openid profile email`

2. Copy the generated **Client ID**.

3. Create a `.env.local` file in this folder:

```bash
VITE_KEYSTONE_URL=http://localhost:4001
VITE_KEYSTONE_CLIENT_ID=<your-client-id>
VITE_KEYSTONE_REDIRECT_URI=http://localhost:5174/callback
```

4. Copy the example files into a Vite React project:

```bash
npm create vite@latest my-app -- --template react-ts
cd my-app
# copy keystone-auth.ts and App.example.tsx contents into your project
npm install
npm run dev
```

## Flow

1. User clicks **Login with Keystone**.
2. Browser is redirected to Keystone `/oauth2/authorize` with PKCE challenge.
3. After authentication, Keystone redirects back to `/callback?code=...`.
4. SPA exchanges the code for tokens via `/oauth2/token`.
5. Access token is stored in `localStorage` and sent as `Authorization: Bearer <token>` to your backend.

## Security notes

- Never store client secrets in a SPA.
- Use PKCE (`S256`) for all public clients.
- Prefer `HttpOnly` cookies for production apps when you control the backend.
- Validate tokens on your backend, not just in the browser.
