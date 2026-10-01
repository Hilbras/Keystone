# Webhooks

A webhook endpoint is a URL the server will `POST` to when a subscribed event
fires, signed with a per-endpoint secret in `X-Keystone-Signature`.

## Where the URL is checked

**Three times, for three different reasons.** All three matter; none is redundant.

| when | what it catches | DNS resolved? |
|---|---|---|
| `createEndpoint` | a private address, an embedded credential, `file://` | no |
| `updateEndpoint` (only when `url` changes) | the same, on repoint | no |
| `deliverNow`, immediately before the request | a name that *now* resolves to a private address | yes |

The creation-time check cannot stand alone, and the reason is worth stating
plainly: **DNS rebinding**. A name can resolve to a public address when an
operator saves an endpoint and to `127.0.0.1` when the delivery runs two minutes
later. Only the delivery-time check sees the answer that the connection actually
uses. The store-time checks are also what stops a private URL sitting in a column
where an operator can read it back and believe it works.

## What is refused

- **Loopback and local names** — `localhost`, `*.localhost`, `ip6-localhost`
- **Private and reserved IPv4** — `10/8`, `172.16/12`, `192.168/16`, `127/8`,
  `169.254/16` (which is where cloud instance metadata lives), `100.64/10`,
  `198.18/15`, `0.0.0.0`, and multicast
- **IPv6 equivalents**, including IPv4-mapped forms — `::ffff:127.0.0.1` is a
  loopback address wearing an IPv6 hat, and a filter that only tests the v4 form
  misses it
- **Internal DNS names** — `*.internal`, `*.local`, `metadata.google.internal`
- **Embedded credentials** — `https://user:pass@host/`
- **Non-HTTPS schemes** — always; `file://` would read the server's filesystem

## Why a refused delivery is not retried

A policy rejection is **permanent**: the same URL is refused identically on
every future attempt, because nothing about it changes between now and the next
retry. So the delivery is recorded `failed` on the first attempt and no retry is
scheduled.

The retry ladder exists for transient network faults — a consumer that was down,
a timeout, a DNS blip. Running it against `169.254.169.254` would mean five
requests the operator should never have received.

A network failure is a different case and *does* retry. The two are separated by
the error type, not by the message.

## Development and test

`ALLOW_PRIVATE_WEBHOOK_TARGETS=true` permits a loopback or private destination.

It defaults to `ALLOW_PRIVATE_SSO_ENDPOINTS` so an existing development setup
that already opted out keeps working, and it is a *narrower* flag on purpose: the
SSO flag also disables DNS resolution and address pinning, which a developer's
`http://localhost:3000` does not need switched off and which a metadata read
absolutely does.

**Both default to `false`.** Neither should be set in production, and no gate
checks the flag — it is an operator responsibility, documented here and in
`docs/DEPLOYMENT.md` rather than enforced. That is a real gap, recorded rather
than papered over: a gate for it belongs in the production-configuration work
(plan §6.1), which is where unsafe production settings are validated as a class
rather than one flag at a time.

## What is stored about a delivery

The delivery row keeps **the shape of the consumer's response, not its body**:

```
HTTP 503 · application/problem+json · 4096 bytes
```

Status, content type, byte length. That is what answers "is the consumer rejecting
us, and is it rejecting us with something structured" — and the answer to *why* a
500 happened is in the consumer's own logs, which is where it belongs.

**The body is not stored.** It is the consumer's data, not Keystone's. An endpoint
that echoes its request — which is what most do while someone is debugging — would
otherwise cause the signed payload and the signature header to be written into this
database, and then served back to any platform operator through
`GET /platform/webhook-deliveries/:id`. It would also be replicated and backed up,
so a consumer's stack trace would become permanent, queryable state.

`WEBHOOK_DEBUG_CAPTURE_BODY=true` keeps a 512-byte redacted prefix for debugging a
consumer you control. The stored value **says so in itself**:

```
HTTP 500 · text/plain · 94 bytes · body(captured): Traceback: panic…
```

so a captured row can never be mistaken for a default summary. Off by default, and
the default is the fix.

Rows written by versions before 3.7.1 still contain captured bodies. They are not
rewritten or purged — for some deployments that content is the only record of why a
consumer rejected a delivery, so removing it is an operator decision, not a silent
one.

### Failure reasons are kept, and are not redaction

The `responseBody` column also records *why an attempt failed* — a refused URL
policy, an unreachable host, a timeout. Those are kept, bounded, with control
characters stripped. They describe **our** request failing, which is precisely the
distinction an operator needs and which they cannot get from the consumer. Control
characters are stripped because a remote party can shape them, and a stored value
a remote party can shape is a log-injection vector for anyone tailing the row.

## Signing

Each endpoint gets `whsec_<48 base64url chars>` at creation, returned exactly
once and never again. It is **encrypted at rest**, not hashed — Keystone *signs*
outbound payloads with it rather than comparing against it, so the plaintext has
to be recoverable. Rows written before 2.4.0 are still plaintext; re-saving or
rotating an endpoint upgrades it.

Verify a delivery with `scripts/`'s documented scheme, or by recomputing the
signature over the raw request body. The header is `X-Keystone-Signature`;
`X-Keystone-Event` carries the event type and `X-Keystone-Delivery` the delivery
id.

Always compare in constant time, and reject rather than log on mismatch.
