/**
 * A repeatable benchmark for the five paths the roadmap calls hot.
 *
 * The v3.0.1 analysis said SCIM groups was N+1 on read and quadratic on member
 * write, and rated two unindexed tables High. All three were opinions. One turned
 * out to be wrong once measured — 145 and 292 rows, where the sequential scans
 * were the right plan — and one turned out to be a real 57× problem. Nothing
 * distinguished them except running the query. This is that, written down, so the
 * next release is measured rather than argued about.
 *
 * Two numbers are recorded per scenario, and they are not equally trustworthy:
 *
 *   `queries`  Exact and machine-independent. This is the number an N+1 regression
 *              is actually made of, so it is the hard gate: a scenario that used
 *              to issue N statements and issues N+1 fails, with no tolerance to
 *              argue about.
 *
 *   `relative` Wall-clock divided by a control measured in the same process, on
 *              the same machine, at the same moment. An absolute millisecond
 *              baseline recorded on a laptop is meaningless on a CI runner three
 *              times slower, and comparing against one produces a gate that is
 *              either permanently red or permanently green. The ratio survives
 *              the machine. The control is deliberately dull — a fixed integer
 *              loop and a fixed number of `SELECT 1`s — because a control that is
 *              itself interesting needs its own baseline.
 *
 * Usage:
 *   npm run bench:hot            # run and compare against the recorded baseline
 *   npm run bench:hot -- --record  # overwrite the baseline
 *   npm run bench:hot -- --json    # numbers only, no comparison, no exit code
 */

