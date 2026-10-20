import { serviceLogger } from "../lib/logger.js";
import { queue as defaultQueue } from "./queue/index.js";
import type { Queue } from "./queue/types.js";
import {
  releaseOrphanedLocks as defaultReleaseOrphanedLocks,
  scanLocks as defaultScanLocks,
} from "./lock.js";
import {
  reclaimStaleDeliveries as defaultReclaimStaleDeliveries,
  reenqueuePendingDeliveries as defaultReenqueuePendingDeliveries,
} from "./webhooks.js";

const moduleLog = serviceLogger("startup-recovery");

/**
 * §6.4. Startup recovery.
 *
 * A process that died holding work leaves three kinds of debris, and only one of
 * them was collected before this file:
 *
 * | debris | before | now |
 * |---|---|---|
 * | webhook deliveries stuck in `processing` | reclaimed on a timer from `startWebhookWorker()` | reclaimed once, at boot, and reported |
 * | webhook deliveries `pending` with no live job | invisible | re-enqueued, and reported |
 * | lock keys with no expiry | invisible | deleted, and reported |
 * | failed jobs in the queue (DLQ) | invisible unless someone opened the dashboard | counted and logged at boot |
 *
 * The delivery sweep already existed and already ran at startup — but its count was
 * only logged by the webhook service, so nothing could answer "did this instance
 * recover anything when it started?" after the fact. The report is the point: a
 * restart that recovered 4 000 deliveries is a different event from a clean one,
 * and both look identical in a log line that only fires when the count is non-zero.
 *
 * ## What this deliberately does not do
 *
 * It does not requeue failed jobs automatically. A dead-letter entry is a job that
 * exhausted its retries, and replaying it at every restart turns one poison payload
 * into an infinite restart loop. It is counted and left for an operator (or the
 * existing `retryAll` path) to act on.
 *
 * It does not release locks that still have a TTL. A lock with a TTL may belong to a
 * live instance that is merely slow, and stealing it is the double-holder race
 * `services/lock.ts` exists to prevent. Only keys with no expiry — which could never
 * be taken over — are deleted.
 */
export interface StartupRecoveryReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** `null` means the sweep could not run (for example, no database yet). */
  reclaimedDeliveries: number | null;
  /**
   * `pending` deliveries whose queue job was lost — rebuilt Redis, or an
   * in-process queue across a restart — and were put back on the queue.
   */
  reenqueuedDeliveries: number | null;
  queue: {
    provider: string;
    backlog: number | null;
    failed: number | null;
    delayed: number | null;
    error?: string;
  };
  locks: {
    scanned: number;
    withoutExpiry: number;
    released: number;
    error?: string;
  };
}

export interface StartupRecoveryDeps {
  queue?: Pick<Queue, "provider" | "getStats">;
  reclaimStaleDeliveries?: () => Promise<number>;
  reenqueuePendingDeliveries?: () => Promise<number>;
  scanLocks?: typeof defaultScanLocks;
  releaseOrphanedLocks?: typeof defaultReleaseOrphanedLocks;
}

let lastReport: StartupRecoveryReport | null = null;

/** The report from this process's boot, for `/v1/admin/platform/diagnostics`. */
export function getStartupRecoveryReport(): StartupRecoveryReport | null {
  return lastReport;
}

/** Test seam: forget the previous boot's report. */
export function resetStartupRecoveryForTests(): void {
  lastReport = null;
}

/**
 * Run every recovery pass and return what was found.
 *
 * Never throws: a recovery pass that fails must not stop the process from booting,
 * because booting degraded is how an operator gets to see the failure. Each failure
 * is recorded in the report and logged.
 */
export async function runStartupRecovery(
  deps: StartupRecoveryDeps = {}
): Promise<StartupRecoveryReport> {
  const startedAt = Date.now();
  const queue = deps.queue ?? defaultQueue;
  const reclaim = deps.reclaimStaleDeliveries ?? defaultReclaimStaleDeliveries;
  const reenqueue = deps.reenqueuePendingDeliveries ?? defaultReenqueuePendingDeliveries;
  const scan = deps.scanLocks ?? defaultScanLocks;
  const release = deps.releaseOrphanedLocks ?? defaultReleaseOrphanedLocks;

  const report: StartupRecoveryReport = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: "",
    durationMs: 0,
    reclaimedDeliveries: null,
    reenqueuedDeliveries: null,
    queue: { provider: queue.provider, backlog: null, failed: null, delayed: null },
    locks: { scanned: 0, withoutExpiry: 0, released: 0 },
  };

  try {
    report.reclaimedDeliveries = await reclaim();
  } catch (err) {
    moduleLog.error({ err }, "startup recovery: webhook delivery reclaim failed");
  }

  // Runs after the reclaim so a delivery moved back to `pending` in the same pass
  // is also put back on the queue — otherwise the sweep would create exactly the
  // stranded `pending` row this step exists to recover.
  try {
    report.reenqueuedDeliveries = await reenqueue();
  } catch (err) {
    moduleLog.error({ err }, "startup recovery: pending delivery re-enqueue failed");
  }

  try {
    const stats = await queue.getStats?.();
    if (stats) {
      report.queue.backlog = stats.reduce((sum, s) => sum + s.count, 0);
      report.queue.failed = stats.reduce((sum, s) => sum + (s.failed ?? 0), 0);
      report.queue.delayed = stats.reduce((sum, s) => sum + (s.delayed ?? 0), 0);
    }
  } catch (err) {
    report.queue.error = "queue statistics unavailable";
    moduleLog.error({ err }, "startup recovery: queue statistics failed");
  }

  try {
    const locks = await scan();
    report.locks.scanned = locks.length;
    report.locks.withoutExpiry = locks.filter((lock) => lock.ttlMs === 0).length;
    if (report.locks.withoutExpiry > 0) {
      report.locks.released = await release();
    }
  } catch (err) {
    report.locks.error = "lock scan unavailable";
    moduleLog.error({ err }, "startup recovery: lock scan failed");
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  lastReport = report;

  const recovered =
    (report.reclaimedDeliveries ?? 0) > 0 ||
    (report.reenqueuedDeliveries ?? 0) > 0 ||
    report.locks.released > 0 ||
    (report.queue.failed ?? 0) > 0;

  // `info` for a clean boot and `warn` when something was actually recovered: a
  // restart storm should be visible in the log without every normal boot being.
  const fields = {
    reclaimedDeliveries: report.reclaimedDeliveries,
    reenqueuedDeliveries: report.reenqueuedDeliveries,
    queueFailed: report.queue.failed,
    queueBacklog: report.queue.backlog,
    locksScanned: report.locks.scanned,
    locksReleased: report.locks.released,
    durationMs: report.durationMs,
  };
  if (recovered) moduleLog.warn(fields, "startup recovery found work left behind by a previous instance");
  else moduleLog.info(fields, "startup recovery complete");

  return report;
}
