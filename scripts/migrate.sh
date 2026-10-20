#!/usr/bin/env bash
#
# §6.5. Migration safety wrapper: up / verify / rollback.
#
# Drizzle migrations are forward-only — there is no `.down.sql` and drizzle-kit has
# no down command. Pretending otherwise in a script would be worse than saying so:
# `rollback` here restores a dump, which is the only rollback that actually exists.
# The strategy for a change that must be reversible is expand/migrate/contract,
# documented in `docs/OPERATIONS/migrations.md`.
#
# Usage:
#   scripts/migrate.sh up                 apply pending migrations
#   scripts/migrate.sh verify             assert every expected table exists
#   scripts/migrate.sh up --verify        apply, then verify (what a deploy should run)
#   scripts/migrate.sh rollback --dump F  drop and restore the database from a dump
#
# `up` and `verify` are safe to run repeatedly. `rollback` is destructive by
# definition; it is deliberately the only command that requires an explicit file.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"

usage() {
  cat <<'EOF'
Usage: scripts/migrate.sh <command> [options]

Commands:
  up                  Apply pending database migrations.
  verify              Verify that every table the application expects exists.
  up --verify         Apply migrations, then verify the schema.
  rollback --dump F   Restore the database from a dump produced by pg_dump.
                      DESTRUCTIVE: drops the current schema. Requires pg_restore.

Environment:
  DATABASE_URL        Required (or present in .env, which the CLI loads).
  KEYSTONE_SHUTDOWN_TIMEOUT_MS  Not used here; see docs/OPERATIONS/migrations.md.

The published package ships the same commands:
  npx @hilbras/keystone migrate --verify
  npx @hilbras/keystone schema:verify
EOF
}

run_cli() {
  if [[ ! -f "$CLI" ]]; then
    echo "error: $CLI not found." >&2
    echo "       Run 'npm run build' first, or use 'npx @hilbras/keystone <command>'." >&2
    exit 1
  fi
  node "$CLI" "$@"
}

command="${1:-}"
if [[ -z "$command" ]]; then
  # Defaulting to `up` means a mistyped or truncated invocation migrates the
  # database. A migration tool should require the verb.
  usage
  exit 2
fi
shift

case "$command" in
  up)
    if [[ "${1:-}" == "--verify" ]]; then
      run_cli migrate --verify
    else
      run_cli migrate
    fi
    ;;
  verify)
    run_cli schema:verify
    ;;
  rollback)
    dump=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --dump)
          dump="${2:-}"
          shift 2
          ;;
        --dump=*)
          dump="${1#*=}"
          shift
          ;;
        *)
          echo "error: unknown option for rollback: $1" >&2
          usage
          exit 2
          ;;
      esac
    done

    if [[ -z "$dump" ]]; then
      echo "error: rollback requires --dump <file>." >&2
      echo "       Drizzle migrations are forward-only; restoring a dump is the rollback." >&2
      echo "       See docs/OPERATIONS/migrations.md." >&2
      exit 2
    fi
    if [[ ! -f "$dump" ]]; then
      echo "error: dump not found: $dump" >&2
      exit 2
    fi
    if ! command -v pg_restore >/dev/null 2>&1; then
      echo "error: pg_restore is not installed (package postgresql-client)." >&2
      exit 2
    fi
    if [[ -z "${DATABASE_URL:-}" ]]; then
      echo "error: DATABASE_URL must be set for rollback." >&2
      exit 2
    fi

    echo "Restoring $dump into the database named by DATABASE_URL."
    echo "This drops and recreates the current schema. Ctrl-C within 5 seconds to abort."
    sleep 5

    # `--clean --if-exists` drops what the dump replaces; `--no-owner` because the
    # role in the dump is rarely the role in this environment (and pg_restore would
    # otherwise fail after dropping the schema, leaving the database empty).
    pg_restore --clean --if-exists --no-owner --no-privileges \
      --dbname "$DATABASE_URL" "$dump"

    # A restore that "succeeded" but is missing tables is the failure this whole
    # script exists to make visible.
    run_cli schema:verify
    ;;
  *)
    usage
    exit 2
    ;;
esac
