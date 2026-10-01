import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");

/**
 * SEC-081 — every retry of every delivery used one fixed 30-second delay.
 *
 * N deliveries that failed together therefore came back at exactly t+30s, t+60s,
 * t+90s. During a consumer outage that is the worst shape available: the service
 * is already struggling, and every delivery held for it returns in one
 * synchronised wave, is refused again in one wave, and the cycle repeats five
 * times.
 *
 * ## Why this suite asserts a distribution, not a value
 *
 * A fixed delay satisfies any single-sample assertion — `retryDelayMs(1) === 30_000`
 * passes against the defect, and so does `retryDelayMs(1) > 0`. The defect *is* the
 * absence of variation, so the only assertions that can catch it are ones about
 * how several samples relate to each other. Every case below therefore takes many
 * samples and compares them.
 */
describe("webhook retry backoff is exponential and jittered (SEC-081)", () => {
  let retryDelayMs: typeof import("../../../services/webhooks.js").retryDelayMs;

  before(async () => {
    ({ retryDelayMs } = await import("../../../services/webhooks.js"));
  });

  const samples = (attempts: number, n = 400): number[] =>
    Array.from({ length: n }, () => retryDelayMs(attempts));

  it("varies between calls at the same attempt number", () => {
    // The core assertion. A constant delay produces one distinct value here, so
    // this fails against the defect rather than merely looking plausible.
    const distinct = new Set(samples(1));
    assert.ok(
      distinct.size > 100,
      `retries at the same attempt must be spread, got ${distinct.size} distinct value(s)`
    );
  });

  it("spreads a fleet of simultaneous failures across time", () => {
    // What an outage actually looks like: many deliveries, one attempt number.
    // Measured as the fraction of samples falling in the same 1-second bucket —
    // a fixed delay puts 100% of them in one bucket.
    const values = samples(1, 2000);
    const buckets = new Set(values.map((v) => Math.floor(v / 1000)));
    assert.ok(
      buckets.size > 10,
      `a simultaneous fleet must not arrive in a handful of buckets, got ${buckets.size}`
    );
  });

  it("grows with the attempt number", () => {
    // Median, because a jittered distribution has no maximum worth comparing.
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const first = median(samples(1, 400));
    const second = median(samples(2, 400));
    const third = median(samples(3, 400));
    assert.ok(second > first, `attempt 2 must wait longer than attempt 1 (${second} vs ${first})`);
    assert.ok(third > second, `attempt 3 must wait longer than attempt 2 (${third} vs ${second})`);
  });

  it("doubles the ceiling on each attempt", () => {
    // Sampled at random() = 1, which is the top of the jitter range and therefore
    // the per-attempt ceiling.
    const ceiling = (attempts: number) => retryDelayMs(attempts, () => 1);
    assert.equal(ceiling(1), 30_000);
    assert.equal(ceiling(2), 60_000);
    assert.equal(ceiling(3), 120_000);
    assert.equal(ceiling(4), 240_000);
  });

  it("is capped, so a late retry cannot outlive the window that matters", () => {
    // Unbounded, attempt 12 would wait over eight hours. The cap is what keeps a
    // delivery refused for a transient blip from being abandoned.
    assert.equal(retryDelayMs(20, () => 1), 15 * 60_000, "the ceiling must be 15 minutes");
    assert.equal(retryDelayMs(100, () => 1), 15 * 60_000);
  });

  it("never returns a negative or NaN delay, whatever it is handed", () => {
    for (const attempts of [-5, 0, 1, 2, 7, 50]) {
      for (const v of samples(attempts, 20)) {
        assert.ok(Number.isFinite(v) && v >= 0, `attempt ${attempts} produced ${v}`);
      }
    }
  });

  it("stays inside [0, ceiling) for every attempt", () => {
    for (const attempts of [1, 2, 3, 4, 5, 10, 50]) {
      const ceiling = retryDelayMs(attempts, () => 1);
      for (const v of samples(attempts, 100)) {
        assert.ok(v >= 0 && v <= ceiling, `attempt ${attempts}: ${v} outside [0, ${ceiling}]`);
      }
    }
  });

  it("the call sites pass the attempt count through", () => {
    // Structural. A correct `retryDelayMs` that every call site ignores — passing a
    // constant — would satisfy every case above while reproducing the defect, so
    // the wiring is asserted rather than inferred.
    const service = readFileSync(
      path.resolve(projectRoot, "dist", "services", "webhooks.js"),
      "utf8"
    );
    const code = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // `await retryLater(` — the definition is `async function retryLater(`, so
    // anchoring on the call is what separates the two. The first version matched
    // the definition too, counted three, and failed against correct code.
    const calls = [...code.matchAll(/await retryLater\(deliveryId, (\w+)\)/g)].map((m) => m[1]);
    assert.equal(
      calls.length,
      2,
      "both retry sites must pass the attempt count through"
    );
    for (const arg of calls) {
      assert.equal(
        arg,
        "attempts",
        "the argument must be the live attempt count, not a constant"
      );
    }
    // And the old constant must be gone: a leftover fixed delay in the file is how
    // this defect returns.
    assert.doesNotMatch(code, /RETRY_DELAY_MS/, "the fixed delay must not survive");
  });
});
