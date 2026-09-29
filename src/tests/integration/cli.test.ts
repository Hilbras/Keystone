import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";

const run = promisify(execFile);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "cli-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { db, closeDb } = await import("../../db/index.js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { users, organizations, auditLog } = await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");

/**
 * The CLI, one case per command.
 *
 * §4.5: 177 lines, eight commands, and no tests — for the interface an operator
 * reaches for when something has already gone wrong. Each command is run as a
 * real subprocess against the real database, because the things that were broken
 * are exactly the things an in-process test cannot see:
 *
 * - **`user:create` did not work at all.** The CLI never called
 *   `loadSigningKeys()`, so minting the first token threw "JWT signing keys not
 *   loaded" and the command that creates the platform owner — the first thing
 *   anyone runs on a new deployment — always failed.
 * - **Every database-touching command hung.** `db` is a module-level pool and an
 *   open socket is a live handle, so the process never reached an empty event loop
 *   and never exited. `org:create` printed its success line and then sat there
 *   forever, and the operator's response to a hung command is Ctrl-C, which
 *   destroys the exit code that would have said it worked.
 * - **`secrets:rotate` reported success while rotating nothing.** The environment
 *   provider nulled its cache and re-imported the same `JWT_PRIVATE_KEY`, and the
 *   command printed "Rotated signing key. New key id: env".
 * - **`--version` was hardcoded to "1.9.0"** against a package at 3.3.0.
 *
 * Running a subprocess is the only way to assert the exit code, which is the
 * whole of what a CLI's caller observes.
 *
 * The roadmap asks explicitly that `secrets:rotate` run twice be either idempotent
 * or loudly failing. The decision, taken here rather than left unspecified: it
 * **must fail loudly**, and cannot be otherwise — see the case below.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const CLI = path.resolve(__dirname, "../../../dist/cli.js");
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Whether the process had to be killed for not exiting on its own. */
  timedOut: boolean;
}

/**
 * Run a CLI command, bounded.
 *
 * The bound is the point, not a safety net: a command that never exits is one of
 * the defects this suite exists to catch, so "did it return on its own" is an
 * assertion rather than a convenience.
 */
async function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr, timedOut: false };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    // A timeout surfaces as a kill; report it as its own thing rather than as a
    // non-zero exit, so the assertions can name what actually went wrong.
    if (e.signal === "SIGTERM" || e.killed) {
      return { code: -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "", timedOut: true };
    }
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "", timedOut: false };
  }
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
});

