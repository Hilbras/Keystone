# Deploying Keystone Online

This guide explains how to run Hilbras Keystone on a public server so external projects can connect to it over the internet.

---

## Architecture

```
Internet
   │
   ├──► https://app.yourdomain.com     (your React/Vue/Angular app)
   │
   └──► https://auth.yourdomain.com    (Keystone identity server)
             │
             ├──► PostgreSQL
             ├──► Redis
             └──► Google / GitHub / etc.
```

Your frontend and Keystone run as two separate services. The frontend loads the Keystone SDK from the Keystone domain and talks to it via HTTPS.

---

## What you need

1. A server or VPS (e.g. AWS, DigitalOcean, Hetzner, Fly.io).
2. A domain name.
3. Two DNS records pointing to your server:
   - `auth.yourdomain.com` → your server IP
   - `app.yourdomain.com` → your server IP (or another host for your frontend)
4. Docker and Docker Compose installed on the server.
5. SSL certificate (use Caddy, Nginx + Let's Encrypt, or Cloudflare).

---

## Step 1 — Prepare environment variables

You can configure almost everything through the Keystone setup wizard in the browser. You only need a minimal `.env` to start the wizard the first time.

Create `.env` on the server with just enough to launch the setup UI:

```env
NODE_ENV=production
PORT=4001
HOST=0.0.0.0
KEYSTONE_SETUP_MODE=true
```

Then run:

```bash
docker compose up -d
```

Open `https://auth.yourdomain.com/setup` and fill in:

- Database URL
- Redis URL
- Public Keystone URL (`https://auth.yourdomain.com`)
- Client app URL (`https://app.yourdomain.com`)
- Allowed CORS origins (`https://app.yourdomain.com`)
- Cookie domain (`.yourdomain.com`)
- Secure cookies (enabled for HTTPS)
- Auto-generated internal API key and encryption key
- Google OAuth credentials
- Email/SMS providers

The wizard writes `.env` for you. No file editing needed after the first launch.

If you prefer to pre-configure everything in `.env` instead, use:

```env
NODE_ENV=production
PORT=4001
HOST=0.0.0.0

DATABASE_URL=postgresql://hilbras:strong-password@postgres:5432/hilbras
REDIS_URL=redis://redis:6379

AUTH_API_PUBLIC_URL=https://auth.yourdomain.com
CLIENT_APP_URL=https://app.yourdomain.com
ALLOWED_ORIGINS=https://app.yourdomain.com

COOKIE_DOMAIN=.yourdomain.com
COOKIE_SECURE=true

KEYSTONE_INTERNAL_API_KEY=change-me-to-a-long-random-string
KEYSTONE_ENCRYPTION_KEY=...

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

EMAIL_PROVIDER=smtp
EMAIL_FROM=noreply@yourdomain.com
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_SECURE=true
```

---

## Step 2 — Update Google OAuth redirect URI

In Google Cloud Console, add:

```
https://auth.yourdomain.com/auth/callback/google
```

Remove or keep the localhost URI only for local development.

---

## Step 3 — Deploy with Docker Compose

Copy the project to the server, then run:

```bash
docker compose up -d
```

This starts PostgreSQL, Redis, and Keystone.

For the first run, enable setup mode so the wizard creates the owner account:

```bash
KEYSTONE_SETUP_MODE=true docker compose up -d
```

Then open the setup UI (port 5173 if exposed, or use the backend setup endpoints) and complete setup.

---

## Step 4 — Put Keystone behind HTTPS

### Option A: Caddy (simplest)

Create `Caddyfile`:

```
auth.yourdomain.com {
  reverse_proxy localhost:4001
}

app.yourdomain.com {
  root * /var/www/app
  file_server
}
```

Run Caddy:

```bash
caddy run
```

Caddy automatically obtains and renews Let's Encrypt certificates.

### Option B: Nginx + Let's Encrypt

Use `certbot` to obtain certificates and proxy to Keystone:

```nginx
server {
  listen 443 ssl;
  server_name auth.yourdomain.com;

  ssl_certificate /etc/letsencrypt/live/auth.yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/auth.yourdomain.com/privkey.pem;

  location / {
    proxy_pass http://localhost:4001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    # $remote_addr, NOT $proxy_add_x_forwarded_for. The append form lets a client
    # prepend a forged address, which then becomes the value Keystone believes.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Drop inbound identity headers. Keystone ignores them from untrusted peers
    # anyway, but stripping them here keeps a misconfiguration from being
    # exploitable and keeps the proxy honest.
    proxy_set_header X-Forwarded-Client-Cert "";
    proxy_set_header X-Client-Cert-Fingerprint "";
    proxy_set_header X-Service-Account-Id "";
  }
}
```

**Set the trusted proxy list.** Since 2.0.0, Keystone does not believe
forwarded headers unless the request arrived from a configured proxy, and it
keys rate limits on the peer address otherwise — which, behind a reverse proxy,
means every client shares one budget:

```bash
KEYSTONE_TRUSTED_PROXIES="127.0.0.1,::1"
```

Use the address the proxy connects from. Keep the list as narrow as possible.
Full requirements, including why each header matters:
[security/proxy-security.md](security/proxy-security.md).

### Option C: Cloudflare

Point your DNS to Cloudflare, enable the orange cloud, and set SSL/TLS to **Full (strict)**. No extra certificate setup needed.

---

## Step 5 — Update your project's script tag

In your frontend `index.html`, change the SDK URL to production:

```html
<script
  src="https://auth.yourdomain.com/sdk/keystone-dropin.js"
  data-keystone-url="https://auth.yourdomain.com"
  data-keystone-after-login="https://app.yourdomain.com/dashboard"
></script>
```

And connect the project:

```html
<script>
  Keystone.connect("my-project", "https://app.yourdomain.com/callback")
    .then((c) => console.log("Connected:", c.clientId));
</script>
```

---

## Important production checklist

- [ ] HTTPS everywhere
- [ ] `COOKIE_SECURE=true`
- [ ] `COOKIE_DOMAIN=.yourdomain.com` (with leading dot)
- [ ] `ALLOWED_ORIGINS` set to your frontend domain only
- [ ] Strong `KEYSTONE_INTERNAL_API_KEY` and `KEYSTONE_ENCRYPTION_KEY`
- [ ] Google OAuth redirect URI is the HTTPS production URL
- [ ] Database and Redis are not exposed to the internet
- [ ] Regular backups of PostgreSQL data
- [ ] Server firewall allows only ports 80, 443, and SSH

---

## Scaling

For high traffic:

- Use a managed PostgreSQL (AWS RDS, Supabase, etc.).
- Use managed Redis (Redis Cloud, AWS ElastiCache).
- Run multiple Keystone containers behind a load balancer.
- Ensure `KEYSTONE_ENCRYPTION_KEY` and signing keys are shared between instances.
