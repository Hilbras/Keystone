import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { register } from "prom-client";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "metrics-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.LOGIN_MAX_ATTEMPTS ||= "1000";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { migrationsFolder } = await import("../../lib/paths.js");
const { InProcessQueue } = await import("../../services/queue/inProcess.js");
const { redis } = await import("../../services/redis.js");

/**
 * The §5.2 metric families, each asserted to move on a real request.
 *
 * §5.1 settled the principle that a registered series must have a call site in
 * `src/`; that pairing is checked structurally by the §4.4 suite. What that check
 * cannot see is whether the call site is *reached* — a counter can be wired to the
 * right name and still sit behind a branch that never runs, and the only thing that
 * catches that is traffic.
 *
 * So every family here is driven, not imported:
 *
 * - `keystone_db_statements_total` moves because a request runs a query.
 * - `keystone_queue_jobs_total` moves because a job runs to completion and because
 *   one fails its last attempt — the two outcomes an operator actually alerts on.
 * - `keystone_oauth_failures_total` moves because the token endpoint refused a
 *   client, and moves under the RFC error code the client received rather than an
 *   HTTP status.
 * - `keystone_rate_limit_blocks_total` moves because a client was refused, and
 *   records which limiter refused it.
 * - `keystone_dependency_latency_seconds_count` moves because `/ready` probed both
 *   dependencies.
 *
 * The rate-limit case is driven through the real `oauth2_token` limiter with a
 * per-run subject in the body, so the key is unique to this run and a repeat within
 * the window does not inherit a spent budget. That is the failure mode the older
 * suites hit: a shared key meant the second run of a test started already limited
 * and answered 429 where it expected 400.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
let app: FastifyInstance;

/** Every sample in the registry, keyed by series name, labels folded in. */
async function scrape(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const line of (await register.metrics()).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9.e+-]+)/.exec(line);
    if (!match) continue;
    const [, name, , value] = match;
    // A histogram publishes `_sum`, `_bucket` and `_count`; the first two are folded
    // onto themselves here and only `_count` is read back, because a handler count
    // is the question ("did the job run") and the sum is not.
    totals.set(name, (totals.get(name) ?? 0) + Number(value));
  }
  return totals;
}

function total(totals: Map<string, number>, name: string): number {
  return totals.get(name) ?? 0;
}

async function samplesFor(name: string): Promise<string[]> {
  const text = await register.metrics();
  return text.split("\n").filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
  if (redis.status !== "ready") await redis.ping();
});

