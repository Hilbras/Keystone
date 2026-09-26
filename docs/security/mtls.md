# mTLS Service Accounts

Mutual-TLS authentication for service accounts: how a caller proves which
service account it is, and what Keystone does and does not verify.

For the proxy and trust configuration this depends on, see
[proxy-security.md](./proxy-security.md) and
[trust-boundaries.md](./trust-boundaries.md).

## The model

```text
Keystone  ←  trusted proxy  ←  client with a client certificate
                                    │
                                    └── proxy validates the chain, then tells
                                        Keystone the SHA-256 fingerprint
```

Keystone receives a *fingerprint*, not a certificate. It does not validate the
certificate, the chain, or the CA — the proxy does that, and Keystone trusts its
verdict only from a configured trusted peer.

Keystone's own contribution is binding that fingerprint to exactly one service
account, and refusing to let anything else establish identity.

## Identity sources

A service account authenticates by **either**:

- **A client certificate** whose fingerprint is bound to the account via
  `service_accounts.cert_fingerprint`, presented through a trusted proxy.
- **An authenticated credential**: an API key issued to the account, or a
  session/bearer token belonging to it.

There is no third source. In particular, no header establishes identity on its
own. Before v2.0.0, `x-service-account-id` alone authenticated as any service
account named in the header, with no certificate and no credential — anyone who
could reach Keystone could become any service account. That path is removed.

## Binding a certificate

The fingerprint is a SHA-256 digest, in hex or the colon-separated form AWS ALB
emits. Keystone stores it canonicalized, so the two spellings of one certificate
cannot become two bindings.

Get the fingerprint of a client certificate:

```bash
openssl x509 -in client.pem -noout -fingerprint -sha256
# SHA256 Fingerprint=AB:CD:...:9F   (colon-separated, uppercase)
```

```bash
openssl x509 -in client.pem -outform DER | openssl dgst -sha256 -hex
# SHA2-256(stdin)= abcd...9f        (plain hex, lowercase)
```

Then bind it:

```bash
curl -X PUT https://keystone.example/v1/admin/organizations/$ORG/service-accounts/$ACCOUNT/certificate \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"fingerprint":"ABCD...9F"}'
```

Audits as `service_account_certificate_bound`. Binding a certificate already
held by another account returns `409` — the unique index on `cert_fingerprint`
enforces one certificate per account.

Clear the binding with `{"fingerprint": null}` (audits as
`service_account_certificate_unbound`). The account then authenticates only with
an API key.

## Revoking

```bash
curl -X POST https://keystone.example/v1/admin/organizations/$ORG/service-accounts/$ACCOUNT/revoke \
  -H "Authorization: Bearer $TOKEN"
```

Sets `is_active = false` and stamps `revoked_at`. A revoked account cannot
authenticate by certificate or API key, and disappears from reads. Revoking an
already-revoked account returns `409` rather than a silent success, so a caller
can tell the difference.

Revocation is separate from `is_active` so that re-enabling an account does not
quietly restore access — restoring it requires deliberately clearing
`revoked_at`.

## Responses from `requireMTLS`

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `MTLS_UNTRUSTED_PEER` | Request did not come from a configured trusted proxy. A misconfiguration, not an attack. |
| 401 | `MTLS_CERTIFICATE_MISSING` | Trusted proxy, but no certificate was forwarded |
| 401 | `MTLS_FINGERPRINT_MISSING` | Certificate forwarded, but no usable fingerprint header |
| 403 | `MTLS_CERTIFICATE_UNMAPPED` | Valid fingerprint, but no active service account is bound to it |

401 means the request was not authenticated; 403 means it was identified but is
not permitted. A malformed fingerprint is a 401 — it never reaches the database
as a lookup key.

## Using it on a route

`app.requireMTLS` is available as a pre-handler on any route:

```ts
app.get("/internal/report", { preHandler: [app.requireMTLS] }, async (request) => {
  // request.serviceAccount is the bound, active account.
  return buildReport(request.serviceAccount.orgId);
});
```

## What Keystone does not verify

- **Certificate chain, expiry, revocation, or CA.** The proxy's responsibility.
  If the proxy accepts an expired certificate, Keystone accepts its fingerprint.
- **That the proxy checked anything.** Keystone trusts the peer address, not the
  proxy's honesty. A compromised trusted host is a full bypass by design.
- **Certificate-to-account provenance.** Keystone records a fingerprint; it
  cannot tell you who issued the certificate.

## Operational notes

- Removing a certificate from the proxy's accepted list is **not** sufficient to
  revoke an account. Revoke the account, or clear the binding.
- Rotating a client certificate means a new fingerprint. Update the binding
  before the old certificate expires, or the account stops authenticating at the
  moment the proxy rolls the certificate.
- A fingerprint can only ever map to one account. Two accounts cannot share a
  certificate; give each caller its own.
