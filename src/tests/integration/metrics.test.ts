import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { register } from "prom-client";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "metrics-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// The metrics suite drives the login endpoint repeatedly; the production budget
// is per address and the limiter is under test elsewhere. Raised for this process
// only, and the value is set rather than the limiter disabled, so the limiter is
// still running while the test runs.
process.env.LOGIN_MAX_ATTEMPTS ||= "1000";

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
 * The queue and the metrics.
 *
 * §4.4's finding was that one test file referenced the queue and none referenced
 * metrics. The metrics half matters more than it looks, and the specific claim in
 * the roadmap is the one worth keeping: *"every registered series increments on a
 * real request, so a renamed label is caught rather than silently changing a
 * dashboard."*
 *
 * That is a claim about **liveness**, not about names. A counter that is
 * registered and never incremented exports as a series with value 0 — which on a
 * dashboard is indistinguishable from "this never happens". For
 * `keystone_failed_logins_total` that is the one reading a failed-login alert must
 * never be able to take, and it was exactly the state the metric was in: the
 * series existed, `/metrics` served it, and nothing anywhere incremented it.
 *
 * So the suite below does not assert that a metric's name is spelled a particular
 * way. It asserts that every series in the registry moves when the thing it
 * measures happens. A renamed label fails; a dead counter fails; a series whose
 * backing event stopped being emitted fails.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Metrics-Passw0rd!";
const createdUserIds: string[] = [];
let app: FastifyInstance;

async function makeUser(label: string) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${RUN_ID}@example.test`,
      username: `${label}${RUN_ID}`.slice(0, 32),
      name: label,
      passwordHash: await hashPassword(PASSWORD),
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

/** Every sample currently in the registry, keyed by series name. */
async function scrape(): Promise<Map<string, number>> {
  const text = await register.metrics();
  const totals = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9.e+-]+)/.exec(line);
    if (!match) continue;
    const [, name, , value] = match;
    const total = Number(value);
    // A histogram reports `_sum`, `_count` and one `_bucket` per bucket; the
    // series under test is the `_count`, and the total is what "did it move"
    // means for all of them.
    const series = name.endsWith("_sum") || name.endsWith("_bucket") ? `${name}_count` : name;
    totals.set(series, (totals.get(series) ?? 0) + total);
  }
  return totals;
}

/** Every `.ts` file under `dir`, for the static wiring check. */
async function readAllSources(dir: string): Promise<string[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await readAllSources(full)));
    else if (entry.name.endsWith(".ts")) out.push(await readFile(full, "utf8"));
  }
  return out;
}


/**
 * The Keystone-owned series, read off a scrape rather than off the registry.
 *
 * prom-client 15 has no API for listing metric names, and reading them from the
 * scrape is the more honest source anyway: it is exactly what a Prometheus server
 * would see, so a series that is registered but not exported shows up as absent
 * here rather than as present-and-lying.
 */
async function keystoneSeries(): Promise<string[]> {
  const names = new Set<string>();
  for (const line of (await register.metrics()).split("\n")) {
    if (line.startsWith("# TYPE ")) {
      const name = line.split(/\s+/)[2];
      if (name?.startsWith("keystone_")) names.add(name);
    }
  }
  return [...names].sort();
}

/** `keystone_http_request_duration_seconds` as it appears in `# TYPE`. */
const DURATION_SERIES = "keystone_http_request_duration_seconds";

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

