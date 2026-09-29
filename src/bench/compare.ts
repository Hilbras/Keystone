/**
 * Deciding whether a benchmark run is a regression.
 *
 * Separated from the runner so the decision can be tested. The comparison is the
 * part of a benchmark that is trusted to be right — it is what makes a nightly
 * job meaningful, and it is the part that nobody reads during a release. If it is
 * wrong, and wrong silently, the numbers in the baseline stop meaning anything
 * and every future release inherits a gate that agrees with everything.
 *
 * The two rules, and why they differ:
 *
 *   Query count is exact and machine-independent, so any increase fails. There is
 *   no tolerance to argue about: a path that sent 5 statements and sends 6 has
 *   become an N+1, whatever the wall clock says.
 *
 *   Timing is compared against a control-relative baseline with a wide tolerance.
 *   It is noisy by nature — a shared runner is a different machine every night —
 *   and a gate that fails on noise is a gate that gets switched off.
 */

/**
 * The smallest absolute slowdown that can fail the gate.
 *
 * A ratio comparison needs the measurement to be more precise than the effect.
 * At 40% tolerance, a scenario whose baseline is 17ms can only move 7ms before
 * it fails — and this machine moved that endpoint 15ms between two consecutive
 * runs, which is a difference of nothing at all. The gate failed on noise, which
 * is the one outcome a nightly gate cannot survive: a red mark nobody believes is
 * a red mark everybody ignores.
 *
 * So a timing regression has to clear both bars. A real one does, comfortably —
 * the 1,000-member reconcile going from 15s to 25s clears a 50ms floor by three
 * orders of magnitude, and so does an authorization check going from 17ms to
 * 200ms. Noise does not.
 *
 * 50ms is the number where "the runner was busy" stops being a credible
 * explanation. Below it, a shared runner cannot distinguish a regression from a
 * scheduling hiccup, and the honest answer is to record the query count and stop
 * pretending the clock is informative.
 */
export const MIN_TIMING_DELTA_MS = 50;

export interface ScenarioReading {
  /** Median of the samples, in milliseconds. */
  ms: number;
  /** Fastest sample. Recorded so a large spread stays visible. */
  fastest: number;
  /**
   * SQL statements sent, median across the samples. The steady-state cost, and the
   * number an N+1 regression moves.
   */
  queries: number;
  /**
   * The most any single sample sent.
   *
   * Recorded rather than gated on. A cold cache makes the first request of a run
   * cost more than the rest — with the permission cache in place, `/v1/authz/check`
   * sends 7 statements cold and 5 warm — and gating on the maximum would report
   * that as though every request paid it. A regression that affects every sample
   * moves both numbers, so nothing is lost by comparing the median.
   */
  queriesMax: number;
  /** Wall-clock divided by the control measured just before this scenario. */
  relative: number;
  /** The control this scenario was divided by, so a reading can be re-derived. */
  controlMs: number;
  samples: number[];
}

export interface BenchRun {
  recordedAt: string;
  node: string;
  control: { medianMs: number; minMs: number };
  tolerance: number;
  scenarios: Record<string, ScenarioReading>;
}

export interface Verdict {
  failed: boolean;
  queryRegressions: string[];
  timingRegressions: string[];
  /** Below the noise floor. Reported, because silence here is how a gate rots. */
  withinNoise: string[];
  unmeasured: string[];
  faster: string[];
  missing: string[];
}

export function compare(baseline: BenchRun, current: BenchRun): Verdict {
  const queryRegressions: string[] = [];
  const timingRegressions: string[] = [];
  const withinNoise: string[] = [];
  const faster: string[] = [];
  const unmeasured: string[] = [];
  const missing: string[] = [];

  for (const [name, now] of Object.entries(current.scenarios)) {
    const before = baseline.scenarios[name];
    if (!before) {
      unmeasured.push(name);
      continue;
    }

    if (now.queries > before.queries) {
      queryRegressions.push(
        `  ${name}: ${before.queries} -> ${now.queries} statements`
      );
    }

    const limit = before.relative * (1 + baseline.tolerance);
    if (now.relative > limit) {
      const delta = now.ms - before.ms;
      if (delta >= MIN_TIMING_DELTA_MS) {
        timingRegressions.push(
          `  ${name}: ${before.relative} -> ${now.relative} relative, ` +
            `${before.ms}ms -> ${now.ms}ms (limit ${limit.toFixed(4)})`
        );
      } else {
        withinNoise.push(
          `  ${name}: ${before.relative} -> ${now.relative} relative but only ` +
            `+${delta.toFixed(1)}ms, under the ${MIN_TIMING_DELTA_MS}ms floor`
        );
      }
    } else if (now.relative < before.relative * 0.8) {
      faster.push(`  ${name}: ${before.relative} -> ${now.relative} relative`);
    }
  }

  // The other direction: a scenario the baseline has and this run does not. That
  // happens when someone renames a scenario or an early return skips one, and it
  // is how a scenario quietly stops being measured at all.
  for (const name of Object.keys(baseline.scenarios)) {
    if (!current.scenarios[name]) missing.push(name);
  }

  return {
    failed: queryRegressions.length > 0 || timingRegressions.length > 0 || missing.length > 0,
    queryRegressions,
    timingRegressions,
    withinNoise,
    unmeasured,
    faster,
    missing,
  };
}
