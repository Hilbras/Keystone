import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { register } from "prom-client";

const run = promisify(execFile);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "opmetrics-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.LOGIN_MAX_ATTEMPTS ||= "1000";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPERATIONAL_PROBE = path.resolve(__dirname, "../helpers/operationalProbe.js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { hashPassword } = await import("../../services/secrets/index.js");
const { users, refreshTokens } = await import("../../db/schema.js");
const { migrationsFolder } = await import("../../lib/paths.js");
const { redis } = await import("../../services/redis.js");

/**
 * The metrics an operator needs at 3am.
 *
 * §5.1 asked for series that a dashboard can alert on, with the gate "each series
 * has a test asserting it increments, so a rename cannot silently break a
 * dashboard or an alert".
 *
 * The gate is enforced in the general form too, inherited from §4.4: **every
 * registered Keystone series must have a call site in `src/`**. A behavioural
 * "every series moved after this traffic" check would be about which subsystems a
 * test happens to exercise — `keystone_cache_hits_total` is perfectly alive and no
 * amount of logging in and out of the server touches it. What rots is the pairing
 * between a registered name and the code that writes to it, and that is a property
 * of the source.
 *
 * The specific one here is the fallback.
 *
 * **The emergency local limiter engaged with no signal at all.** Both the global
 * limiter and the per-endpoint limiters run on Redis so the budget is shared
 * across the fleet; when Redis is unavailable they fall back — the global one to
 * *failing open*, and the ones with `emergencyLocalLimit: true` to a per-process
 * budget. Before this suite, the `catch` returned a decision with no counter, no
 * log line and no event.
 *
 * A counter of refusals would not have caught it. Under per-process limits the
 * refusal rate looks normal, because each instance is still enforcing a budget.
 * What is anomalous is the *fallback engaging*, and that was the thing with no
 * counter. So the test drives real traffic against a **server whose Redis is
 * unreachable** and asserts the series moved — in a separate process, for the same
 * reason as the readiness suite: a cache-busting import does not reach the
 * dependencies, so an in-process "broken" server gets the healthy pool.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "OpMetrics-Passw0rd!";
const createdUserIds: string[] = [];
let scratch: string;
let app: FastifyInstance;

const SERIES = [
  "keystone_authentication_attempts_total",
  "keystone_token_operations_total",
  "keystone_deliveries_total",
  "keystone_delivery_duration_seconds",
  "keystone_rate_limit_redis_errors_total",
  "keystone_emergency_local_limiter_total",
] as const;

/** Every sample in the registry, keyed by series name, labels folded in. */
async function scrape(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const line of (await register.metrics()).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9.e+-]+)/.exec(line);
    if (!match) continue;
    const [, name, , value] = match;
    // A histogram publishes `_sum`, `_count` and one `_bucket` per bucket; only
    // those are folded onto the base name. A **counter's sample is the value**,
    // and appending `_count` to one lands it under a key nobody looks up.
    //
    // The first version of this had the ternary the other way round, so every
    // counter read as `<name>_count` and three tests failed against a counter that
    // was moving correctly — the §4.4 suite has the right form and this one was
    // mis-transcribed from it.
    const series = name.endsWith("_sum") || name.endsWith("_bucket") ? `${name}_count` : name;
    totals.set(series, (totals.get(series) ?? 0) + Number(value));
  }
  return totals;
}

function seriesTotal(totals: Map<string, number>, name: string): number {
  return totals.get(name) ?? 0;
}

/**
 * The labelled sample lines for one series, so a test can assert on a label set.
 *
 * **Async, because `register.metrics()` returns a promise** in prom-client 15. The
 * first version was synchronous and called `.split` on the promise, so every
 * assertion that used it failed with `register.metrics.split is not a function` —
 * which reads like the metric was missing rather than like the test forgot an
 * `await`, and cost three test runs to find.
 */
