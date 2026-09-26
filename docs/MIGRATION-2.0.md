# Migrating to Keystone 2.0.0

Keystone 2.0.0 reworks the mTLS trust boundary. Before this release, any client
that could reach Keystone could name a service account in a request header and
become it, and could set its own IP address to escape every rate limit. Both are
closed.

**This is a breaking release.** Two behaviours change in ways that will break a
deployment that relied on the old ones, and one of them fails silently until
traffic arrives.

Review this page before upgrading a production deployment.

---

## Summary

| # | Change | Impact |
| --- | --- | --- |
| 1 | `x-service-account-id` no longer authenticates | **Breaking** — mTLS clients stop working until a certificate is bound |
| 2 | `trustProxy` and `x-forwarded-for` are no longer believed by default | **Breaking, silent** — all clients behind a proxy share one rate-limit budget |
| 3 | Service accounts bind to a certificate fingerprint | New: `cert_fingerprint` column, unique |
| 4 | Service accounts can be revoked | New: `revoked_at` column, `POST .../revoke` |
| 5 | Identity headers are stripped from untrusted peers | New: hardens any route reading them |

A database migration runs automatically and is additive — no data is rewritten
or dropped.

---

## 1. `x-service-account-id` no longer authenticates

**Breaking.** Any mTLS integration that authenticated by sending only
`x-service-account-id` stops working immediately.

In 1.x, that header was sufficient on its own:

```http
GET /some/protected/route
X-Service-Account-Id: 6f1c...-...
```

No certificate, no credential. Anyone who knew or guessed a service account ID
became that account.

In 2.0.0, a header never establishes identity. A service account must present
either a client certificate whose fingerprint is bound to it, or an
authenticated credential (API key, session, or bearer token).
`x-service-account-id` is still read, but only as a hint alongside a valid
certificate, and only when the account it names is the one the certificate is
bound to. A mismatch is refused rather than falling back.

### What to do

If you were using this header, you need a client certificate and a binding:

```bash
# 1. Fingerprint of the caller's certificate
openssl x509 -in client.pem -outform DER | openssl dgst -sha256 -hex

# 2. Bind it to the service account
curl -X PUT https://keystone.example/v1/admin/organizations/$ORG/service-accounts/$ACCOUNT/certificate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"fingerprint":"abcd...9f"}'
```

If your callers use API keys instead of certificates, nothing changes — that
path was always credential-based.

See [security/mtls.md](./security/mtls.md).

---

## 2. `x-forwarded-for` is no longer believed by default

**Breaking, and it fails silently.** Read this one carefully.

In 1.x the server was created with `trustProxy: true`, and the rate limiter read
`x-forwarded-for` unconditionally. Two consequences:

- Every client behind a proxy was attributed to its real address — which sounds
  right, but was indistinguishable from a client claiming one.
- Any client could send a fresh `x-forwarded-for` on every request and never hit
  a rate limit. Authenticated endpoints with rate limits — login, password
  reset, MFA verification, SCIM — were all reachable at full speed.

In 2.0.0, forwarded headers are believed only when the request arrived from an
address in `KEYSTONE_TRUSTED_PROXIES`. That variable is **unset by default**.

**The failure mode:** behind a proxy with the variable unset, every request is
attributed to the proxy's own address. All of your clients now share a single
rate-limit budget. Login attempts across the whole deployment count against the
same counter, so a burst of legitimate traffic from unrelated users will start
returning `429` to everyone.

This is deliberate — fail-closed, and the previous default was exploitable. But
it must be configured for a proxied deployment.

### What to do

If Keystone sits behind a proxy, set the proxy's addresses:

```bash
KEYSTONE_TRUSTED_PROXIES="10.0.0.0/8,192.168.1.1"
```

Comma-separated exact IPs, IPv4 CIDRs, or IPv6 prefixes. Keep it as narrow as
your deployment allows — trusting a shared CIDR lets any host in it assert any
client identity. Leave it unset only when Keystone is genuinely exposed directly
to clients.

Then confirm your proxy **overwrites** rather than appends `x-forwarded-for`, and
strips inbound identity headers. Both are required; see
[security/proxy-security.md](./security/proxy-security.md).

### Verifying

```bash
# From a host outside the trusted range: this must NOT be believed.
curl -sS -H 'X-Forwarded-For: 198.51.100.9' https://keystone.example/health

# Repeated logins from two "different" addresses must still share one budget.
for ip in 198.51.100.1 198.51.100.2 198.51.100.3; do
  curl -sS -o /dev/null -w '%{http_code} ' -H "X-Forwarded-For: $ip" \
    https://keystone.example/auth/login -d '{}' -H 'Content-Type: application/json'
done
```

Also watch for `429` spikes on `auth/login` after upgrading. That symptom means
the trusted-proxy list is not set correctly.

---

## 3. Certificates are bound to a fingerprint

New column `service_accounts.cert_fingerprint`, with a unique index. A
certificate can map to at most one service account.

Fingerprints are stored canonicalized, so the hex and colon-separated spellings
of one certificate cannot become two bindings. A malformed fingerprint is
rejected rather than stored.

Existing service accounts have `cert_fingerprint = NULL` and continue to work
with API keys. Only certificate authentication is affected.

## 4. Service accounts can be revoked

New column `service_accounts.revoked_at`, and:

```http
POST /v1/admin/organizations/:id/service-accounts/:accountId/revoke
```

Sets `is_active = false` and stamps `revoked_at`, stopping both certificate and
API-key authentication. Revoking an already-revoked account returns `409`.

Separate from `is_active` so that re-enabling does not silently restore access.

## 5. Identity headers are stripped from untrusted peers

A new `onRequest` hook deletes `x-forwarded-for`, `x-real-ip`, `forwarded`,
`x-forwarded-client-cert`, `x-client-cert-fingerprint`, `x-service-account-id`,
and `x-forwarded-client-cert-chain` from any request whose peer is not a trusted
proxy.

This runs before routing and before authentication, so a route cannot read a
spoofed identity even by accident.

**If you have custom middleware that reads these headers**, it will now see
`undefined` for direct requests. That is intended. Such middleware was reading
attacker-controlled data.

---

## New configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KEYSTONE_TRUSTED_PROXIES` | unset (trust nothing) | Proxies permitted to set client-identity headers |

---

## Deployment checklist

- [ ] Read [security/proxy-security.md](./security/proxy-security.md)
- [ ] Set `KEYSTONE_TRUSTED_PROXIES` if Keystone is behind a proxy
- [ ] Confirm the proxy **overwrites** `x-forwarded-for` and strips inbound identity headers
- [ ] Confirm Keystone is not directly reachable from untrusted networks
- [ ] Bind a certificate fingerprint to every mTLS service account (or confirm none use mTLS)
- [ ] Verify logins are not being rate-limited across unrelated clients
- [ ] Review any custom middleware that reads identity headers
- [ ] Run the database migration (automatic on startup)
- [ ] After upgrading, watch for `429` on `/auth/login` and `MTLS_UNTRUSTED_PEER` / `MTLS_UNTRUSTED_PEER`-adjacent `401`s

## Rolling back

The migration is additive — `cert_fingerprint` and `revoked_at` are nullable
columns, and the new unique index is partial (non-null values only). Rolling
back to 1.9.x leaves both columns in place and unused; nothing needs undoing
manually.

The application rollback is straightforward, but note that 1.9.x reintroduces the
`x-service-account-id` bypass. Prefer fixing the configuration forward.
