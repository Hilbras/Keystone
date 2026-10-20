# Troubleshooting

Start with the `requestId`. Every JSON error body carries one, the response
header `request-id` carries the same value, and the access log line and every job
or webhook the request caused carry it too.

```bash
curl -sS -D - https://auth.example.com/health/ready
```

| Probe | Meaning |
| --- | --- |
| `GET /health/live` | The process is listening. No dependency is touched. |
| `GET /health/ready` | PostgreSQL answers (200 `ready`), and Redis is reported. `503` means the database is unreachable. |
| `GET /health/startup` | Boot finished. `503` while starting; the kubelet waits on this. |

## Authentication

**401 `UNAUTHORIZED`** — no credential, an expired token, or a token this
instance did not sign.

- Check `Authorization: Bearer <token>` or `x-api-key`.
- Decode the token and compare `iss` with `AUTH_API_PUBLIC_URL` and `aud` with the
  expected audience.
- An unknown `kid` is rejected, not silently verified with the active key. Fetch
  `/.well-known/jwks.json` and confirm the `kid` is listed; a key retired too
  early invalidates every token signed with it.
- Clock skew beyond the configured tolerance produces an expiry or not-before
  failure. Compare `exp`/`nbf` with the server clock.

**403 `FORBIDDEN`** — the credential is valid but the operation is not allowed.

- Organization routes: confirm membership and role. A non-member receives `404`
  rather than `403` for a resource in another tenant.
- Personal API keys: confirm the key carries the required scope.
- Platform routes: `platform_role` must be `owner`.
- CORS preflight failures look like a network error in the browser; check
  `ALLOWED_ORIGINS` and the application's `allowedOrigins`.

## Rate limiting

**429 `RATE_LIMITED`** — honour `Retry-After` and back off. The limiter is
per-endpoint and per-principal/address. If Redis is unavailable, Keystone falls
back to a bounded per-process limiter rather than removing the limit; a burst of
429s during a Redis outage is expected and is the protection working.

- `rate_limit_triggered` events and the `keystone_rate_limit_blocks_total` metric
  name the endpoint prefix.
- With several instances behind a proxy, set `KEYSTONE_TRUSTED_PROXIES`.
  Without it, client-identity headers are stripped by design and every client
  shares one budget.

## OAuth 2.0 / OIDC

**`invalid_client`** — the client id is unknown, or a confidential client did not
authenticate at the token endpoint.

**`invalid_grant`** — the code is expired, already consumed, bound to another
redirect URI, or the PKCE verifier does not match. Keystone validates the client,
redirect URI and PKCE *before* consuming the code, so a wrong verifier does not
burn the code. A genuine second redemption does, and is audited as a replay.

**`invalid_request`** — a required parameter is missing. `code_verifier` is
required for public clients; `redirect_uri` must match the one used at
authorization.

**Consent redirects back with `access_denied`** — the user is not a member of the
application's organization, or declined.

## Webhooks

- **Creation rejected with `INVALID_WEBHOOK_URL`** — the URL is not HTTPS in
  production, resolves to a private, loopback, link-local or metadata address, or
  is not absolute. This is SSRF protection; it is checked at creation and again at
  delivery, including after DNS resolution.
- **Deliveries fail with DNS or TLS errors** — the endpoint must be reachable from
  the Keystone process, not only from your laptop. Check egress rules.
- **Repeated 4xx** — a webhook is retried on transport failures and `5xx`; a
  `4xx` means the receiver rejected the payload and will keep rejecting it. Fix
  the receiver, then use `POST /v1/admin/platform/webhook-deliveries/:id/retry`.
- **Signature mismatch** — verify the HMAC over the raw request body, not a
  re-serialised object, and use the endpoint's current signing secret. Rotating a
  secret invalidates signatures made with the old one.
- **Duplicate processing** — deduplicate on `X-Keystone-Event-ID`; retries carry
  the same event id and a new `X-Keystone-Delivery-ID` attempt counter.
- Response bodies are not stored verbatim; diagnostics record the status code and
  a bounded excerpt, so a receiver that returns a large error page will not fill
  the database.

## Queue and background work

- `GET /v1/admin/platform/queue` reports per-queue counts and failed jobs.
- A job that exhausts its attempts moves to the failed list; retry it with
  `POST /v1/admin/platform/queue/failed/:id/retry` or all at once with
  `/v1/admin/platform/queue/retry-all`.
- In production, use the BullMQ provider with Redis. The in-process provider is
  for development and single-instance use; the boot validator warns when it is
  selected in production.
- After a crash, startup recovery re-claims jobs whose worker lease expired. A job
  that appears stuck should be checked against the lease timeout before being
  retried manually.

## Database

**`/health/ready` returns 503** — `select 1` failed. Check the connection string,
pool exhaustion and PostgreSQL logs. Readiness is intentionally strict: a pod that
cannot reach the database must leave the load-balancer rotation.

**Schema mismatch at boot** — the process verifies the expected tables and
columns. Run the migrations:

```bash
npm run db:migrate
```

See `docs/OPERATIONS/migrations.md` for the expand/migrate/contract procedure and
rollback guidance.

**Migration partially applied** — do not edit the migration journal by hand.
Restore from backup or forward-fix with a new migration; see
`docs/OPERATIONS/backup-restore.md`.

## Setup wizard

`POST /setup/init` creates the first platform owner. It is protected by a
database advisory lock and a transaction, so concurrent attempts produce exactly
one owner. A `409` means setup already completed; the setup status endpoint
exposes only what the wizard needs, not deployment internals.

If setup appears stuck, check `/setup/status` and the application log for the
migration or database validation step that failed.

## SDK

`@hilbras/keystone-client` maps status to error classes; catch
`ValidationError`, `AuthenticationError`, `AuthorizationError`,
`RateLimitError`, `NetworkError` and `ServerError` rather than parsing messages.
A write is never retried by default. If you opt in with `retry: true`, make the
operation safe to repeat first. See `docs/SDK.md`.

## Verifying a deployment

```bash
npm run verify:openapi   # the served OpenAPI document matches the package
npm run verify:client    # SDK error and retry contract
npm run verify:release   # published entry points exist in dist/
npm run registry:check   # every security finding still has a test and a doc
```

`GET /openapi.json` is the contract the running instance actually serves. Compare
its `info.version` with the image tag before debugging a client mismatch.
