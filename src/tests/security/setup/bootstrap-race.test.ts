import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "bootstrap-race-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

/**
 * The route refuses to run without a setup token, and compares against this
 * value. Assigned, not defaulted: the file must not depend on whatever token the
 * surrounding environment happens to carry.
 */
const SETUP_TOKEN = "bootstrap-race-setup-token-0123456789abcdef";
process.env.KEYSTONE_SETUP_TOKEN = SETUP_TOKEN;

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { buildApp } = await import("../../../index.js");
const { db, withAdvisoryLock } = await import("../../../db/index.js");
const { users } = await import("../../../db/schema.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");

/** How many callers race for the bootstrap. The plan's §1.6 asks for 20. */
const CONCURRENT = 20;

/**
 * §1.6 — concurrent `/setup/init` requests both created an owner.
 *
 * The handler read `hasNoOwners()` and then, in separate statements, registered
 * or promoted a user and set its role. Two requests issued close enough together
 * both read "no owners" and both wrote, so a fresh deployment answered its first
 * simultaneous callers with two platform owners. Nothing in the database
 * prevented it: `updateRole` protects the *last* owner from being demoted, and
 * there is no invariant that says there can be only one.
 *
 * The fix serializes the bootstrap behind a Postgres advisory lock, so the losers
 * are refused (409 while it is in progress, 403 once it is done) instead of racing
 * to write a second owner.
 */
describe("the setup bootstrap is serialized (§1.6)", () => {
  let app: FastifyInstance;
  let previouslyOwnerIds: string[] = [];
  let email = "";

  before(async () => {
    // The bootstrap registers a user, and registration issues a token set — so
    // without the signing keys the route answers 500 on the winner and the race
    // never happens. `index.ts` loads them at boot; a test that builds the app
    // directly has to say so itself.
    await loadSigningKeys();
    app = await buildApp();
    await app.ready();

    email = `bootstrap-race-${crypto.randomUUID().slice(0, 8)}@example.test`;

    // The route only runs while no active owner exists, and this database is
    // shared with every other suite. Owners are *demoted*, never deleted: a
    // delete would have to unpick every foreign key pointing at the user
    // (refresh tokens, sessions, memberships), and the demotion is restored in
    // `after`.
    const owners = await db.select({ id: users.id }).from(users).where(eq(users.role, "owner"));
    previouslyOwnerIds = owners.map((o) => o.id);
    if (previouslyOwnerIds.length > 0) {
      await db.update(users).set({ role: "user" }).where(eq(users.role, "owner"));
    }
  });

  after(async () => {
    await app.close();
    // Drop the owner this suite created, then hand the platform back to whoever
    // owned it before.
    await db.update(users).set({ role: "user" }).where(eq(users.role, "owner"));
    if (previouslyOwnerIds.length > 0) {
      await db.update(users).set({ role: "owner" }).where(inArray(users.id, previouslyOwnerIds));
    }
  });

  it("admits exactly one winner and leaves exactly one owner", async () => {
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        app.inject({
          method: "POST",
          url: "/setup/init",
          headers: { "x-setup-token": SETUP_TOKEN },
          payload: { email, password: "Bootstrap-Race-Passw0rd!" },
        })
      )
    );

    const statuses = responses.map((r) => r.statusCode);
    const winners = statuses.filter((s) => s === 200);

    assert.equal(
      winners.length,
      1,
      `exactly one caller may bootstrap; got ${winners.length} winners from ${JSON.stringify(statuses)}`
    );
    for (const status of statuses) {
      // 403 when the request reached the route after the bootstrap finished,
      // 409 when it arrived while another caller held the lock. Any other code —
      // a 500 in particular — means the race was lost in an unforeseen way.
      assert.ok(
        status === 200 || status === 403 || status === 409,
        `unexpected status ${status} from ${JSON.stringify(statuses)}`
      );
    }

    const owners = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "owner"), eq(users.isActive, true)));
    assert.equal(owners.length, 1, "the platform must end up with exactly one active owner");

    const created = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    assert.equal(created.length, 1, "the winner must have created exactly one user for that address");
  });

  it("still refuses a second bootstrap once one has completed", async () => {
    // The sequential case, which the lock must not have changed: after the race
    // above there is an owner, so the route's own guard answers 403 without
    // taking the lock at all.
    const res = await app.inject({
      method: "POST",
      url: "/setup/init",
      headers: { "x-setup-token": SETUP_TOKEN },
      payload: { email: `later-${crypto.randomUUID().slice(0, 8)}@example.test`, password: "Another-Passw0rd!" },
    });
    assert.equal(res.statusCode, 403);
  });
});

/**
 * The primitive the fix rests on, tested directly.
 *
 * The route-level test above proves the outcome; this proves the mechanism, and
 * it is deterministic rather than timing-dependent — the first holder signals
 * from *inside* the lock, so the second attempt is made at a moment when the lock
 * is known to be held.
 */
describe("the setup advisory lock", () => {
  const name = `test-lock-${crypto.randomUUID()}`;

  it("admits one holder at a time, and frees the name on release", async () => {
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const first = withAdvisoryLock(name, async () => {
      entered();
      await gate;
      return "first";
    });
    await holding;

    const second = await withAdvisoryLock(name, async () => "second");
    assert.equal(second.acquired, false, "a second holder must be refused while the first holds the lock");

    openGate();
    const firstResult = await first;
    assert.equal(firstResult.acquired, true);
    assert.equal(firstResult.acquired && firstResult.value, "first");

    // And the name is usable again afterwards. A lock that is never released
    // would be worse than no lock: the bootstrap could then never be retried
    // after a crash.
    const third = await withAdvisoryLock(name, async () => "third");
    assert.equal(third.acquired, true, "the lock must be free once its holder returns");
    assert.equal(third.acquired && third.value, "third");
  });
});