after(async () => {
  for (const id of createdOrgIds) {
    await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await db
    .delete(auditLog)
    .where(eq(auditLog.event, "platform_role_changed:v1"))
    .catch(() => {});
  await closeDb().catch(() => {});
});

describe("CLI", () => {
  it("exists as a built entry point", async () => {
    const { access } = await import("node:fs/promises");
    await access(CLI);
  });

  it("reports the package version, not a stale literal", async () => {
    const pkg = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        path.resolve(__dirname, "../../../package.json"),
        "utf8"
      )
    ) as { version: string };

    const res = await cli(["--version"]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(
      res.stdout.trim(),
      pkg.version,
      "`keystone --version` is the first thing anyone runs when filing a bug report. " +
        "It was hardcoded at 1.9.0 while the package was at 3.3.0, and nothing " +
        "noticed, because a test asserting \"1.9.0\" passes just as long as nobody " +
        "remembers to update it."
    );
  });

  describe("init", () => {
    it("prints guidance and exits 0", async () => {
      const res = await cli(["init"]);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.timedOut, false, "init must exit on its own");
      assert.match(res.stdout, /\.env/);
    });
  });

  describe("config:validate", () => {
    it("reports the configuration with the connection strings redacted", async () => {
      const res = await cli(["config:validate"], {
        DATABASE_URL: "postgresql://someone:a-real-password@localhost:5432/hilbras",
      });
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /Configuration OK/);
      assert.ok(
        !res.stdout.includes("a-real-password"),
        `the password reached stdout: ${res.stdout}`
      );
      assert.match(res.stdout, /\/\/\*\*\*@/, "credentials should be masked");
    });

    it("fails with a non-zero exit when a required variable is missing", async () => {
      const res = await cli(["config:validate"], { DATABASE_URL: "" });
      assert.notEqual(res.code, 0, `expected a failure exit, got ${res.code}`);
      assert.match(res.stderr, /DATABASE_URL/);
    });
  });

  describe("keys:create", () => {
    it("emits a usable key pair and keeps the private half out of the label line", async () => {
      const res = await cli(["keys:create"]);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.timedOut, false, "keys:create must exit on its own");

      assert.match(res.stdout, /-----BEGIN PRIVATE KEY-----/);
      assert.match(res.stdout, /-----BEGIN PUBLIC KEY-----/);

      // The output is meant to be pasted into a .env file, so the PEMs have to be
      // parseable rather than merely present. Ascertained here rather than
      // assumed: a mangled paste is a failed first run for whoever was told to
      // run this.
      const { importPKCS8, importSPKI } = await import("jose");
      const privatePem = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/.exec(res.stdout)?.[0];
      const publicPem = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/.exec(res.stdout)?.[0];
      assert.ok(privatePem, "no private PEM in the output");
      assert.ok(publicPem, "no public PEM in the output");

      const privateKey = await importPKCS8(privatePem, "RS256");
      const publicKey = await importSPKI(publicPem, "RS256");
      assert.ok(privateKey && publicKey, "the emitted PEMs should parse");
    });
  });

  describe("keys:list", () => {
    it("exits on its own", async () => {
      // The hang, asserted directly. This command touches the database, and before
      // the fix the process never returned: an open pool is a live handle, so the
      // event loop never emptied.
      const res = await cli(["keys:list"]);
      assert.equal(res.timedOut, false, "keys:list hung — the connections are never released");
      assert.equal(res.code, 0, res.stderr);
    });

    it("prints nothing and still exits 0 when there is no key yet", async () => {
      // The behaviour a fresh deployment has, and the one that was wrong in the
      // first version of this suite: it asserted a key line was printed, which
      // passed on a development database that had been rotated a hundred times and
      // failed on a clean CI database with none. An empty list is the truth, and
      // the command should say so by saying nothing.
      //
      // Asserted on a database that definitely has no active key: the
      // `secrets:rotate` cases above create one, and test files share a process,
      // so the state cannot be assumed either way.
      const { db: direct } = await import("../../db/index.js");
      const { secrets, and, eq, isNull } = { ...(await import("../../db/schema.js")), ...(await import("drizzle-orm")) };
      await direct
        .update(secrets)
        .set({ isActive: false })
        .where(and(eq(secrets.type, "jwt_signing"), isNull(secrets.expiresAt)));

      const res = await cli(["keys:list"]);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(
        res.stdout.trim(),
        "",
        "with no active key the command should print nothing and exit 0, not a line of prose"
      );

      // Put the key back so later cases see a normal database.
      const { getActiveSigningKey } = await import("../../services/secrets/index.js");
      await getActiveSigningKey();
    });

    it("lists the active key once one exists", async () => {
      // Seeded explicitly in this process, rather than inherited from whatever the
      // database happened to contain. A suite that depends on pre-existing state
      // passes locally and fails in CI, and the failure looks like a product bug.
      const { getActiveSigningKey } = await import("../../services/secrets/index.js");
      const expected = await getActiveSigningKey();

      const res = await cli(["keys:list"]);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /created=/, `expected a key line, got: ${res.stdout}`);
      assert.ok(
        res.stdout.includes(expected.keyId),
        `the active key ${expected.keyId} should be listed; got: ${res.stdout}`
      );
      assert.ok(
        !/BEGIN PRIVATE KEY/.test(res.stdout),
        "keys:list must not print private key material"
      );
    });
  });

  describe("migrate", () => {
    it("applies migrations and exits", async () => {
      const res = await cli(["migrate"]);
      assert.equal(res.timedOut, false, "migrate hung — the database pool is never released");
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /Migrations applied/);
    });
  });

  describe("secrets:rotate", () => {
    it("rotates a real key when the provider can, and the key actually changes", async () => {
      // The default provider stores keys in the database, and it can genuinely
      // rotate: the old key is deactivated and a new pair is generated. The
      // roadmap asks whether a second rotation is idempotent or loud; the answer
      // is that for this provider the question does not arise, because each call
      // is a real rotation and produces a different key.
      const { getActiveSigningKey } = await import("../../services/secrets/index.js");
      const before = await getActiveSigningKey();

      const res = await cli(["secrets:rotate"]);
      assert.equal(res.timedOut, false, "secrets:rotate hung — connections are never released");
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /Rotated signing key\. New key id: (\S+)/);

      const after = await getActiveSigningKey();
      assert.notEqual(
        after.keyId,
        before.keyId,
        "a rotation that reports success must produce a different key"
      );
      const { exportSPKI } = await import("jose");
      assert.notEqual(
        await exportSPKI(after.publicKey),
        await exportSPKI(before.publicKey),
        "and different key material, not just a different label"
      );
    });

    it("rotates again without complaint, because each rotation is real", async () => {
      const { getActiveSigningKey } = await import("../../services/secrets/index.js");
      const before = await getActiveSigningKey();
      const res = await cli(["secrets:rotate"]);
      assert.equal(res.code, 0, res.stderr);
      const after = await getActiveSigningKey();
      assert.notEqual(after.keyId, before.keyId);
    });

    it("refuses loudly when the provider cannot rotate, rather than reporting success", async () => {
      // The decision the roadmap asked to be made explicitly: with the
      // *environment* provider, `secrets:rotate` **must fail loudly**. It cannot
      // be idempotent, because there is nothing to be idempotent about.
      //
      // The key material comes from `JWT_PRIVATE_KEY`. Nulling the cache and
      // re-importing gives the same key under the same key id — which is exactly
      // what it used to do, while printing "Rotated signing key. New key id: env".
      // An operator rotating keys after a suspected compromise was told it
      // worked, and it had not.
      //
      // Generating a fresh pair in-process would be worse: every instance reads
      // the same environment variable, so each would mint a *different* key and
      // the cluster would stop agreeing on who signed what.
      const res = await cli(["secrets:rotate"], { KEYSTONE_SECRETS_PROVIDER: "environment" });

      assert.equal(res.timedOut, false, "secrets:rotate hung — connections are never released");
      assert.notEqual(
        res.code,
        0,
        `rotation must not exit 0 when nothing was rotated; stdout: ${res.stdout}`
      );
      assert.match(res.stderr, /NOT rotated/i);
      assert.ok(
        !/Rotated signing key/.test(res.stdout),
        `the success line must not be printed: ${res.stdout}`
      );
      assert.match(res.stderr, /JWT_PRIVATE_KEY/, "the message should say what to do instead");
    });

    it("does not change the key the server is using when it refuses", async () => {
      // The consequence that matters: a rotation that reported success and
      // changed nothing would have been believed, and every token issued under
      // the old key would still verify.
      const { getActiveSigningKey } = await import("../../services/secrets/index.js");
      const before = await getActiveSigningKey();
      const { exportSPKI } = await import("jose");
      const beforePem = await exportSPKI(before.publicKey);

      await cli(["secrets:rotate"], { KEYSTONE_SECRETS_PROVIDER: "environment" });

      const after = await getActiveSigningKey();
      assert.equal(after.keyId, before.keyId, "a refused rotation must not change the key");
      assert.equal(await exportSPKI(after.publicKey), beforePem, "nor the material");
    });

    it("reports a rotation failure through the exit code, not an unhandled rejection", async () => {
      // An exception thrown out of an async commander action is an unhandled
      // rejection, and the process still exits 0. So the failure was visible on
      // the console and invisible to anything wrapping the command.
      const res = await cli(["secrets:rotate"], { KEYSTONE_SECRETS_PROVIDER: "environment" });
      assert.equal(res.code, 1, `expected exit 1, got ${res.code}; stderr: ${res.stderr}`);
      assert.ok(
        !/UnhandledPromiseRejection|unhandled/i.test(res.stderr),
        `the failure should be reported, not thrown: ${res.stderr}`
      );
    });
  });

  describe("user:create", () => {
    it("creates a user, and the row is in the database", async () => {
      const email = `cli-${RUN_ID}@example.test`;
      const res = await cli([
        "user:create",
        "--email", email,
        "--password", "Passw0rd!x",
        "--role", "user",
      ]);

      assert.equal(res.timedOut, false, "user:create hung — the database pool is never released");
      // This one always failed before the fix: the CLI never called
      // `loadSigningKeys()`, so minting the first token threw "JWT signing keys
      // not loaded". The command that creates the platform owner did not work.
      assert.equal(res.code, 0, `user:create failed: ${res.stderr}`);
      // `includes` rather than a regex built from the address. The address is
      // test data and needs no pattern matching, and escaping it for a regex
      // raised CodeQL's `js/incomplete-sanitization` — a backslash in a value
      // would need escaping too, which is a real objection about the *approach*
      // and not one this assertion needed to be making.
      assert.ok(
        res.stdout.includes(email),
        `the command should name the address it created: ${res.stdout}`
      );

      const [user] = await db.select().from(users).where(eq(users.email, email));
      assert.ok(user, "the user row was not written");
      createdUserIds.push(user.id);
      assert.equal(user.role, "user");
      assert.ok(user.passwordHash, "a password hash should have been stored");
      assert.notEqual(user.passwordHash, "Passw0rd!x", "the password must not be stored as given");
    });

    it("creates an owner, records the role change, and says so", async () => {
      const email = `cliowner-${RUN_ID}@example.test`;
      const res = await cli([
        "user:create",
        "--email", email,
        "--password", "Passw0rd!x",
        "--role", "owner",
      ]);
      assert.equal(res.code, 0, `user:create --role owner failed: ${res.stderr}`);
      assert.match(res.stdout, /with role owner/);

      const [user] = await db.select().from(users).where(eq(users.email, email));
      assert.ok(user, "the owner row was not written");
      createdUserIds.push(user.id);
      assert.equal(user.role, "owner", "the role must be owner, not user");

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, "platform_role_changed:v1"));
      assert.ok(
        audits.some((row) => JSON.stringify(row.metadata).includes(user.id)),
        "granting platform ownership from the CLI must leave an audit record"
      );
    });

    it("rejects a role that is neither owner nor user, with a non-zero exit", async () => {
      const res = await cli([
        "user:create",
        "--email", `cli-bad-${RUN_ID}@example.test`,
        "--password", "Passw0rd!x",
        "--role", "superuser",
      ]);
      assert.notEqual(res.code, 0, `an invalid role should fail: ${res.stdout}`);
      assert.match(res.stderr, /owner or user/);
    });

    it("refuses a duplicate address rather than writing a second row", async () => {
      const email = `cli-dup-${RUN_ID}@example.test`;
      const first = await cli(["user:create", "--email", email, "--password", "Passw0rd!x"]);
      assert.equal(first.code, 0, first.stderr);

      const second = await cli(["user:create", "--email", email, "--password", "Passw0rd!x"]);
      assert.notEqual(second.code, 0, "a duplicate address must fail");
      assert.match(second.stderr, /Failed to create user/);

      const rows = await db.select().from(users).where(eq(users.email, email));
      assert.equal(rows.length, 1, "there must still be exactly one row");
      createdUserIds.push(rows[0].id);
    });
  });

  describe("org:create", () => {
    it("creates an organization owned by an existing user, and exits", async () => {
      const email = `cliorgowner-${RUN_ID}@example.test`;
      const owner = await cli(["user:create", "--email", email, "--password", "Passw0rd!x"]);
      assert.equal(owner.code, 0, owner.stderr);

      const slug = `cli-org-${RUN_ID}`;
      const res = await cli([
        "org:create",
        "--name", "CLI Organization",
        "--slug", slug,
        "--owner-email", email,
      ]);

      // The other half of the hang: this command printed its success line and
      // then sat there forever, because the pool was never released.
      assert.equal(res.timedOut, false, "org:create hung — the database pool is never released");
      assert.equal(res.code, 0, res.stderr);

      const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
      assert.ok(org, "the organization row was not written");
      createdOrgIds.push(org.id);
    });

    it("refuses an owner that does not exist, and writes nothing", async () => {
      const slug = `cli-org-missing-${RUN_ID}`;
      const res = await cli([
        "org:create",
        "--name", "Should Not Exist",
        "--slug", slug,
        "--owner-email", `ghost-${RUN_ID}@example.test`,
      ]);

      assert.notEqual(res.code, 0, "an unknown owner should fail");
      assert.match(res.stderr, /not found/);
      const rows = await db.select().from(organizations).where(eq(organizations.slug, slug));
      assert.equal(rows.length, 0, "no organization may be left behind by a failed create");
    });
  });
});