async function samplesFor(name: string): Promise<string[]> {
  const text = await register.metrics();
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `));
}

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "keystone-opmetrics-"));
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
  if (redis.status !== "ready") await redis.ping();
});

after(async () => {
  await app?.close();
  for (const id of createdUserIds) {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, id)).catch(() => {});
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

async function makeUser(label: string) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${RUN_ID}@example.test`,
      username: `${label}${RUN_ID}`.slice(0, 32),
      name: label,
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

describe("operational metrics", () => {
  it("registers every series §5.1 names, and they are all on /metrics", async () => {
    const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
    for (const name of SERIES) {
      assert.ok(body.includes(name), `/metrics does not mention ${name}`);
    }
  });

  it("has a call site in src/ for every registered series", async () => {
    // The rename gate. A series that is registered and never incremented exports
    // as a series of zeros, which on a dashboard is indistinguishable from a series
    // that should read zero — which is how
    // `keystone_failed_logins_total` spent its life until 3.4.0.
    const { readdir, readFile: read } = await import("node:fs/promises");
    const sources: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts")) sources.push(await read(full, "utf8"));
      }
    };
    await walk(path.resolve(__dirname, "../../.."));

    const registered = new Set<string>();
    for (const line of (await register.metrics()).split("\n")) {
      if (line.startsWith("# TYPE ")) {
        const name = line.split(/\s+/)[2];
        if (name?.startsWith("keystone_")) registered.add(name);
      }
    }

    const unwired = [...registered].filter(
      (name) => !sources.some((text) => text.includes(`"${name}"`) && /\.(inc|observe|set|reset)\s*\(/.test(text))
    );
    assert.deepEqual(
      unwired,
      [],
      `these series are registered but nothing in src/ ever writes to them: ${unwired.join(", ")}`
    );
  });

  it("counts a successful authentication as success, not as a failure", async () => {
    const user = await makeUser("opmetrics-ok");
    const before = await scrape();

    const res = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: PASSWORD },
    });
    assert.equal(res.statusCode, 200, res.body);

    const after = await scrape();
    assert.ok(
      seriesTotal(after, "keystone_authentication_attempts_total") >
        seriesTotal(before, "keystone_authentication_attempts_total"),
      "a successful login must move the authentication counter"
    );
    assert.ok(
      (await samplesFor("keystone_authentication_attempts_total")).some((line) =>
        /outcome="success"/.test(line)
      ),
      `the success outcome should be its own label: ${(
        await samplesFor("keystone_authentication_attempts_total")
      ).join(" | ")}`
    );
  });

  it("separates a wrong password from a rate limit, because they want different responses", async () => {
    const user = await makeUser("opmetrics-wrong");

    await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: "wrong-on-purpose" },
    });

    const lines = (await samplesFor("keystone_authentication_attempts_total")).join("\n");
    assert.match(
      lines,
      /invalid_credentials/,
      `a wrong password should be attributable as such: ${lines}`
    );
  });

  it("counts token issuance", async () => {
    const user = await makeUser("opmetrics-issue");
    const before = seriesTotal(await scrape(), "keystone_token_operations_total");

    const res = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: { email: user.email, password: PASSWORD },
    });
    assert.equal(res.statusCode, 200, res.body);

    const after = seriesTotal(await scrape(), "keystone_token_operations_total");
    assert.ok(after > before, "issuing a token must move the token counter");
    assert.match(
      (await samplesFor("keystone_token_operations_total")).join("\n"),
      /operation="issue"/,
      "and the operation should be labelled"
    );
  });
});

/**
 * The emergency fallback, against a server whose Redis is unreachable.
 *
 * This is the case the roadmap calls "the single most important operational signal
 * in the system", and it was silent: the `catch` in `checkLimit` returned a
 * decision with no counter, no log line and no event. A deployment could be
 * running on per-process budgets — every instance limiting independently, which is
 * the exact weakness the distributed limiter exists to remove — and nothing said
 * so.
 *
 * A counter of refusals would not have caught it. Under per-process limits the
 * refusal rate looks normal, because each instance is still enforcing a budget.
 * What is anomalous is the *fallback engaging*.
 *
 * The global limiter has no `emergencyLocalLimit`, so on a Redis outage it **fails
 * open** — every request allowed. That is the more serious of the two events and it
 * gets its own series, because a counter that only moves when a fallback happens to
 * be enabled would not move at all.
 */
