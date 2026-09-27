# Audit and abuse events

Covers SEC-036, SEC-037 and SEC-038.

An event that exists in the vocabulary but is never emitted is worse than one
that does not exist: it reads as coverage. All three events below were in that
state and were added in v2.8.0.

## `user_login_failed`

Previously defined, never emitted, on either login route. A wrong password
produced a `401` and nothing else, so credential guessing left no record beyond
whatever the rate limiter happened to observe in aggregate.

Deliberately records **no user id**. At the point of failure no credential has
been proven, and the submitted address may correspond to no account at all —
attributing the failure to a user id would both misattribute the attempt and
create a cheap way to probe which addresses exist.

## `rate_limit_triggered`

A refused request previously produced a `429` and nothing else.

The event carries **which limiter decided** — `redis`, `local` or `none`. These
are three different operational situations, and a degraded in-process control is
a reason to go and look at Redis. Recording a local refusal in the same shape as
a healthy distributed one would hide exactly the thing worth knowing.

## `refresh_token_replayed`

Rotation consumes a refresh token, so a second presentation failed in exactly the
same way as a token that never existed. A stolen token used twice was therefore
indistinguishable from a typo.

It is now detected by looking the token up and reading its state, and the event
records which of the two it was:

- `replayed: true` — the token exists and was already spent. This means the
  token leaked, so the account's remaining credentials are revoked. Answering
  only that one request would leave everything else it could mint intact.
- `replayed: false` — the token is unknown. A guess, or a stale client. Nothing
  is revoked, because an attacker guessing random values must not be able to log
  a user out.

## A machine principal is not a user

A service account is represented in memory by a user object whose id is the
sentinel `sa:<uuid>`, so routes expecting `request.user` keep working without a
matching user row.

That sentinel was being passed straight into `audit_log.user_id`, which is a uuid
column. Postgres rejected the insert, the subscriber logged a failure, and the
record was lost. Nothing failed visibly — the request succeeded, and a missing
audit record is indistinguishable from a request that never happened.

So **every request authenticated by an API key or an mTLS service account left no
audit trail at all.** The privileged, non-human path was the one that was
invisible, which is precisely the wrong direction for that gap to point.

The sentinel is now stripped, `user_id` is left null, and the service account is
recorded in `metadata.serviceAccountId` — the record still identifies who acted,
without violating the column type. (SEC-046)

## The audit export is opened in a spreadsheet

The CSV export quotes a value containing a delimiter or a quote. It also
neutralises a value whose **first character** is `=`, `+`, `-` or `@`, because a
spreadsheet evaluates such a cell as a formula when the file is opened.

Quoting alone is not enough, and several exported columns are attacker-supplied —
the user agent above all. A `User-Agent` of `=cmd|'/c calc'!A1` reached the export
intact.

The apostrophe prefix is applied *before* quoting, and a value with no formula
prefix is left alone so ordinary data is not corrupted.

## Event versioning

Events are stored as `<name>:v1`. A query against the bare name matches nothing
and returns an empty result, which reads as "no such event occurred" — the same
vacuous pass that let SEC-037 go unnoticed. Tests that assert on audit output
must match the versioned name.
