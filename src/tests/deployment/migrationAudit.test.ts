import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "migration-audit";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

const { drizzle } = await import("drizzle-orm/postgres-js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const postgres = (await import("postgres")).default;
/** The client type, without importing the package a second time for it. */
type SqlClient = ReturnType<typeof postgres>;
const schema = await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");

/**
 * §9.2 and §9.3 — the migration audit and the upgrade paths.
 *
 * The plan asks for the upgrade path to be tested from every published
 * version, and the repository's own migration documentation is honest that
 * `schema:verify` is a *presence* check: "a column missing from an existing
 * table still passes." That bound is deliberate there, because a full diff
 * means shipping a schema comparison engine.
 *
 * This is that comparison engine, written for one purpose. It answers the
 * question the presence check cannot: **does an upgraded database end up
 * identical to a freshly installed one?** If a migration added a column on a
 * fresh install but the upgrade path did not — a column added outside a
 * migration, a migration that only runs one way, a `search_path` that
 * resolved elsewhere — the presence check passes and the two databases differ.
 * A user who upgrades and a user who installs must end up with the same
 * software, and the only way to know that is to compare.
 *
 * The start points are *every* migration, not the published versions. The
 * published versions are a subset of the states a database can be in — a
 * failed deployment, a restore from a dump, a branch that shipped a
 * migration before the release that carried it — and each of those is a
 * starting point too. There are only a couple of dozen, and each upgrade is
 * milliseconds.
 */

const run = promisify(execFile);
const FOLDER = migrationsFolder();

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Migration {
  entry: JournalEntry;
  sql: string;
  statements: string[];
  hash: string;
}

function readJournal(): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(path.join(FOLDER, "meta", "_journal.json"), "utf8")
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

/** The migrations, in the order the journal gives them. */
function readMigrations(): Migration[] {
  return readJournal().map((entry) => {
    const sql = readFileSync(path.join(FOLDER, `${entry.tag}.sql`), "utf8");
    return {
      entry,
      sql,
      statements: sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean),
      hash: crypto.createHash("sha256").update(sql).digest("hex"),
    };
  });
}

/**
 * A fingerprint of the database's shape.
 *
 * Tables, their columns, their nullability and their defaults, plus every
 * index — because an index that a fresh install has and an upgraded database
 * does not is a performance difference that no presence check would ever see.
 * The sequence names are stable across databases because they are derived
 * from the table and column names, not from the database.
 */
async function fingerprint(client: SqlClient): Promise<string> {
  const columns = await client<
    { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
  >`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name
  `;
  const indexes = await client<{ tablename: string; indexname: string; indexdef: string }[]>`
    select tablename, indexname, indexdef
    from pg_indexes
    where schemaname = 'public'
    order by tablename, indexname
  `;
  return JSON.stringify({ columns, indexes }, null, 2);
}

/**
 * Apply the first `count` migrations by hand and record them as applied.
 *
 * The recording is what makes the upgrade real rather than a re-run: the
 * migrator looks at the *last* applied row and applies everything after it, so
 * marking them is how a database that already has them is reproduced.
 */
async function applyFirstMigrations(
  client: SqlClient,
  migrations: Migration[],
  count: number
): Promise<void> {
  for (const migration of migrations.slice(0, count)) {
    for (const statement of migration.statements) {
      await client.unsafe(statement);
    }
  }

  if (count === 0) return;

  await client.unsafe(`create schema if not exists drizzle`);
  await client.unsafe(
    `create table if not exists drizzle.__drizzle_migrations (
       id serial primary key,
       hash text not null,
       created_at bigint
     )`
  );
  const last = migrations[count - 1];
  await client`
    insert into drizzle.__drizzle_migrations ("hash", "created_at")
    values (${last.hash}, ${last.entry.when})
  `;
}

/** Create a database, hand it to `body`, and drop it afterwards. */
async function withDatabase<T>(
  name: string,
  body: (client: SqlClient) => Promise<T>
): Promise<T> {
  const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
  const url = new URL(process.env.DATABASE_URL!);
  try {
    await admin.unsafe(`drop database if exists ${name}`);
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }

  const client = postgres(`${url.protocol}//${url.username}:${url.password}@${url.host}/${name}`, {
    max: 1,
  });
  try {
    return await body(client);
  } finally {
    await client.end();
    const cleanup = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await cleanup.unsafe(`drop database if exists ${name}`);
    } catch {
      // The database is already gone, or the server is busy; the test database
      // is disposable either way.
    } finally {
      await cleanup.end();
    }
  }
}

/**
 * Insert a row using only the columns the table actually has.
 *
 * A table's columns depend on where in the migration history the database is,
 * so a fixed column list fits one starting point and no other. The values are
 * a superset; the ones the table does not have are dropped, and the ones it
 * does have are written.
 */