describe("the emergency fallback, with Redis unreachable", () => {
  let report: {
    redisUrl?: string;
    probedStatus?: number;
    bootError?: string;
    metricsAfter?: string;
  };

  before(async () => {
    const out = path.join(scratch, `fallback-${RUN_ID}.json`);
    await run(process.execPath, [OPERATIONAL_PROBE, out], {
      env: {
        ...process.env,
        // Database healthy, Redis on a port nothing listens on.
        PROBE_DATABASE_URL: process.env.DATABASE_URL!,
        PROBE_REDIS_URL: "redis://127.0.0.1:59994",
        KEYSTONE_LOG_LEVEL: "error",
      },
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    report = JSON.parse(await readFile(out, "utf8"));
  });

  it("boots, so what follows is the fallback and not a crash", () => {
    assert.equal(report.bootError, undefined, `boot failed: ${report.bootError}`);
  });

  it("counts every limiter that could not reach Redis", () => {
    const lines = (report.metricsAfter ?? "")
      .split("\n")
      .filter((line) => line.startsWith("keystone_rate_limit_redis_errors_total{"));
    assert.ok(
      lines.length > 0,
      "a Redis outage must move keystone_rate_limit_redis_errors_total. Before this " +
        "series existed the fallback engaged with no signal at all."
    );
    const total = lines.reduce((sum, line) => sum + Number(line.trim().split(/\s+/).pop()), 0);
    assert.ok(total > 0, `the counter should have a non-zero sample: ${lines.join(" | ")}`);
  });

  it("names the global limiter, which fails open rather than degrading", () => {
    // The more serious event of the two: no `emergencyLocalLimit`, so a Redis
    // outage means the global rate limit stops applying at all. An operator who
    // sees only the emergency series would think protection was merely degraded.
    assert.match(
      report.metricsAfter ?? "",
      /keystone_rate_limit_redis_errors_total\{key_prefix="global"\} [1-9]/,
      "the global limiter's Redis failure should be its own labelled sample"
    );
  });

  it("counts the per-process fallback engaging, by limiter and outcome", () => {
    const lines = (report.metricsAfter ?? "")
      .split("\n")
      .filter((line) => line.startsWith("keystone_emergency_local_limiter_total{"));
    assert.ok(
      lines.length > 0,
      "the endpoints with emergencyLocalLimit must report that the fallback engaged"
    );
    for (const line of lines) {
      assert.match(line, /outcome="(allowed|denied)"/, `the outcome should be labelled: ${line}`);
      assert.match(line, / [1-9]\d*$/, `and the sample should be non-zero: ${line}`);
    }
  });

  it("counts the authentication failure with its reason", () => {
    // The probe's request is a wrong password, so this is a *failure* with a
    // reason an operator can act on — not one undifferentiated failure count.
    assert.match(
      report.metricsAfter ?? "",
      /keystone_authentication_attempts_total\{outcome="failure",reason="invalid_credentials"\}/,
      "a wrong password should be attributable as such"
    );
  });

  it("does not count a token as issued when the login failed", () => {
    // The negative case, and the one a naive `finally` would get wrong. A counter
    // answering "how many tokens exist" must not move for a login that minted
    // nothing, or the number stops being a thing you can reason about.
    const lines = (report.metricsAfter ?? "")
      .split("\n")
      .filter((line) => line.startsWith("keystone_token_operations_total{operation="));
    const issued = lines.filter((line) => /operation="issue"/.test(line));
    assert.equal(
      issued.length,
      0,
      `no token should have been issued: ${issued.join(" | ")}`
    );
  });
});
