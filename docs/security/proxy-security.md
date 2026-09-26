# Proxy Security

How to configure `KEYSTONE_TRUSTED_PROXIES` correctly, and what goes wrong when
you do not. For the underlying model see [trust-boundaries.md](./trust-boundaries.md).

## Configuration

```bash
KEYSTONE_TRUSTED_PROXIES="10.0.0.0/8,192.168.1.1,2001:db8::/32"
```

- Comma-separated. Each entry is an exact IP, an IPv4 CIDR, or an IPv6 prefix.
- Whitespace around entries is ignored.
- IPv4-mapped IPv6 peers (`::ffff:10.1.2.3` and the hex form `::ffff:0a01:0203`)
  are normalized to `10.1.2.3` before matching, so a dual-stack listener cannot
  slip past an IPv4 allowlist.
- **Empty or unset means trust nothing.** This is the default and the safe
  posture. Forwarded headers are stripped and the peer address is used.

Unrecognized input fails closed: a malformed address or prefix never matches, so
a typo disables trust rather than widening it.

## How the setting is applied

The value drives two things at startup:

1. **Fastify's `trustProxy`.** Derived from the same list. When the list is
   empty, `trustProxy` is `false`, so Fastify's own `request.ip` is the peer
   address and never `x-forwarded-for`.
2. **The header-sanitization hook.** Registered before every plugin and route.

`request.ip` is *not* used to decide whether a peer is trusted, because with
`trustProxy` enabled it is derived from the attacker-controlled header. The
decision always uses the socket peer address.

## What each header is used for

| Header | Trusted-proxy requests | Direct requests |
| --- | --- | --- |
| `x-forwarded-for` | Client address for rate limiting and logs | Stripped; peer address used |
| `x-real-ip` | Fallback when `x-forwarded-for` is absent | Stripped |
| `x-client-cert-fingerprint` | Service account identity | Stripped |
| `x-forwarded-client-cert` | Certificate subject evidence | Stripped |
| `x-service-account-id` | Hint, cross-checked against the certificate | Stripped |

Because direct requests have the headers removed, a client that reaches Keystone
bypassing the proxy gains nothing — it is treated as an untrusted peer.

## Rate limiting

The limiter keys on `clientAddress()`:

- **Behind a trusted proxy:** the left-most `x-forwarded-for` entry, which is
  the real client. Distinct clients get distinct budgets.
- **From any other peer:** the peer address. Rotating `x-forwarded-for` grants
  no additional budget.

This closes a bypass present before v2.0.0, where `trustProxy: true` combined
with an unconditional read of `x-forwarded-for` let any client present a fresh
address on every request and never be limited.

### Fail-open behavior

The limiter fails open when Redis is unavailable. That is a deliberate
availability choice, not part of the trust model, but it means rate limiting is
not an authentication control and must not be relied on as one.

## Required proxy configuration

Your proxy must meet all of these. Each one has caused a real bypass.

```nginx
# 1. Overwrite, never append: `$proxy_add_x_forwarded_for` would let a client
#    prepend a forged address. Use only $remote_addr, or the real-client module.
proxy_set_header X-Forwarded-For $remote_addr;

# 2. Strip inbound identity headers before setting your own, so a client's copy
#    cannot survive. `underscores_in_headers off` also rejects them outright.
proxy_set_header X-Forwarded-Client-Cert "";
proxy_set_header X-Client-Cert-Fingerprint "";
proxy_set_header X-Service-Account-Id "";
proxy_set_header X-Real-IP "";

# 3. Do not expose Keystone directly. It should be unreachable except from the
#    proxy, or the trusted range does not mean what you think.
```

For AWS ALB, the same requirements in Terraform:

```hcl
resource "aws_lb_listener" "https" {
  protocol            = "HTTPS"
  certificate_arn     = var.certificate_arn
  ssl_policy          = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  # Client certificate validation for mTLS:
  mutual_tls {
    mode = "verify"
  }
}
```

ALB sets `$ssl_client_fingerprint` in colon-separated uppercase hex. Map it to
`X-Client-Cert-Fingerprint`; Keystone canonicalizes the form.

## Verifying a deployment

From a host that is **not** in the trusted range:

```bash
# Must not be believed: expect the peer address in logs, not 198.51.100.9.
curl -sS -H 'X-Forwarded-For: 198.51.100.9' https://keystone.example/health

# Must be stripped: expect 401, never 200.
curl -sS -H 'X-Service-Account-Id: <any-uuid>' https://keystone.example/some/protected/route
```

From **inside** the trusted range, forwarded addresses should be honoured and
separate clients should have separate rate-limit budgets.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Every client shares one rate-limit budget | Proxy address not in the list, so all requests key on the proxy's peer address |
| Legitimate mTLS requests get `401 MTLS_UNTRUSTED_PEER` | Proxy not in the list, so certificate headers are stripped |
| `401 MTLS_CERTIFICATE_UNMAPPED` | Certificate presented correctly, but no active service account has that fingerprint bound |
| `403` with no certificate header reaching handlers | Fingerprint malformed; must be 64 hex characters, optionally colon-separated |
| Works locally, fails in production | Development ran with an empty list; production needs the list set |
