# The frozen contracts

**Plan §9.1.** This release is the last feature release before v4, and the
point of a freeze is not to promise that nothing will change — it is to make a
change *visible*.

There are seven contracts a caller can depend on:

| contract | what a caller depends on |
|---|---|
| **REST API** | which paths exist, which methods they answer, and how they are tagged |
| **OAuth behaviour** | the discovery metadata, and the error codes a client can receive |
| **Token format** | the claims, the algorithm, the audience, the issuer |
| **Database contracts** | the tables, their columns, their nullability and defaults, and the migration set |
| **Webhook format** | the headers a delivery carries, and the shape of its body |
| **SDK interfaces** | what each published package exports, and where it points |
| **Configuration** | the environment variables the server reads |

## What "frozen" means here

Each contract is **read from the running code** and compared with a committed
snapshot, [`docs/contract-freeze.json`](contract-freeze.json). A change to any
of them makes the gate fail, with the exact difference:

```
The configuration contract changed:
  - removed configuration: "GLOBAL_RATE_LIMIT_MAX"
  - added configuration: "GLOBAL_RATE_LIMIT_MAXIMUM"
```

The only way past that is to update the snapshot:

```bash
npm run verify:contract -- --update
```

and to put the snapshot change **in the same commit as the code change**, so a
reviewer sees both. That is the whole mechanism: there is no list of things
that "must not change" and a rule that says "don't change them". There is a
gate that fails when they change, and a diff that says so.

A contract that "must not change" and fails only when somebody remembers to
check is a contract that changes. One that fails on every change, and is
updated deliberately, is a contract that is *managed*.

## How each contract is read

Reading them from the code rather than from a document is deliberate. A
document drifts; the code is what runs.

- **REST API** — from the OpenAPI document the server serves, which is
  generated from the route registrations. The tags are part of it, because a
  generated client groups by them.
- **OAuth behaviour** — the discovery document is read over HTTP from the
  running server. The error codes are read from the two places that define
  them: the routes that send them, and the allowlist that keeps RFC-shaped
  envelopes intact.
- **Token format** — from a token the server **actually mints**, decoded. A
  list of claim names written by hand drifts from the signer; a decoded token
  cannot.
- **Database contracts** — from the compiled Drizzle schema: the tables, their
  columns, and whether each column is not-null and has a default. A column's
  nullability is part of the contract, because a migration that changes it
  changes what an upgrade does.
- **Webhook format** — from the source of the delivery function, which is the
  one place both the headers and the body are written.
- **SDK interfaces** — from each package's manifest and its built declaration
  file, so a name that stops being exported is a change.
- **Configuration** — the environment variables the configuration module reads,
  plus any the server reaches for directly. The test suite is excluded: a test
  that raises a rate-limit budget for itself is not the product's
  configuration.

## What is *not* frozen

- **The implementation.** Every internal module may change in any release.
- **The error messages.** The body shape (`{ error, code }`) is frozen; the
  prose in `error` is not, and never was.
- **The internal SDK** (`src/sdk/index.ts`) beyond what the packages publish.
- **The `requestId` and `traceId` values**, which are per-request.

## Why this matters for v4

v4 is a major version. The point of a major version is that breaking changes
are *allowed* and *declared* — not that they happen by accident. A contract
that is snapshotted and gated means the v4 changelog can list the breaking
changes with a diff to point at, rather than being written from memory.

The snapshot also answers a question a release cannot otherwise answer: *what
exactly changed between these two versions?* For the API, the token format and
the configuration, the answer is a file diff.

## Running it

```bash
npm run verify:contract            # fails on any drift
npm run verify:contract -- --update  # accepts a deliberate change
```

The gate runs in CI on every pull request, and the snapshot is part of the
review.
