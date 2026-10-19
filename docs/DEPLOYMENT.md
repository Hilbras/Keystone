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
- [ ] `KEYSTONE_ALLOW_INSECURE_WEBHOOK` and `ALLOW_PRIVATE_WEBHOOK_TARGETS` are
      **unset** — both are development affordances, and neither is checked by a
      gate (plan §6.1 will validate unsafe production settings as a class)

---

## First-run setup

Before the platform has an owner, `POST /setup/init` creates one. Two properties
of that endpoint are worth knowing when you deploy several instances at once.

### `GET /setup/status` returns `needsSetup` and nothing else

The wizard calls it before any credential exists, so it is unauthenticated and
everything it returns is readable by anyone who can reach the port. It used to
also return a boolean saying whether a setup token was configured — a one-bit
answer to "is this instance unclaimed, and is there a token between me and owning
it". Only `needsSetup` is returned now.

### The bootstrap is serialized

`/setup/init` runs behind a Postgres advisory lock (`keystone:setup:bootstrap`,
session-scoped and taken on a reserved connection). The owner check is repeated
*inside* the lock, and that inner check is the one that decides.

Without it, two instances receiving the first requests at the same time both read
"no owners" and both wrote, so a fresh deployment answered its first simultaneous
callers with more than one platform owner. Nothing in the database prevented it:
keystone protects the *last* owner from being demoted, and says nothing about how
many may exist.

The outcomes a caller can see:

| status | meaning |
|---|---|
| `200` | this caller bootstrapped the platform |
| `409` | another instance holds the lock and is bootstrapping now — retry |
| `403` | setup has already completed |

Because the lock is a database lock, it works across containers and across hosts
that share one PostgreSQL. There is no configuration for it.

---

## Observability

| endpoint | auth | answers |
|---|---|---|
| `GET /health`, `GET /health/live` | none | liveness — `ok`, and it touches nothing external |
| `GET /health/startup` | none | `200` once boot finished, `503` until then |
| `GET /ready`, `GET /health/ready` | none | readiness — runs `select 1` and `ping` |
| `GET /metrics` | none | Prometheus |
| `GET /v1/admin/platform/diagnostics` | platform owner | database, Redis, queue backlog, worker identity, key state, configuration warnings |

**`/ready` answers `503` only when PostgreSQL is unreachable.** With Redis down it
answers `200 degraded`, because an instance with no Redis can still authenticate;
taking every pod out of the rotation would turn a recoverable degradation into an
outage. Watch `checks.redis.ok` in the body, or the queue metrics, rather than the
status code.

Point the kubelet at all three: a `startupProbe` on `/health/startup` with a
generous `failureThreshold` (the shipped manifest allows 40 × 10s for migrations
and key loading), a `livenessProbe` on `/health/live`, and a `readinessProbe` on
`/health/ready`. A startup probe that never succeeds is never followed by the
liveness probe, so a wrong path there hangs a pod forever instead of restarting it.

### Logs

One JSON object per line, with `requestId`, `traceId`, `operation`, `method`,
`path`, `statusCode`, `result`, `errorCode`, `durationMs`, `actorId` and
`tenantId` where the request has them. `KEYSTONE_LOG_LEVEL` sets the level for
both this and Fastify's own logger.

**Query strings are stripped before anything is written.** On this API the query
string is where credentials travel — `/auth/magic-link/verify?token=…` is the
whole authentication — and audit records are not only stored, they are delivered
to webhook subscribers. That applies to the access log, Fastify's `incoming
request` line, the audit events and every webhook payload.

The trace id is carried into background work: a job enqueued by a request logs
under that request's `traceId`, in another process and possibly a day later, and
webhook deliveries send it as `X-Keystone-Trace-ID`.

### Diagnostics

`GET /v1/admin/platform/diagnostics` is the answer to "what does this instance
think is going on" — every dependency read at the same moment, which is what
makes a cause-and-effect reading possible at all. It never echoes the
environment: key `kid`s and `createdAt`, never key material; the secrets
provider's *name*, not its configuration.

If `keys.active` and `keys.published` disagree, that is worth understanding
before a key rotation: with `JWT_PRIVATE_KEY` set, this process signs with the
environment key and never consults the database, so `keys.active` can list keys
nothing is using.

---

## Scaling

For high traffic:

- Use a managed PostgreSQL (AWS RDS, Supabase, etc.).
- Use managed Redis (Redis Cloud, AWS ElastiCache).
- Run multiple Keystone containers behind a load balancer.
- Ensure `KEYSTONE_ENCRYPTION_KEY` and signing keys are shared between instances.
