# Backup and restore

§6.6. Everything an operator needs to recover Keystone after a database loss, a bad
migration, or a lost region — and an honest statement of what is *not* recoverable.

Keystone stores identity state in PostgreSQL. Redis holds only derived, replaceable
state. The other half of a backup is not in the database at all: several encryption
keys live only in the environment, and a database dump without them is partially
unreadable.

**If you take one thing from this document:** back up the database **and** the
environment secrets, separately, and test the restore. A backup that has never been
restored is a hypothesis.

---

## 1. What is where

| Data | Location | Lost with | Recoverable without a backup? |
|---|---|---|---|
| Users, identities, sessions, refresh tokens | PostgreSQL | the database | no |
| Organizations, memberships, applications, API keys | PostgreSQL | the database | no |
| SAML/OIDC/SCIM connection configuration | PostgreSQL (secrets encrypted) | the database | no |
| Audit log | PostgreSQL (`audit_log`) | the database | no |
| Webhook endpoints and delivery history | PostgreSQL | the database | no |
| Workflows and runs | PostgreSQL | the database | no |
| JWT signing keypair | `secrets` table, **wrapped** with `KEYSTONE_ENCRYPTION_KEY`; or `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` in the environment | the database **and** the wrap key | no — rotating is the recovery |
| TOTP secrets, backup-code peppers, OIDC client secrets, webhook signing secrets | PostgreSQL, AES-256-GCM with the key derived from `KEYSTONE_TOTP_ENCRYPTION_KEY` (or `KEYSTONE_INTERNAL_API_KEY`) | the database **or** that key | no |
| Rate-limit counters, permission cache, idempotency locks | Redis | Redis | yes — they rebuild |
| Queue jobs (BullMQ) | Redis | Redis | partially — see §5.2 |
| In-flight sessions | process memory | the process | yes — clients re-authenticate |

Two consequences that surprise people:

- **A database dump alone does not let you mint tokens.** The signing keypair is
  wrapped. Without `KEYSTONE_ENCRYPTION_KEY`, the wrapped key is noise and the
  server cannot sign. That is the intended direction of failure.