describe("metrics", () => {
  it("registers at least the series the server is expected to expose", async () => {
    const series = await keystoneSeries();
    assert.ok(series.length >= 3, `expected several Keystone series, found ${series.length}`);
    // Asserted as a set rather than as a count, so a rename is a visible diff in
    // the failure message instead of a number quietly changing.
    for (const expected of [
      "keystone_http_requests_total",
      DURATION_SERIES,
      "keystone_failed_logins_total",
    ]) {
      assert.ok(series.includes(expected), `missing series ${expected}; found ${series.join(", ")}`);
    }
  });

  it("serves them from /metrics in the Prometheus text format", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /text\/plain/);
    for (const name of await keystoneSeries()) {
      assert.ok(res.body.includes(name), `/metrics does not mention ${name}`);
    }
  });

  it("labels an unmatched request with one constant series, not the raw URL", async () => {
    // The cardinality bomb. A scanner probing random paths makes one new time
    // series per request, and `keystone_http_requests_total` grows without bound
    // until Prometheus falls over. Two probes, two series, before the fix.
    await app.inject({ method: "GET", url: "/no-such-path/aaaaaaaa-1111" });
    await app.inject({ method: "GET", url: "/no-such-path/bbbbbbbb-2222" });

    const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
    const routes = new Set(
      body
        .split("\n")
        .filter((l) => l.startsWith("keystone_http_requests_total{"))
        .map((l) => /route="([^"]*)"/.exec(l)?.[1])
        .filter(Boolean) as string[]
    );

    assert.ok(
      !routes.has("/no-such-path/aaaaaaaa-1111") && !routes.has("/no-such-path/bbbbbbbb-2222"),
      `a concrete 404 path became a time series: ${[...routes].join(", ")}`
    );
    assert.ok(
      routes.has("unmatched"),
      `unmatched requests should share one series labelled "unmatched"; saw ${[...routes].join(", ")}`
    );
  });

  it("counts an HTTP request under the route template, not the concrete URL", async () => {
    const before = await scrape();
    const beforeTotal = before.get("keystone_http_requests_total") ?? 0;

    const user = await makeUser("metrics-route");
    // A path with an identifier in it. Labelled by the raw URL, every request to
    // the same route would be a distinct time series and the counter would be
    // useless — a cardinally exploding label is how a metrics endpoint takes a
    // Prometheus server down.
    await app.inject({ method: "GET", url: `/auth/users/${user.id}/something` });

    const after = await scrape();
    const afterTotal = after.get("keystone_http_requests_total") ?? 0;
    assert.ok(afterTotal > beforeTotal, "the request counter did not move");

    const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
    assert.ok(
      !body.includes(`/auth/users/${user.id}/`),
      "a per-request URL reached the metrics output; the label must be the route template"
    );
  });

  it("records the request duration histogram alongside the counter", async () => {
    const before = await scrape();
    const beforeCount = before.get("keystone_http_request_duration_seconds_count") ?? 0;
    await app.inject({ method: "GET", url: "/health" });
    const after = await scrape();
    assert.ok(
      (after.get("keystone_http_request_duration_seconds_count") ?? 0) > beforeCount,
      "the duration histogram did not observe the request"
    );
  });

  it("increments the failed-login counter for a real failed login", async () => {
    // The one that was dead. This is the whole point of the case: a counter that
    // is registered but never incremented reads as zero, and zero is the reading
    // a failed-login alert would take at face value.
    const user = await makeUser("metrics-failed-login");

    const before = await scrape();
    const beforeTotal = before.get("keystone_failed_logins_total") ?? 0;

    const res = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: "definitely-not-the-password" },
    });
    assert.ok(res.statusCode >= 400, `a wrong password must fail; got ${res.statusCode}`);

    const after = await scrape();
    const afterTotal = after.get("keystone_failed_logins_total") ?? 0;
    assert.equal(
      afterTotal,
      beforeTotal + 1,
      `keystone_failed_logins_total should have counted one failure: ${beforeTotal} -> ${afterTotal}`
    );
  });

  it("labels the failed-login counter by reason", async () => {
    // A single "failed" series cannot tell a spray from a user who forgot their
    // password, and those two want opposite responses.
    await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: `nobody-${RUN_ID}@example.test`, password: PASSWORD },
    });

    const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
    const lines = body.split("\n").filter((l) => l.startsWith("keystone_failed_logins_total{"));
    assert.ok(lines.length > 0, "the counter exported no labelled samples");

    const reasons = lines.map((l) => /reason="([^"]+)"/.exec(l)?.[1]).filter(Boolean);
    assert.ok(reasons.length > 0, `no reason label in: ${lines.join(" | ")}`);
    assert.ok(
      new Set(reasons).size > 1,
      `expected more than one reason to be distinguishable, saw ${[...new Set(reasons)].join(", ")}`
    );
  });

  it("does not count a successful login as a failure", async () => {
    const user = await makeUser("metrics-login-success");
    const before = await scrape();
    const beforeTotal = before.get("keystone_failed_logins_total") ?? 0;

    const res = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: PASSWORD },
    });
    assert.equal(res.statusCode, 200, res.body);

    const after = await scrape();
    assert.equal(
      after.get("keystone_failed_logins_total") ?? 0,
      beforeTotal,
      "a successful sign-in must not move a failed-login counter"
    );
  });

  it("has a call site for every registered series", async () => {
    // The general form of the dead-counter case, and the one that catches the
    // *next* one — including a rename, which is what the roadmap names.
    //
    // A behavioural check ("every series moved after this traffic") is the wrong
    // shape here: `keystone_cache_hits_total` is perfectly alive and no amount of
    // logging in and out of the server touches it, so the assertion would be
    // about which subsystems a test happens to exercise. What actually rots is
    // the *pairing* between a registered name and the code that increments it,
    // and that is a static property of the source.
    //
    // So: every registered name must appear as an increment target somewhere in
    // `src/`. Rename the series and the call site stops matching; delete the call
    // site and it stops matching. Both fail here.
    const sources = await readAllSources("src");
    const registered = await keystoneSeries();
    const unwired = registered.filter(
      (name) =>
        !sources.some((text) => text.includes(`"${name}"`) && /\.(inc|observe|set|reset)\s*\(/.test(text))
    );

    assert.deepEqual(
      unwired,
      [],
      `these series are registered but nothing in src/ ever writes to them: ` +
        `${unwired.join(", ")}. A registered counter that is never incremented ` +
        `reads as zero forever, which on a dashboard is indistinguishable from ` +
        `a counter that should read zero.`
    );
  });
});

beforeEach(() => {
  // Nothing to reset: prom-client counters are process-wide, and the assertions
  // are all relative to a reading taken immediately beforehand. Stated so the
  // empty hook is not read as an oversight.
});
