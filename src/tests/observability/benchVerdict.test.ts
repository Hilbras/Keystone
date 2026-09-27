import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compare, type BenchRun, type ScenarioReading } from "../../bench/compare.js";

/**
 * The benchmark's verdict, tested.
 *
 * This is the part of the benchmark that is trusted to be right and read by
 * nobody during a release. If it is wrong, and wrong quietly, then the numbers in
 * `docs/performance/hot-paths.baseline.json` stop meaning anything and every later
 * release inherits a gate that agrees with everything.
 *
 * Each test below is also a way of breaking the gate deliberately: the interesting
 * question is not "does compare return the right verdict" but "would this gate
 * have stopped the regression it exists to stop".
 */

function reading(over: Partial<ScenarioReading> = {}): ScenarioReading {
  return {
    ms: 100,
    fastest: 95,
    queries: 5,
    relative: 1,
    controlMs: 100,
    samples: [100, 100, 100],
    ...over,
  };
}

function run(scenarios: Record<string, ScenarioReading>, tolerance = 0.4): BenchRun {
  return {
    recordedAt: "2026-09-28T00:00:00.000Z",
    node: "v24.0.0",
    control: { medianMs: 100, minMs: 90 },
    tolerance,
    scenarios,
  };
}

describe("benchmark verdict", () => {
  it("passes an identical run", () => {
    const baseline = run({ login: reading(), "group-list": reading({ queries: 10 }) });
    const current = run({ login: reading(), "group-list": reading({ queries: 10 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, false);
    assert.deepEqual(verdict.queryRegressions, []);
    assert.deepEqual(verdict.timingRegressions, []);
  });

  it("fails on a single extra SQL statement, whatever the clock says", () => {
    // The N+1 case. Five statements became six, and the request was in fact
    // *faster* — a batched query can reduce wall-clock and raise the count. Only
    // the count catches this, which is why it is a hard gate.
    const baseline = run({ "group-list": reading({ queries: 5, relative: 2 }) });
    const current = run({ "group-list": reading({ queries: 6, relative: 1 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, true);
    assert.equal(verdict.queryRegressions.length, 1);
    assert.match(verdict.queryRegressions[0], /5 -> 6 statements/);
    assert.deepEqual(verdict.timingRegressions, [], "a faster run is not a timing regression");
  });

  it("catches the N+1 coming back at 501 statements, which is the regression it exists for", () => {
    // The pre-3.1.0 shape: one member query per group per page. A page of 500.
    const baseline = run({ "group-list": reading({ queries: 5 }) });
    const current = run({ "group-list": reading({ queries: 505 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, true);
    assert.equal(verdict.queryRegressions.length, 1);
  });

  it("passes a run with fewer statements", () => {
    const baseline = run({ "group-list": reading({ queries: 505 }) });
    const current = run({ "group-list": reading({ queries: 5 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, false);
    assert.deepEqual(verdict.queryRegressions, []);
  });

  it("ignores a timing move inside the tolerance", () => {
    // 1.39 against a limit of 1.4. A shared runner drifts; the gate has to
    // survive that or it gets switched off.
    const baseline = run({ login: reading({ relative: 1, ms: 1000 }) });
    const current = run({ login: reading({ relative: 1.39, ms: 1390 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, false);
    assert.deepEqual(verdict.timingRegressions, []);
  });

  it("fails a timing move past the tolerance", () => {
    const baseline = run({ login: reading({ relative: 1, ms: 1000 }) });
    const current = run({ login: reading({ relative: 1.41, ms: 1410 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, true);
    assert.equal(verdict.timingRegressions.length, 1);
    assert.match(verdict.timingRegressions[0], /1000ms -> 1410ms/);
  });

  it("does not fail a timing move that is smaller than the noise floor", () => {
    // The case that actually happened. An endpoint whose baseline is 17ms moved
    // 15ms between two consecutive runs — 1.8x, well past a 40% ratio limit, and
    // a difference of nothing at all. A 40% tolerance on a 17ms baseline allows
    // 7ms of movement before failing, which is finer than a shared runner can
    // measure. Failing here is how a nightly job learns to be ignored.
    const baseline = run({ "authz-check": reading({ relative: 0.297, ms: 16.71 }) });
    const current = run({ "authz-check": reading({ relative: 0.47, ms: 31.45 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, false);
    assert.deepEqual(verdict.timingRegressions, []);
    assert.equal(verdict.withinNoise.length, 1, "it must still be reported, not swallowed");
  });

  it("still fails a fast endpoint that genuinely regressed", () => {
    // The floor must not disarm the gate for small scenarios. 17ms to 200ms is a
    // 2.6x slowdown on a cheap endpoint, and it clears the floor by 150ms.
    const baseline = run({ "authz-check": reading({ relative: 0.3, ms: 17 }) });
    const current = run({ "authz-check": reading({ relative: 3.5, ms: 200 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, true);
    assert.equal(verdict.timingRegressions.length, 1);
  });

  it("still fails a slow path that regressed", () => {
    const baseline = run({ reconcile: reading({ relative: 260, ms: 15437 }) });
    const current = run({ reconcile: reading({ relative: 420, ms: 25000 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, true);
    assert.equal(verdict.timingRegressions.length, 1);
  });

  it("fails a query regression no matter how small the timing change", () => {
    // The floor applies to timing only. A statement count is exact, so a path
    // that sends one more statement is wrong regardless of how long it takes.
    const baseline = run({ "group-list": reading({ queries: 5, relative: 1, ms: 50 }) });
    const current = run({ "group-list": reading({ queries: 6, relative: 1.05, ms: 52 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, true);
    assert.equal(verdict.queryRegressions.length, 1);
  });

  it("takes the tolerance from the baseline, not from the current run", () => {
    // Otherwise a run could widen its own tolerance to make itself pass. The
    // recorded baseline is the contract; the run does not get to renegotiate it.
    const baseline = run({ login: reading({ relative: 1, ms: 1000 }) }, 0.4);
    const current = run({ login: reading({ relative: 2, ms: 2000 }) }, 4);
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, true, "a run that raised its own tolerance must still fail");
  });

  it("reports an improvement without failing", () => {
    const baseline = run({ login: reading({ relative: 2, ms: 2000 }) });
    const current = run({ login: reading({ relative: 1, ms: 1000 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, false);
    assert.equal(verdict.faster.length, 1, "an improvement is worth seeing, not just surviving");
  });

  it("fails when a scenario stopped being measured", () => {
    // The silent one. A renamed scenario, or an early return that skips it, and
    // the gate reports a clean run because there was nothing left to compare.
    const baseline = run({ login: reading(), refresh: reading(), authz: reading() });
    const current = run({ login: reading(), authz: reading() });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, true);
    assert.deepEqual(verdict.missing, ["refresh"]);
  });

  it("does not fail on a scenario the baseline has never seen", () => {
    // A new scenario is not a regression. It is reported, so a baseline that
    // predates it is visible, but adding one must not turn the nightly job red.
    const baseline = run({ login: reading() });
    const current = run({ login: reading(), "brand-new": reading() });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, false);
    assert.deepEqual(verdict.unmeasured, ["brand-new"]);
  });

  it("does not let a query regression hide behind a timing improvement", () => {
    // Both halves of the verdict are computed, so a run cannot buy a query
    // regression with a good clock reading.
    const baseline = run({ "group-list": reading({ queries: 5, relative: 2 }) });
    const current = run({ "group-list": reading({ queries: 5 + 500, relative: 0.5 }) });
    const verdict = compare(baseline, current);

    assert.equal(verdict.failed, true);
    assert.equal(verdict.queryRegressions.length, 1);
    assert.deepEqual(verdict.timingRegressions, []);
    assert.equal(verdict.faster.length, 1);
  });
});