after(async () => {
  await app?.close();
  await closeDb().catch(() => {});
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("§5.2 operational metrics", () => {
  it("exposes every new family on /metrics", async () => {
    const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
    for (const name of [
      "keystone_db_statements_total",
      "keystone_queue_jobs_total",
      "keystone_queue_job_duration_seconds",
      "keystone_oauth_failures_total",
      "keystone_rate_limit_blocks_total",
      "keystone_dependency_latency_seconds",
    ]) {
      assert.ok(body.includes(name), `/metrics does not mention ${name}`);
    }
  });

  it("counts a PostgreSQL statement on a request that runs one", async () => {
    const before = total(await scrape(), "keystone_db_statements_total");
    const response = await app.inject({
      method: "POST",
      url: "/oauth2/token",
      payload: {
        grant_type: "authorization_code",
        code: "x",
        client_id: `nope-${RUN_ID}`,
        redirect_uri: "https://app.test/cb",
        email: `${RUN_ID}-db`,
      },
    });
    assert.equal(response.statusCode, 400, "an unknown client must be refused");
    const after = total(await scrape(), "keystone_db_statements_total");
    assert.ok(
      after > before,
      "a request that looks a client up must run at least one statement; the counter did not move"
    );
  });

  it("counts an OAuth refusal under the RFC error code the client received", async () => {
    const before = total(await scrape(), "keystone_oauth_failures_total");
    // A refresh grant that names no token is RFC 6749 §5.2 `invalid_request`. The
    // assertion is on that code rather than on the 400, because the whole point of
    // the label is that a dashboard can separate a malformed request from a
    // rejected credential — both are 400s and only the code tells them apart.
    const response = await app.inject({
      method: "POST",
      url: "/oauth2/token",
      payload: { grant_type: "refresh_token", client_id: `nope-${RUN_ID}`, email: `${RUN_ID}-refusal` },
    });
    assert.equal(response.statusCode, 400);
    const after = total(await scrape(), "keystone_oauth_failures_total");
    assert.ok(after > before, "the refusal counter did not move");

    const lines = await samplesFor("keystone_oauth_failures_total");
    assert.ok(
      lines.some(
        (line) =>
          line.includes('grant_type="refresh_token"') && line.includes('error="invalid_request"')
      ),
      `no refusal recorded for refresh_token/invalid_request: ${lines.join(" | ")}`
    );
  });

  it("does not file a rate-limit block as an OAuth protocol error", async () => {
    const before = total(await scrape(), "keystone_oauth_failures_total");
    // A per-run subject keeps this key distinct from every other test's, so the
    // 429 below is caused by these 21 requests and not by a budget spent earlier.
    const payload = { grant_type: "refresh_token", refresh_token: "x", email: RUN_ID };
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const response = await app.inject({ method: "POST", url: "/oauth2/token", payload });
      if (response.statusCode === 429) {
        limited = true;
        break;
      }
    }
    assert.ok(limited, "25 requests against a 20-per-minute limiter must eventually be refused");

    // 20 of the 25 were protocol refusals and 5 were blocks; only the protocol
    // refusals belong in the OAuth counter, and none of them may carry the limiter's
    // prose sentence as an error code.
    const lines = await samplesFor("keystone_oauth_failures_total");
    const after = lines.reduce((sum, line) => sum + Number(line.split(" ").pop()), 0);
    assert.ok(after > before, "the protocol refusals should still be counted");
    assert.ok(
      !lines.some((line) => line.includes("Too many attempts")),
      "the limiter's message was filed as an OAuth error code"
    );
  });

  it("counts the rate-limit block and names the limiter that refused", async () => {
    const before = total(await scrape(), "keystone_rate_limit_blocks_total");
    const payload = { grant_type: "refresh_token", refresh_token: "x", email: `${RUN_ID}-blocks` };
    for (let i = 0; i < 25; i++) {
      const response = await app.inject({ method: "POST", url: "/oauth2/token", payload });
      if (response.statusCode === 429) break;
    }
    const after = total(await scrape(), "keystone_rate_limit_blocks_total");
    assert.ok(after > before, "a refused client must be counted");

    const lines = await samplesFor("keystone_rate_limit_blocks_total");
    assert.ok(
      lines.some((line) => line.includes('key_prefix="oauth2_token"') && line.includes('limiter="redis"')),
      `no block recorded for the distributed limiter: ${lines.join(" | ")}`
    );
  });

  it("counts and times a completed queue job", async () => {
    const queue = new InProcessQueue();
    let seen = false;
    queue.process("metrics_ok", () => {
      seen = true;
    });

    const before = await scrape();
    await queue.enqueue({ type: "metrics_ok", payload: {} });
    assert.ok(await waitFor(() => seen), "the job never ran");

    const after = await scrape();
    assert.ok(
      total(after, "keystone_queue_jobs_total") > total(before, "keystone_queue_jobs_total"),
      "a completed job must be counted"
    );
    assert.ok(
      total(after, "keystone_queue_job_duration_seconds_count") >
        total(before, "keystone_queue_job_duration_seconds_count"),
      "a completed job must be timed"
    );

    const lines = await samplesFor("keystone_queue_jobs_total");
    assert.ok(
      lines.some((line) => line.includes('provider="in-process"') && line.includes('outcome="completed"')),
      `no completed job recorded for the in-process driver: ${lines.join(" | ")}`
    );
    await queue.close();
  });

  it("counts a job whose last attempt failed, distinctly from one that was retried", async () => {
    const queue = new InProcessQueue();
    let attempts = 0;
    queue.process("metrics_dead", () => {
      attempts++;
      throw new Error("always fails");
    });

    await queue.enqueue({ type: "metrics_dead", payload: {}, attempts: 2 });
    // attempts=2 means one retry then a final failure; the second attempt is the one
    // that exhausts the budget and is the only one recorded as `failed`.
    assert.ok(await waitFor(() => attempts >= 2), "the job never reached its last attempt");

    const lines = await samplesFor("keystone_queue_jobs_total");
    assert.ok(
      lines.some((line) => line.includes('type="metrics_dead"') && line.includes('outcome="retried"')),
      `the retry was not counted: ${lines.join(" | ")}`
    );
    assert.ok(
      lines.some((line) => line.includes('type="metrics_dead"') && line.includes('outcome="failed"')),
      `the final failure was not counted: ${lines.join(" | ")}`
    );
    await queue.close();
  });

  it("times both dependencies when the readiness probe runs", async () => {
    const before = total(await scrape(), "keystone_dependency_latency_seconds_count");
    const response = await app.inject({ method: "GET", url: "/ready" });
    assert.ok(response.statusCode < 500, "readiness must answer rather than error");

    const after = total(await scrape(), "keystone_dependency_latency_seconds_count");
    assert.ok(
      after >= before + 2,
      `a readiness probe must time both dependencies; count went ${before} -> ${after}`
    );
    const lines = await samplesFor("keystone_dependency_latency_seconds_count");
    assert.ok(lines.some((line) => line.includes('dependency="postgres"')));
    assert.ok(lines.some((line) => line.includes('dependency="redis"')));
  });
});
