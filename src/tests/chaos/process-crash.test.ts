import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "chaos-process-crash";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.KEYSTONE_SETUP_TOKEN = "chaos-process-crash-setup-token-0123456789";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { hashPassword } = await import("../../services/secrets/index.js");
const { users } = await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");

/**
 * §8.4 — a Keystone process that dies.
 *
 * A crash is different from an error. An error is handled: the code runs
 * something, the transaction rolls back, the lock is released, the process
 * carries on. A crash is the absence of all of that. Whatever the system
 * guarantees after a crash, it guarantees because the *state* says so — not
 * because a handler remembered to tidy up, because there was no handler.
 *
 * Two guarantees are under test here:
 *
 * - **No half-written owner.** The bootstrap creates the platform owner, and a
 *   platform with two owners is not a platform with one owner — it is a
 *   different, worse thing. A crash between "the owner row is written" and
 *   "the bootstrap is done" must not leave an owner behind that the next
 *   bootstrap cannot see.
 * - **No lock left held.** The bootstrap is serialized by a Postgres advisory
 *   lock, and a lock is held by a *session*. If the process died holding it
 *   and the session did not end with the process, the next bootstrap would
 *   wait forever for a lock nobody will release.
 *
 * The process is killed with SIGKILL, so there is no `finally`, no release
 * call, and no graceful shutdown. Anything the system knows, it knows from
 * the database.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const createdUserIds: string[] = [];

let app: FastifyInstance;

async function makeUser(label: string) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${RUN_ID}@example.test`,
      username: `${label}${RUN_ID}`.slice(0, 32),
      name: label,
      passwordHash: await hashPassword("Chaos-Process-Passw0rd!"),
      emailVerified: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("a process killed mid-bootstrap leaves nothing behind (§8.4)", () => {
  it("writes no owner, and releases the lock so the next bootstrap can run", async () => {
    const previousOwners = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "owner"));
    const previouslyOwnerIds = previousOwners.map((owner) => owner.id);
    await db.update(users).set({ role: "user" }).where(eq(users.role, "owner"));

    const email = `crash-bootstrap-${crypto.randomUUID().slice(0, 8)}@example.test`;

    try {
      // A child that takes the bootstrap's advisory lock, starts writing the
      // owner inside a transaction, and is then killed. It never finishes the
      // transaction, never releases the lock, and never runs a `finally`.
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
          const { db, withAdvisoryLock } = await import(${JSON.stringify(
            path.join(__dirname, "..", "..", "db", "index.js")
          )});
          const { users } = await import(${JSON.stringify(
            path.join(__dirname, "..", "..", "db", "schema.js")
          )});
          const { eq } = await import("drizzle-orm");
          const { hashPassword } = await import(${JSON.stringify(
            path.join(__dirname, "..", "..", "services", "secrets", "index.js")
          )});

          const result = await withAdvisoryLock("keystone:setup:bootstrap", async () => {
            await db.transaction(async (tx) => {
              await tx.insert(users).values({
                email: ${JSON.stringify(email)},
                username: ${JSON.stringify(`crash${RUN_ID}`.slice(0, 32))},
                name: "crash bootstrap",
                role: "owner",
                emailVerified: true,
                passwordHash: await hashPassword("Chaos-Process-Passw0rd!"),
              });
              // Hold the transaction open, so the kill lands inside it.
              await new Promise(() => {});
            });
          });
          if (!result.acquired) {
            console.error("LOCK NOT ACQUIRED");
            process.exit(3);
          }
          `,
        ],
        {
          env: { ...process.env },
          cwd: path.join(__dirname, "..", "..", ".."),
        }
      );

      // Wait for the child to be inside the transaction: the owner row is
      // written but uncommitted, so it is not visible from here.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const childExit = new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code))
      );
      child.kill("SIGKILL");
      const code = await childExit;
      assert.equal(code, null, "the child must have been killed, not have exited on its own");

      // The transaction was open when the process died, so the write was
      // rolled back by the database. Nothing is visible.
      const owners = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "owner"), eq(users.isActive, true)));
      assert.equal(
        owners.length,
        0,
        "a killed process must leave no owner behind — the transaction rolled back"
      );

      const created = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      assert.equal(created.length, 0, "the killed process's write must not be visible");

      // And the lock is free: the next bootstrap runs, and it is the only one.
      const bootstrap = await app.inject({
        method: "POST",
        url: "/setup/init",
        headers: { "x-setup-token": process.env.KEYSTONE_SETUP_TOKEN },
        payload: { email: `after-crash-${crypto.randomUUID().slice(0, 8)}@example.test`, password: "Chaos-After-Crash!" },
      });
      assert.equal(
        bootstrap.statusCode,
        200,
        `the bootstrap must be able to run after a crash — the lock was left held: ${bootstrap.body}`
      );

      const ownersAfter = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "owner"), eq(users.isActive, true)));
      assert.equal(ownersAfter.length, 1, "the platform must end up with exactly one active owner");
    } finally {
      await db.update(users).set({ role: "user" }).where(eq(users.role, "owner"));
      for (const id of previouslyOwnerIds) {
        await db.update(users).set({ role: "owner" }).where(eq(users.id, id));
      }
    }
  });
});

describe("a crashed process does not take the server with it (§8.4)", () => {
  it("keeps serving after a crash, and the state it left is coherent", async () => {
    // The crash above happened in a *different* process. This one is the
    // survivor: it must not have been affected by the other process's death,
    // and the rows that process left behind must be a state it can reason
    // about.
    const user = await makeUser("chaos-survivor");
    const res = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: "Chaos-Process-Passw0rd!" },
    });
    assert.equal(res.statusCode, 200, `the server must still serve: ${res.body}`);

    // No half-written rows left by the crash: the user this suite created is
    // whole, and the one the killed process tried to write is absent.
    //
    // The number of platform owners is not asserted here: this database is
    // shared with the suites that deliberately create owners, and counting
    // them globally would make this suite fail for another suite's leftovers.
    // The bootstrap race suite owns that question.
    const own = await db
      .select({ id: users.id, role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, user.id));
    assert.equal(own.length, 1, "the user this suite created must be whole");
    assert.equal(own[0].role, "user", "a user created by this suite must not be an owner");
    assert.equal(own[0].isActive, true);
  });
});
