# Trust Boundaries

Keystone's security model rests on one distinction: **which values a client
cannot forge**. This document names those values, states where they come from,
and lists what is deliberately not trusted.

## The deployment model

```text
                    ┌──────────────────────────────────────────┐
                    │              Internet                    │
                    └───────────────────┬──────────────────────┘
                                        │  attacker-controlled
                    ┌───────────────────▼──────────────────────┐
                    │        Trusted reverse proxy (LB)        │
                    │  - terminates TLS                         │
                    │  - validates client certificates (mTLS)   │
                    │  - overwrites forwarded identity headers │
                    └───────────────────┬──────────────────────┘
                                        │  peer address is the proxy's
                    ┌───────────────────▼──────────────────────┐
                    │                Keystone                   │
                    │  trusts forwarded headers ONLY from       │
                    │  KEYSTONE_TRUSTED_PROXIES                 │
                    └──────────────────────────────────────────┘
```

Keystone may also run with no proxy at all. Every rule below holds in both
layouts; only the trusted-proxy list changes.

## Unforgeable values

| Value | Source | Trustworthy because |
| --- | --- | --- |
| Peer address | TCP connection (`socket.remoteAddress`) | Established by the network stack; a client cannot set it |
| Session cookie / bearer token | Cryptographic check against stored state | Requires a secret the client must already hold |
| API key | Hashed lookup against a stored secret | Same |
| Client certificate | Validated by the proxy, forwarded as a fingerprint | Only believed from a trusted peer, and bound to a service account in the database |

## Forged values

These arrive in request headers and are attacker-controlled unless the peer is a
configured trusted proxy:

- `x-forwarded-for`, `x-real-ip`, `forwarded` — the apparent client address
- `x-forwarded-client-cert`, `x-client-cert-fingerprint` — the client certificate
- `x-service-account-id` — a service account identifier

When the peer is **not** a trusted proxy, Keystone deletes these headers in an
`onRequest` hook before routing, authentication, or any handler runs. Stripping
rather than ignoring them means a route added later cannot read a spoofed
identity by accident.

## Trust decisions and where they are made

| Decision | Made in | Rule |
| --- | --- | --- |
| Is this peer a trusted proxy? | `isFromTrustedProxy()` | Peer address is in `KEYSTONE_TRUSTED_PROXIES` |
| What is the client address? | `clientAddress()` | Forwarded headers only when the peer is trusted; otherwise the peer |
| Is this certificate identity real? | `extractClientCert()` | Requires a trusted peer **and** a well-formed SHA-256 fingerprint |
| Which service account is it? | `resolveByFingerprint()` | The fingerprint is bound to exactly one account in the database |

All four live in `src/services/trustedProxies.ts` and `src/plugins/mtls.ts`.

## Identity must come from a credential

A service account authenticates in one of two ways, and never a third:

```text
validated client certificate   (fingerprint bound to the account)
        OR
authenticated credential       (API key, session, or bearer token)
```

There is deliberately **no** header-only path. `x-service-account-id` is accepted
only as a hint alongside a valid certificate, and only when the account it names
is the account bound to the presented certificate. A mismatch fails rather than
falling back — a disagreement is treated as a spoofing signal.

## Threat assumptions

These are believed, and a deployment that violates them is not supported:

1. **The proxy is operated by you.** If an attacker controls a host inside the
   trusted range, they control the identity headers.
2. **The proxy overwrites, not appends.** It must set `x-forwarded-for` itself.
   A proxy that appends to a client-supplied value lets the client prepend.
3. **The trusted range is as narrow as the deployment allows.** Trusting a
   whole `0.0.0.0/0` or a large shared-VPC range disables the boundary.
4. **TLS is terminated before Keystone.** Certificate validity is the proxy's
   responsibility; Keystone only compares a fingerprint it was told about.
5. **Database access is trusted.** Whoever can write to `service_accounts` can
   bind a certificate to an account.

### What is *not* protected here

- **Certificate chain validation** is the proxy's job. Keystone verifies that a
  fingerprint is well-formed and bound to an account; it does not re-validate the
  chain or the CA. See [mtls.md](./mtls.md).
- **A trusted proxy that is compromised** is a full identity bypass by design.
  This is inherent to the mTLS deployment model, not a Keystone defect.
- **Spoofing against a shared egress IP** cannot be distinguished by peer
  address. Deploy per-service egress ranges if callers share a NAT.

## Consequences of a misconfiguration

| Misconfiguration | Result |
| --- | --- |
| `KEYSTONE_TRUSTED_PROXIES` unset while behind a proxy | All forwarded headers stripped; rate limiting keys on the proxy's address, so **all** clients share one budget. Clients see rate limits they should not. |
| Range too broad (e.g. a shared VPC CIDR) | Any host in that range can assert any client identity, including a certificate fingerprint. |
| Keystone exposed directly to the internet while a proxy range is configured | An attacker's direct request is not from a trusted peer, so it is still safe — but the proxy path is the only one that can carry identity. |