import crypto from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { eq, inArray, like, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { db, closeDb } from "../db/index.js";
import { startCountingQueries, stopCountingQueries } from "../db/queryCounter.js";
import { migrationsFolder, fromRoot } from "../lib/paths.js";
import { applications, orgMemberships, organizations, scimGroupMembers, scimGroups, users } from "../db/schema.js";
import { hashPassword } from "../services/secrets/index.js";
import { buildApp } from "../index.js";
import { loadSigningKeys } from "../services/tokens.js";
import { ScimConnectionService } from "../services/scimCredentials.js";
import { refreshCookieName } from "../plugins/auth.js";
import { compare, type BenchRun, type ScenarioReading } from "./compare.js";

// Read by buildApp() when it builds the logger, which happens after this module is
// evaluated. Without it every injected request writes a JSON log line, and the
// benchmark spends more time on logging than on the path it is measuring — a
// number that includes its own logging is a number about logging.
process.env.KEYSTONE_LOG_LEVEL = "silent";

const PASSWORD = "Bench-Passw0rd!";
const RUN_TAG = "keystone-bench";

/** Samples per scenario; the median is reported. */
const SAMPLES = 5;
/**
 * Fewer samples for the paths that are expensive per iteration.
 *
 * The 1000-member reconcile inserts a thousand rows every sample. Three samples
 * still yield a median, and the fourth costs another thousand inserts for a number
 * that has stopped moving.
 */
const SAMPLES_HEAVY = 3;
/** Rows per multi-row insert when seeding. One round trip per 250 users, not per user. */
const SEED_CHUNK = 250;
/** How much slower than baseline counts as a failure. Generous on purpose. */
const TIMING_TOLERANCE = 0.4;
/** A page is capped server-side, so 1000 groups is two requests. */
const PAGE = 500;
const GROUP_SIZES = [50, 200, 1000];
const MEMBER_SIZES = [10, 100, 1000];

interface Measured {
  /** The median of the samples. The number that is compared. */
  ms: number;
  /** The fastest sample, so a large spread is visible rather than averaged away. */
  fastest: number;
  queries: number;
  samples: number[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * A fixed amount of pure computation, used to calibrate this machine right now.
 *
 * Not a cryptographic hash: those are dominated by whether the CPU has AES
 * acceleration, which varies more between machines than the code varies between
 * releases. Just a dull loop that cannot be optimised away.
 */
function cpuControl(): number {
  const started = process.hrtime.bigint();
  let acc = 0;
  for (let i = 0; i < 3_000_000; i++) acc = (acc + i * 2654435761) % 4294967296;
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.notEqual(acc, 0, "the control has to actually compute something");
  return ms;
}

/** A fixed number of round trips, to calibrate the connection and the server. */
async function dbControl(rounds: number): Promise<number> {
  const started = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) await db.execute(sql`select 1`);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * The cheapest of three observations of the same fixed work.
 *
 * A minimum, because contention can only ever add time. Taking the cheapest of
 * three also stops a single unlucky scheduling hiccup from becoming the divisor
 * for every scenario in the run.
 */
function bestOf(times: number[]): number {
  return Math.min(...times);
}

/**
 * A distinct source address per sample.
 *
 * `POST /auth/token-login` is rate limited to five attempts per fifteen minutes,
 * keyed on the client address together with the submitted address. Six logins
 * from one address therefore means the sixth is refused — and a refusal is *fast*,
 * because it never reaches the password comparison. The benchmark measured 528,
 * 495, 504 and 504ms and then 20ms, and the 20ms was a 429: the scenario was
 * reporting the rate limiter's speed as the cost of a login.
 *
 * This is the failure mode worth naming, because nothing about the result looked
 * wrong. Five of the six numbers were plausible, and the assertion that would
 * have caught it was upstream of where the number came from.
 *
 * A distinct address per sample also happens to be more representative than six
 * logins from 127.0.0.1 inside a second.
 */
function addressFor(sample: number): string {
  return `10.${Math.floor(sample / 250) % 250}.${sample % 250}.1`;
}

/**
 * Calibrate the machine, right now, immediately before the scenario that will be
 * divided by it.
 *
 * Not once for the whole run. A full pass takes ten minutes, because the
 * 1,000-member reconcile takes fifty of them, and the machine does not stay in
 * one load regime for ten minutes. Measured once at the top, the control was
 * 108ms while the login samples that followed it ranged from 164ms to 3,809ms —
 * so every scenario was being divided by a number from a different minute than
 * the one it ran in. The three samples of control cost about 300ms, against a
 * scenario that costs 50 seconds.
 */
async function calibrate(): Promise<{ cpuMs: number; dbMs: number; total: number }> {
  const cpuMs = bestOf([cpuControl(), cpuControl(), cpuControl()]);
  const dbMs = bestOf([await dbControl(20), await dbControl(20), await dbControl(20)]);
  return { cpuMs, dbMs, total: cpuMs + dbMs };
}

/**
 * Time a call and count the SQL it sent.
 *
 * `setup` runs before the clock starts and before counting starts, so resetting
 * state between samples does not show up as work. The query count reported is the
 * **maximum** across samples rather than the median: an N+1 that appears on one
 * request in five is still a regression, and a median would hide it.
 */
async function measure(
  setup: ((sample: number) => Promise<void>) | undefined,
  fn: (sample: number) => Promise<void>,
  samples = SAMPLES
): Promise<Measured> {
  const timings: number[] = [];
  let maxQueries = 0;

  for (let i = 0; i < samples; i++) {
    // One untimed pass first. The first execution of a path pays for JIT
    // compilation and a cold connection from the pool; folding that into the
    // median is how a benchmark reports a 4x difference between two runs of
    // identical code. The measured numbers here moved from 229ms to 79ms on the
    // same scenario when this was added, which is the size of the effect.
    if (i === 0) {
      await setup?.(i);
      const warm = process.hrtime.bigint();
      await fn(i);
      process.stdout.write(
        `    warm-up ${(Number(process.hrtime.bigint() - warm) / 1e6).toFixed(1)}ms\n`
      );
    }

    await setup?.(i);
    startCountingQueries();
    const started = process.hrtime.bigint();
    try {
      await fn(i);
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      timings.push(ms);
      maxQueries = Math.max(maxQueries, stopCountingQueries());
      process.stdout.write(`    sample ${i + 1}/${samples}: ${ms.toFixed(1)}ms\n`);
    }
  }

  return {
    // The median is the number that goes in the baseline and the number the gate
    // compares. The minimum is reported beside it, and the spread matters enough
    // to keep: the login path here measured 528, 495, 504, 504, then 20ms. A
    // minimum-only estimator records that 20ms as the cost of a login, which is
    // not what a login costs — a quarter of the samples took 500ms and the fast
    // one is doing something the others are not.
    //
    // The median is used for the opposite reason to the usual "use the minimum"
    // rule in benchmarking. Contention only ever adds time, which argues for a
    // minimum. But a spread this large is not contention, it is state, and a
    // state-dependent fast path is exactly the thing a minimum will latch onto
    // and record as the new normal.
    ms: Number(median(timings).toFixed(3)),
    fastest: Number(Math.min(...timings).toFixed(3)),
    queries: maxQueries,
    samples: timings.map((t) => Number(t.toFixed(3))),
  };
}

interface Fixture {
  orgId: string;
  appId: string;
  loginEmail: string;
  scimToken: string;
  pool: string[];
  groupIds: string[];
  ownerId: string;
}

async function seed(app: FastifyInstance): Promise<Fixture> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const poolSize = Math.max(...GROUP_SIZES, ...MEMBER_SIZES);
  const maxGroups = Math.max(...GROUP_SIZES);

  // One hash, reused. The cost being measured is row work, not key derivation;
  // hashing 1000 distinct passwords at production cost is about four minutes and
  // would measure argon2 rather than the query path.
  const passwordHash = await hashPassword(PASSWORD);
  process.stdout.write(`  seeding ${poolSize + 1} users`);
  const ids: string[] = [];
  for (let offset = 0; offset <= poolSize; offset += SEED_CHUNK) {
    const batch = [];
    for (let i = offset; i <= Math.min(offset + SEED_CHUNK - 1, poolSize); i++) {
      batch.push({
        email: `${RUN_TAG}-${suffix}-${i}@bench.invalid`,
        username: `${RUN_TAG}${suffix}${i}`.slice(0, 60),
        name: `Bench ${i}`,
        passwordHash,
        emailVerified: true,
      });
    }
    for (const row of await db.insert(users).values(batch).returning({ id: users.id })) {
      ids.push(row.id);
    }
  }
  assert.equal(ids.length, poolSize + 1, "the user pool came up short; the fixture is wrong");
  process.stdout.write("\n");

  const [org] = await db
    .insert(organizations)
    .values({ name: `${RUN_TAG} ${suffix}`, slug: `${RUN_TAG}-${suffix}` })
    .returning();

  // The owner is ids[0] — the account the login and authz scenarios authenticate
  // as — and the pool is everyone else. The authz scenario is refused with "Not a
  // member of this organization" if the owner is not in the membership table, so
  // the owner has to be in it.
  const pool = ids.slice(1);
  await db.insert(orgMemberships).values([
    { orgId: org.id, userId: ids[0], role: "owner" as const },
    ...pool.map((userId) => ({ orgId: org.id, userId, role: "member" as const })),
  ]);

  const [application] = await db
    .insert(applications)
    .values({
      orgId: org.id,
      clientId: `${RUN_TAG}-app-${suffix}`,
      name: `${RUN_TAG} app`,
      redirectUris: [],
    })
    .returning();

  const scimCredentials = new ScimConnectionService(app.container.scimConnectionRepository);
  const scim = await scimCredentials.create({ orgId: org.id, name: "bench" });
  assert.ok(scim.success, "the SCIM credential must exist for the group scenarios");

  process.stdout.write(`  seeding ${maxGroups} groups`);
  const groupIds: string[] = [];
  for (let offset = 0; offset < maxGroups; offset += SEED_CHUNK) {
    const batch = [];
    for (let i = offset; i < Math.min(offset + SEED_CHUNK, maxGroups); i++) {
      batch.push({ orgId: org.id, displayName: `bench-group-${i}`, externalId: crypto.randomUUID() });
    }
    for (const row of await db.insert(scimGroups).values(batch).returning({ id: scimGroups.id })) {
      groupIds.push(row.id);
    }
  }
  assert.equal(groupIds.length, maxGroups, "the group pool came up short; the fixture is wrong");
  process.stdout.write("\n");

  return {
    orgId: org.id,
    appId: application.id,
    loginEmail: `${RUN_TAG}-${suffix}-0@bench.invalid`,
    scimToken: scim.data.token,
    pool,
    groupIds,
    ownerId: ids[0],
  };
}

async function cleanup(fx: Fixture): Promise<void> {
  // Children first: the foreign keys cascade from the organization, but being
  // explicit means a partial failure cannot leave benchmark rows behind for the
  // next run to trip over.
  // `inArray` rather than a hand-written `ANY(${array}::uuid[])`. Postgres reads
  // the expanded parameter list as a record, not an array, and fails with
  // "cannot cast type record to uuid[]" — at cleanup, after the numbers have
  // already been recorded, which is the worst possible time to find out.
  if (fx.pool.length) {
    await db.delete(scimGroupMembers).where(inArray(scimGroupMembers.userId, fx.pool));
  }
  await db.delete(scimGroups).where(eq(scimGroups.orgId, fx.orgId));
  await db.delete(orgMemberships).where(eq(orgMemberships.orgId, fx.orgId));
  await db.delete(applications).where(eq(applications.orgId, fx.orgId));
  await db.delete(organizations).where(eq(organizations.id, fx.orgId));
  await db.delete(users).where(like(users.username, `${RUN_TAG}%`));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const record = argv.includes("--record");
  const jsonOnly = argv.includes("--json");
  // `--only=reconcile` runs a subset. Useful when iterating on one path, and
  // necessary when the full run is long: the reconcile scenarios insert a quarter
  // of a million rows between them.
  const only = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const wanted = (name: string) => only === undefined || name.includes(only);

  console.log("Keystone hot-path benchmark");
  console.log(`  node ${process.version} on ${process.platform}/${process.arch}`);

  await loadSigningKeys();

  const app = await buildApp();
  await app.ready();

  const fx = await seed(app);
  const scimAuth = { authorization: `Bearer ${fx.scimToken}` };
  const results: Record<string, ScenarioReading> = {};
  const controls: number[] = [];

  const report = async (name: string, r: Measured) => {
    // Calibrated after the scenario ran, so the control reflects the same minute
    // as the samples it divides. The load during a fifty-second reconcile is not
    // the load during a one-second login, and one number for the whole run cannot
    // describe both.
    const control = await calibrate();
    controls.push(control.total);
    const relative = Number((r.ms / control.total).toFixed(4));
    results[name] = { ...r, relative, controlMs: Number(control.total.toFixed(1)) };
    const spread = r.fastest > 0 ? (r.ms / r.fastest).toFixed(1) : "-";
    console.log(
      `  ${name.padEnd(26)} ${r.ms.toFixed(2).padStart(9)}ms` +
        `  ${String(r.queries).padStart(5)} queries` +
        `  rel ${relative} (control ${control.total.toFixed(1)}ms, spread ${spread}x)`
    );
  };

  // -- SCIM group list, paged -----------------------------------------------
  // The page is capped at 500 server-side, so listing 1000 groups is two
  // requests. Both are counted, because the N+1 the analysis described cost one
  // member query per group per page: batched this is 2 statements per page, and
  // unbounded it was 501.
  for (const size of GROUP_SIZES) {
    if (!wanted(`scim-group-list-${size}`)) continue;
    const r = await measure(undefined, async () => {
      let collected = 0;
      let startIndex = 1;
      while (collected < size) {
        const want = Math.min(PAGE, size - collected);
        const res = await app.inject({
          method: "GET",
          url: `/scim/v2/Groups?count=${want}&startIndex=${startIndex}`,
          headers: scimAuth,
        });
        assert.equal(res.statusCode, 200, res.body);
        const Resources = res.json().Resources as unknown[];
        assert.equal(Resources.length, want, "the page came back short; the fixture is wrong");
        collected += Resources.length;
        startIndex += Resources.length;
      }
    });
    await report(`scim-group-list-${size}`, r);
  }

  // -- SCIM group member reconcile -----------------------------------------
  // Members are cleared before each sample, so the timed work is the real write
  // path: one member insert per submitted member, plus whatever reads the
  // reconcile does around them. That is the number that makes a quadratic
  // regression visible — a per-member re-read would push this from N+1 to
  // 2N+1 statements, and the gate notices.
  for (const size of MEMBER_SIZES) {
    if (!wanted(`scim-group-reconcile-${size}`)) continue;
    const groupId = fx.groupIds[fx.groupIds.length - 1];
    const members = fx.pool.slice(0, size).map((value) => ({ value }));
    const clear = async () => {
      await db.delete(scimGroupMembers).where(sql`group_id = ${groupId}::uuid`);
    };
    const r = await measure(clear, async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/scim/v2/Groups/${groupId}`,
        headers: scimAuth,
        payload: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "bench-group",
          members,
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      // The group PUT returns the resource directly, not wrapped in a `Resource`
      // key the way the user endpoints wrap theirs.
      const group = res.json() as { members: { value: string }[] };
      assert.equal(
        group.members.length,
        size,
        `the reconcile applied ${group.members.length} of ${size} members`
      );
    }, size >= 1000 ? SAMPLES_HEAVY : SAMPLES);
    await report(`scim-group-reconcile-${size}`, r);
  }

  // -- login ---------------------------------------------------------------
  // A real user, so the request reaches the argon2 comparison. A miss for an
  // unknown address returns early and would measure almost nothing.
  if (wanted("login")) {
    const r = await measure(undefined, async (sample) => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/token-login",
        remoteAddress: addressFor(sample),
        payload: { email: fx.loginEmail, password: PASSWORD },
      });
      // 200, and not "any success": a 429 is also a fast success, and it is the
      // response this scenario would otherwise record as the cost of a login.
      assert.equal(res.statusCode, 200, res.body);
    });
    await report("login", r);
  }

  // -- refresh -------------------------------------------------------------
  // One rotation per sample: the token is single-use, so it is re-minted between
  // samples by the setup step. A refresh that is not a rotation is a different
  // path and is not what this scenario is for.
  if (wanted("refresh")) {
    let cookie = "";
    // Each mint uses a fresh address, for the same reason the login scenario
    // does: six logins from one address and the last of them is a 429.
    const mint = async (sample: number) => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/token-login",
        remoteAddress: addressFor(100 + sample),
        payload: { email: fx.loginEmail, password: PASSWORD },
      });
      assert.equal(res.statusCode, 200, res.body);
      // The refresh token comes back in the body, not in a cookie. A cookie is
      // only set when the caller identifies an OAuth client, and a body token is
      // what a machine client uses. The first version of this read the cookie and
      // found nothing, which is a clearer statement of the same mistake: a
      // benchmark asserting on a field the endpoint does not return.
      const body = res.json() as { refreshToken?: string };
      assert.ok(body.refreshToken, `no refresh token in the login response: ${res.body}`);
      cookie = `${refreshCookieName()}=${body.refreshToken}`;
    };
    await mint(0);
    const r = await measure(mint, async () => {
      const res = await app.inject({ method: "POST", url: "/auth/refresh", headers: { cookie } });
      assert.equal(res.statusCode, 200, res.body);
    });
    await report("refresh", r);
  }

  // -- authz check ---------------------------------------------------------
  if (wanted("authz-check")) {
    // A session access token, not an API key. `/v1/authz/check` is guarded by
    // `app.authenticate`, which reads the cookie or a Bearer header and verifies
    // it as a JWT — it does not fall through to the API-key resolver, so an
    // `x-api-key` header is simply ignored and the request 401s. The first
    // version of this scenario used one and asserted a 200, which is how a
    // benchmark ends up reporting a number for a request that never ran.
    const minted = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      remoteAddress: addressFor(200),
      payload: { email: fx.loginEmail, password: PASSWORD },
    });
    assert.equal(minted.statusCode, 200, minted.body);
    const accessToken = (minted.json() as { accessToken?: string }).accessToken;
    assert.ok(accessToken, `no access token in the login response: ${minted.body}`);

    const r = await measure(undefined, async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/authz/check",
        headers: { authorization: `Bearer ${accessToken}` },
        // A resource and action that are in the seeded permission catalogue.
        // "documents" is not one of them, so the check correctly answered `false`
        // and the scenario was measuring a refusal.
        payload: { resource: "organization", action: "read", organizationId: fx.orgId },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().allowed, true, "an owner should be allowed to read the organization");
    });
    await report("authz-check", r);
  }

  const payload: BenchRun = {
    recordedAt: new Date().toISOString(),
    node: process.version,
    control: { medianMs: Number(median(controls).toFixed(1)), minMs: Number(Math.min(...controls).toFixed(1)) },
    tolerance: TIMING_TOLERANCE,
    scenarios: results,
  };

  const baselinePath = fromRoot("docs", "performance", "hot-paths.baseline.json");

  // Always written, including on a failed run. The number someone wants after a
  // regression is the one from the run that regressed.
  const runPath = fromRoot("dist", "bench-output.json");
  writeFileSync(runPath, JSON.stringify(payload, null, 2) + "\n");

  if (record) {
    writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + "\n");
    console.log(`\n  recorded -> ${path.relative(fromRoot(), baselinePath)}`);
  } else if (jsonOnly) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printVerdict(baselinePath, payload, only !== undefined);
  }

  console.log("  cleaning up...");
  await cleanup(fx);
  await app.close();
  await closeDb().catch(() => {});
  const { redis } = await import("../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
}

/**
 * Print the verdict and set the exit code.
 *
 * The decision itself lives in `./compare.ts` so it can be tested. A benchmark's
 * comparison is the part nobody reads during a release and everybody trusts, which
 * is exactly the arrangement where a silent bug does the most damage.
 */
function printVerdict(baselinePath: string, current: BenchRun, filtered: boolean): void {
  if (!existsSync(baselinePath)) {
    console.log("\n  no baseline yet. Run 'npm run bench:hot -- --record' to create one.");
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BenchRun;
  const verdict = compare(baseline, current);

  for (const name of verdict.unmeasured) {
    console.log(`\n  ${name}: not in the baseline, nothing to compare`);
  }
  if (verdict.withinNoise.length) {
    // Said out loud rather than passed over in silence. A run that moved a number
    // past the ratio limit but not past the noise floor is not a pass, and calling
    // it one is how a gate starts telling people what they want to hear.
    console.log("\n  moved, but within the noise floor:");
    verdict.withinNoise.forEach((l) => console.log(l));
  }
  if (verdict.missing.length) {
    console.log("\n  SCENARIOS THAT STOPPED BEING MEASURED:");
    verdict.missing.forEach((l) => console.log(`  ${l}`));
  }
  if (verdict.faster.length) {
    console.log("\n  faster than baseline:");
    verdict.faster.forEach((l) => console.log(l));
  }
  if (verdict.timingRegressions.length) {
    console.log(`\n  TIMING REGRESSIONS (tolerance ${baseline.tolerance * 100}%):`);
    verdict.timingRegressions.forEach((l) => console.log(l));
  }
  if (verdict.queryRegressions.length) {
    console.log("\n  QUERY REGRESSIONS (any increase fails):");
    verdict.queryRegressions.forEach((l) => console.log(l));
  }

  if (filtered) {
    // `--only` skips scenarios on purpose, so "scenarios that stopped being
    // measured" is the filter working, not a regression. Reporting that as a
    // failure would teach a developer the gate is unreliable, which is a faster
    // way to lose it than a false negative.
    //
    // A query regression is a different matter: statement counts are exact and
    // machine-independent, so a path that sends one more statement is wrong in a
    // partial run exactly as much as in a full one. That one still fails.
    console.log("\n  partial run (--only): timing verdicts are not a gate result");
    if (verdict.queryRegressions.length) {
      console.log("  QUERY REGRESSIONS — exact, so these count even in a partial run:");
      verdict.queryRegressions.forEach((l) => console.log(l));
      process.exitCode = 1;
    }
    return;
  }

  if (verdict.failed) {
    process.exitCode = 1;
    console.log("\n  FAILED \u2014 regression against docs/performance/hot-paths.baseline.json");
  } else {
    console.log("\n  OK \u2014 no regression against the recorded baseline");
  }
}

async function run(): Promise<void> {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await main();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