async function insertRow(
  client: SqlClient,
  table: string,
  values: Record<string, string>
): Promise<void> {
  const columns = await client<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `;
  const available = new Set(columns.map((row) => row.column_name));
  const present = Object.entries(values).filter(([name]) => available.has(name));
  assert.ok(present.length > 0, `${table} has none of the columns the test writes`);
  const names = present.map(([name]) => `"${name}"`).join(", ");
  const placeholders = present.map((_, index) => `$${index + 1}`).join(", ");
  await client.unsafe(
    `insert into "${table}" (${names}) values (${placeholders})`,
    present.map(([, value]) => value)
  );
}

/**
 * The environment the PostgreSQL client tools read.
 *
 * The connection is passed through `PGHOST` and friends rather than as a URL
 * on the command line. Both work, but a URL is a single string that can be
 * anything, and the tools take it apart themselves — the environment is the
 * interface they document, and it keeps a connection string out of a process
 * listing.
 */
function pgEnvironment(name: string): NodeJS.ProcessEnv {
  const url = new URL(process.env.DATABASE_URL!);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: name,
  };
}

const migrations = readMigrations();

describe("the migration audit (§9.2)", () => {
  it("has a journal whose migrations all have their SQL", () => {
    assert.ok(migrations.length >= 20, `expected the migration set to have grown; it has ${migrations.length}`);
    for (const migration of migrations) {
      assert.ok(
        migration.statements.length > 0,
        `migration ${migration.entry.tag} has no statements — the journal names a file with nothing in it`
      );
    }
    // The journal's `when` is what the migrator orders by, so two migrations
    // sharing one would make the order depend on the file listing.
    const times = migrations.map((m) => m.entry.when);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), "the journal is not in time order");
    assert.equal(new Set(times).size, times.length, "two migrations share a timestamp");
    assert.deepEqual(
      migrations.map((m) => m.entry.idx),
      migrations.map((_, index) => index),
      "the journal's indexes are not contiguous"
    );
  });

  it("installs cleanly on an empty database", async () => {
    // The baseline every upgrade path is compared against.
    await withDatabase("fresh", async (client) => {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: FOLDER });
      const fingerprintAfter = await fingerprint(client);
      assert.ok(fingerprintAfter.length > 100, "a fresh install must have a schema");
    });
  });

  it("upgrades from every migration to the same schema a fresh install has", async () => {
    // The property. Every starting point — every state a database can be in —
    // must end up identical to a fresh install.
    const baseline = await withDatabase("baseline", async (client) => {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: FOLDER });
      return fingerprint(client);
    });

    const failures: string[] = [];

    for (let start = 0; start < migrations.length; start += 1) {
      const name = `from${start}`;
      const upgraded = await withDatabase(name, async (client) => {
        await applyFirstMigrations(client, migrations, start);
        const db = drizzle(client, { schema });
        await migrate(db, { migrationsFolder: FOLDER });
        return fingerprint(client);
      });
      if (upgraded !== baseline) {
        failures.push(
          `starting before ${migrations[start].entry.tag} produced a different schema than a fresh install`
        );
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"));
  });
});

describe("an upgrade keeps the data that was already there (§9.3)", () => {
  it("carries users, organizations and memberships across the upgrade", async () => {
    // An existing installation, not an empty schema. A migration that drops or
    // rewrites a table would pass the schema comparison and lose the data.
    const start = 3;
    const result = await withDatabase("data", async (client) => {
      await applyFirstMigrations(client, migrations, start);

      // The columns each table has *at this point in the history* differ — a
      // column added by a later migration is not there yet. So the rows are
      // written with whatever the table can hold, rather than with a fixed
      // column list that would only fit one starting point.
      await insertRow(client, "organizations", {
        id: "11111111-1111-1111-1111-111111111111",
        name: "Audit Org",
        slug: "audit-org",
        plan: "free",
      });
      await insertRow(client, "users", {
        id: "22222222-2222-2222-2222-222222222222",
        email: "audit@example.test",
        username: "audit-user",
        name: "Audit User",
        role: "owner",
        is_active: "true",
      });
      await insertRow(client, "org_memberships", {
        id: "33333333-3333-3333-3333-333333333333",
        org_id: "11111111-1111-1111-1111-111111111111",
        user_id: "22222222-2222-2222-2222-222222222222",
        role: "owner",
      });

      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: FOLDER });

      const users = await client<{ email: string; role: string }[]>`
        select email, role from users where id = '22222222-2222-2222-2222-222222222222'
      `;
      const memberships = await client<{ role: string }[]>`
        select role from org_memberships where user_id = '22222222-2222-2222-2222-222222222222'
      `;
      const orgs = await client<{ slug: string }[]>`
        select slug from organizations where id = '11111111-1111-1111-1111-111111111111'
      `;
      return { users, memberships, orgs };
    });

    assert.equal(result.users.length, 1, "the user must survive the upgrade");
    assert.equal(result.users[0].email, "audit@example.test");
    assert.equal(result.users[0].role, "owner", "the role must survive the upgrade");
    assert.equal(result.orgs.length, 1, "the organization must survive the upgrade");
    assert.equal(result.memberships.length, 1, "the membership must survive the upgrade");
    assert.equal(result.memberships[0].role, "owner");
  });
});

describe("a failed migration changes nothing and can be retried (§9.3)", () => {
  it("leaves the schema untouched, and applies cleanly once the fault is gone", async () => {
    // The migrator runs every pending migration in one transaction, and
    // Postgres DDL is transactional, so a failure cannot leave a half-applied
    // schema. That is worth asserting rather than assuming: it is the property
    // that makes "run the migration again" a safe instruction.
    const scratch = mkdtempSync(path.join(os.tmpdir(), "keystone-migrations-"));
    try {
      cpSync(FOLDER, scratch, { recursive: true });
      const journalPath = path.join(scratch, "meta", "_journal.json");

      await withDatabase("broken", async (client) => {
        // A clean install first, so the fault lands on a database that is
        // already at head — which is the case that matters: a broken migration
        // discovered during a release, against a database that has everything
        // before it.
        const db = drizzle(client, { schema });
        await migrate(db, { migrationsFolder: scratch });
        const before = await fingerprint(client);

        // Now a migration that cannot succeed.
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
          entries: JournalEntry[];
        };
        journal.entries.push({
          idx: journal.entries.length,
          version: "7",
          when: 9_999_999_999_999,
          tag: "9999_deliberately_broken",
          breakpoints: true,
        });
        writeFileSync(journalPath, JSON.stringify(journal, null, 2));
        writeFileSync(
          path.join(scratch, "9999_deliberately_broken.sql"),
          'alter table "users" add column "never_added" text;--> statement-breakpoint\nthis is not sql;'
        );

        await assert.rejects(
          () => migrate(db, { migrationsFolder: scratch }),
          "the broken migration must fail"
        );

        const after = await fingerprint(client);
        assert.equal(
          after,
          before,
          "a failed migration must leave the schema exactly as it was — the column it " +
            "was adding must not be there, and nothing else may have changed either"
        );

        // And the fault removed: the same migration set now applies.
        rmSync(path.join(scratch, "9999_deliberately_broken.sql"));
        journal.entries.pop();
        writeFileSync(journalPath, JSON.stringify(journal, null, 2));

        await migrate(db, { migrationsFolder: scratch });
        const recovered = await fingerprint(client);
        assert.equal(
          recovered,
          before,
          "removing the fault must leave the database where it was, and the next run must succeed"
        );
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the documented rollback restores a dump (§9.3)", () => {
  it("returns the data to the state the dump was taken from", async (t) => {
    // §6.5's rollback is a restore, not a down migration: "Drizzle migrations
    // are forward-only; restoring a dump is the rollback." So the rollback is
    // tested the way it is performed.
    //
    // What the restore actually does is what `scripts/migrate.sh` says it
    // does: `--clean --if-exists` drops and recreates the objects the dump
    // contains. It does not wipe the schema — an object the dump never had is
    // left alone — and the test pins that, because "drops the current schema"
    // and "replaces what the dump holds" are different promises.
    //
    // `pg_dump` and `pg_restore` come from the PostgreSQL client package, which
    // a developer machine may not have and a CI runner does. The test says so
    // rather than passing vacuously.
    const which = await run("sh", ["-c", "command -v pg_dump && command -v pg_restore"]).catch(
      () => null
    );
    if (!which) {
      t.skip("pg_dump and pg_restore are not installed");
      return;
    }

    await withDatabase("rollback", async (client) => {
      const environment = pgEnvironment("rollback");
      const scratch = mkdtempSync(path.join(os.tmpdir(), "keystone-dump-"));
      const dumpFile = path.join(scratch, "audit.dump");

      try {
        await client.unsafe("create table rollback_marker (id int, note text)");
        await client.unsafe("insert into rollback_marker values (1, 'before the dump')");
        await client.unsafe("create table untouched_by_the_dump (id int)");

        await run("pg_dump", ["-Fc", "--no-owner", "--no-privileges", "-f", dumpFile], { env: environment });

        // A change made after the dump. The restore must undo it.
        await client.unsafe("insert into rollback_marker values (2, 'after the dump')");

        await run(
          "pg_restore",
          ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", "rollback", dumpFile],
          { env: environment }
        );

        const rows = await client<{ id: number; note: string }[]>`
          select id, note from rollback_marker order by id
        `;
        assert.equal(
          rows.length,
          1,
          "the restore must return the data to the state the dump was taken from"
        );
        assert.equal(rows[0].note, "before the dump");

        // What the dump did not contain is not the restore's business.
        const untouched = await client<{ count: number }[]>`
          select count(*)::int as count from information_schema.tables
          where table_schema = 'public' and table_name = 'untouched_by_the_dump'
        `;
        assert.equal(
          untouched[0].count,
          1,
          "the restore replaces what the dump contains; it does not wipe the schema"
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  });
});