- **Without the TOTP key, enrolled authenticators and encrypted integration
  secrets cannot be read.** Users can still log in by password (and by any other
  factor they have), but TOTP verification fails and OIDC/webhook secrets must be
  re-entered. If the key is missing at production boot, Keystone refuses to start
  (see [Configuration profiles](#configuration-profiles)).

---

## 2. Recommended targets

Set these explicitly; they are a decision, not a default:

| Metric | Suggested | How it is achieved |
|---|---|---|
| **RPO** (data loss tolerance) | 15 minutes | `pg_dump` every 15 minutes, or continuous WAL archiving (PITR) |
| **RTO** (time to restore service) | 1 hour | a restore rehearsal at least once per quarter; keep the last two dumps off-host |
| Backup retention | 30 daily, 12 monthly | off-host object storage with lifecycle rules |
| Restore verification | every backup | restore into a scratch database and run `keystone schema:verify` |

`pg_dump` is a logical backup: it is portable across minor versions and lets you
restore a single database. It is not point-in-time. If you need minute-level RPO
under heavy write load, use PostgreSQL's continuous archiving (`archive_command` +
`pg_basebackup`) and treat Keystone's dumps as the portable secondary copy.

---

## 3. Backing up the database

Use the custom format (`-Fc`): it compresses, supports selective restore, and is
what `pg_restore` expects.

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="/backups/keystone-${stamp}.dump"

pg_dump --format=custom --no-owner --no-privileges --file="$out" "$DATABASE_URL"
pg_restore --list "$out" > "/backups/keystone-${stamp}.toc"

# Fail loudly rather than shipping a truncated file.
test -s "$out"
```

Notes:

- `--no-owner --no-privileges` makes the dump portable between roles. Restoring a
  dump that names a role that does not exist fails *after* dropping the schema.
- Keep the `.toc` (`pg_restore --list`) with the dump: it is how you confirm the
  dump contains the tables you expect without restoring it.
- Dumps contain password hashes (argon2id), wrapped keys and encrypted secrets
  **and** the audit log. Treat them as secrets: encrypt at rest and restrict
  access. A dump is a credential-store dump.
- Do not run `pg_dump` against the primary during a migration. Take the backup
  *before* `migrate up` (see [Migrations](migrations.md)).

---

## 4. Backing up the keys

These are not in the database and cannot be reconstructed from it. Store them in
the same secrets manager your deployment already uses, with a copy that survives a
region loss.

| Variable | What it protects | If lost |
|---|---|---|
| `KEYSTONE_ENCRYPTION_KEY` | wraps the JWT signing keypair in `secrets` | the wrapped key is unreadable; rotate the signing key |
| `KEYSTONE_TOTP_ENCRYPTION_KEY` (or a 32+ char `KEYSTONE_INTERNAL_API_KEY`) | TOTP secrets, backup-code pepper, OIDC client secrets, webhook secrets | those secrets are unreadable; users re-enrol TOTP, integrations are re-entered |
| `KEYSTONE_INTERNAL_API_KEY` | cookie signing, SAML relay-state signing when no TOTP key is set | sessions invalidate; SAML transactions must be re-initiated |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (if you use the environment provider) | token signing, when set | tokens cannot be signed; publish a new key |
| `WEBHOOK_SIGNING_SECRET` | default signature for outbound webhooks | consumers cannot verify deliveries signed with it |
| `SCIM_BEARER_TOKEN` (legacy) | pre-1.9 SCIM, adopted into a connection at boot | the adopted connection is unaffected |

Rules:

1. **Never back up a key into the same place as the database dump.** The wrap key
   exists precisely so that a dump alone is not enough.
2. Version them: record which key was active for which backup window. Rotating a
   key without recording it makes old dumps unrestorable *in practice*.
3. `KEYSTONE_ENCRYPTION_KEY` must not change between a dump and its restore, or
   the signing key cannot be unwrapped.

---

## 5. Restoring

### 5.1 Database

Restore into a **new** database when you can, verify it, then switch the
application to it. Restoring over a live database is the destructive path and
should be a deliberate choice, not the default.

```bash
# 1. Create an empty target (or use the existing one for an in-place recovery).
createdb -h "$PGHOST" -U "$PGUSER" keystone_restored

# 2. Restore. --exit-on-error matters: without it pg_restore continues past a
#    failed statement and reports success.
pg_restore \
  --dbname="postgresql://$PGUSER:$PGPASSWORD@$PGHOST/keystone_restored" \
  --no-owner --no-privileges --exit-on-error \
  /backups/keystone-20261020T000000Z.dump

# 3. Verify the schema against the application's own expectation, not a guess.
DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST/keystone_restored" \
  npx @hilbras/keystone schema:verify
```

`keystone schema:verify` derives the expected table list from the built
application. A restore that is missing a table fails here rather than at the first
request that touches it.

### 5.2 Redis

Redis is not backed up. After a Redis loss:

- **Rate-limit counters reset.** Limits resume from zero; this is a brief
  weakening, not a correctness failure. If Redis stays down, the limiter uses its
  bounded local fallback (see `docs/security/rate-limiting.md`).
- **Caches rebuild** from PostgreSQL.
- **Queued jobs are lost.** On the next boot, startup recovery re-enqueues
  `pending` webhook deliveries from PostgreSQL; anything that existed only in
  Redis — a workflow run not yet claimed, an email enqueue — is gone.
- **Locks expire** (30 s default). A lock that was held when Redis was rebuilt
  does not come back; its holder's next `renewLock` returns `false`, and the work
  it guarded may be repeated. Idempotency keys are what make that safe.

Restoring Redis from an RDB/AOF snapshot is usually the *wrong* move: it can
resurrect locks and jobs that a newer instance already owns. Start empty.

---

## 6. Restore verification checklist

Run these in order. Each one answers a different question.

| # | Check | Question answered |
|---|---|---|
| 1 | `pg_restore --list dump \| grep TABLE DATA` | does the dump contain data? |
| 2 | `keystone schema:verify` | does the schema match the application? |
| 3 | `SELECT count(*) FROM users;` vs. the expected row count | did enough data survive? |
| 4 | Start the app with the restored `DATABASE_URL` and the **same** keys | can the signing key be unwrapped? |
| 5 | `GET /health/ready` → `200` | are PostgreSQL and Redis reachable? |
| 6 | `GET /v1/admin/platform/diagnostics` (owner) | are keys loaded, the queue draining, and configuration warnings explained? |
| 7 | Log in with a known account, including MFA | are TOTP secrets decryptable? |
| 8 | Send a test webhook | are webhook secrets decryptable? |
| 9 | `GET /.well-known/jwks.json` | is the published key the one clients will verify? |

Step 9 matters after a signing-key rotation or a restore from a different
environment: clients cache JWKS, and a `kid` they have never seen is a token they
will reject until they refresh.

---

## 7. Disaster-recovery scenarios

### 7.1 The database is corrupt or a migration went wrong

1. Stop the application (SIGTERM drains; see [Graceful shutdown](#graceful-shutdown)).
2. Take a dump of the *current* database anyway — it may contain data written
   after the last good backup, and it costs nothing to keep.
3. Restore the most recent good dump into a new database (§5.1).
4. Verify (§6), then point the application at it.

If only a migration is at fault and the data is intact, `scripts/migrate.sh
rollback --dump` restores the pre-migration dump. There is no per-migration down;
see [Migrations](migrations.md).

### 7.2 Redis is lost

Start empty (§5.2). Do not restore an old snapshot. The application reconnects and
startup recovery re-enqueues deliveries that PostgreSQL still knows about.

### 7.3 The whole region is lost

You need, off-region: the latest database dump, the environment/secret values, and
the application image or package. The image is published to
`ghcr.io/hilbras/keystone`; the package is `@hilbras/keystone` on npm. Restore
in the same order as §5 and §6.

### 7.4 A key is lost but the database is fine

- Lost `KEYSTONE_ENCRYPTION_KEY`: rotate the JWT signing keypair
  (`keystone keys:create` or the admin rotation endpoint). Existing access tokens
  expire within their TTL (15 minutes by default); refresh tokens remain valid but
  new access tokens are signed with the new key. Publish JWKS before retiring the
  old key.
- Lost `KEYSTONE_TOTP_ENCRYPTION_KEY`: TOTP verification fails for every enrolled
  user. The only recovery is to reset MFA for affected users. OIDC/webhook secrets
  must be re-entered.
- Lost `KEYSTONE_INTERNAL_API_KEY`: sessions signed with it invalidate. SAML
  relay state does too (in-flight logins must be retried).

### 7.5 What cannot be recovered

- Data written after the last dump.
- Audit entries lost with the database. The audit log is append-only by design,
  not by policy; export it if you need durability beyond the database.
- A deleted user or organization. Rows are deleted, not tombstoned.
- Queue work that existed only in Redis.

---

## 8. Configuration profiles

Keystone refuses to start in a **production-like** profile (`production`,
`staging`) when a setting would leak a credential or send traffic in the clear.
The relevant ones for restore are:

- `COOKIE_SECURE=false` — refused.
- A missing/short/placeholder TOTP key — refused.
- An in-process queue in production — refused.
- `KEYSTONE_ALLOW_INSECURE_WEBHOOK` set in production — refused.

`KEYSTONE_ALLOW_DEV_DEFAULTS=true` bypasses the refusal and logs what it bypassed.
Do not carry that setting into a restored production instance: it is exactly the
state in which a misconfigured restore runs.

The full report — errors, warnings, and the profile it applied — is logged at
startup and visible in `/v1/admin/platform/diagnostics` under `configuration`.

---

## Graceful shutdown

A restore is not the only operation that benefits from a clean stop. Keystone
installs SIGTERM/SIGINT handlers that:

```text
stop accepting requests -> finish active requests -> stop workers ->
finish safe jobs -> release locks -> close the database -> close Redis -> exit
```

The sequence is bounded by `KEYSTONE_SHUTDOWN_TIMEOUT_MS` (default `10000`). On
expiry the process exits non-zero and logs which step was still open. Give the
orchestrator a grace period longer than that value — Kubernetes'
`terminationGracePeriodSeconds` defaults to 30 s, which is enough for the default.

A second signal exits immediately, without waiting for the drain.
