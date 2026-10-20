import type { Queue, Job, JobHandler, QueueStats } from "./types.js";
import { serviceLogger } from "../../lib/logger.js";
import { WORKER_ID } from "./workerIdentity.js";
import { recordQueueJob } from "../../plugins/operationalMetrics.js";
import { currentTraceId, runWithTrace } from "../../lib/traceContext.js";

const log = serviceLogger("queue");

const DEFAULT_ATTEMPTS = 3;

/**
 * The label value both drivers publish, so a dashboard query covers either.
 *
 * Named here rather than written at the call site in each driver, so the two cannot
 * drift into `in-process` and `inProcess` — which would show up as a queue that
 * stopped reporting after a configuration change rather than as an error.
 */
export const PROVIDER = "in-process";

export class InProcessQueue implements Queue {
  readonly provider = PROVIDER;
  private handlers = new Map<string, JobHandler>();
  private stats = new Map<string, { count: number; failed: number }>();
  /**
   * §6.3. Work running right now, so `close()` can drain rather than clear.
   *
   * `close()` used to empty the handler map and return. A handler already running
   * kept running against a map that no longer knew it, and a queued retry fired into
   * a map with no handler and was silently dropped — logged as "no handler
   * registered", which reads like a configuration bug rather than a shutdown.
   *
   * `closed` is cleared by `process()`, not by `enqueue()`. Registering a handler is
   * what makes a queue live; that keeps `close()` a drain point rather than a
   * tombstone that breaks a later test or a re-initialised container.
   */
  private inFlight = new Set<Promise<void>>();
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  async enqueue<T>(job: Job<T>): Promise<void> {
    // §2.5. The two ownership fields are filled in here so a handler written against
    // this driver sees the same shape it would on BullMQ. On this driver they are
    // constant rather than meaningful — there is only ever one worker, and it cannot
    // die holding work — but code that reads `job.workerId` to name a lock owner
    // must not have to know which driver it is running under.
    const owned: Job<T> = {
      ...job,
      workerId: job.workerId ?? WORKER_ID,
      workerHeartbeatAt: job.workerHeartbeatAt ?? new Date(),
      // §5.4. Stamped here rather than at the call site, so the ~dozen places that
      // enqueue a job are all covered without any of them knowing about tracing.
      // The driver is the one place every enqueue passes through.
      traceId: job.traceId ?? currentTraceId(),
    };
    setImmediate(() => {
      const running = this.run(owned, 1).catch((err) => {
        log.error({ err, jobType: owned.type }, "job failed permanently");
      });
      this.inFlight.add(running);
      void running.then(() => this.inFlight.delete(running));
    });
  }

  process(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
    // See the field comment: a registered handler is what makes the queue live.
    this.closed = false;
  }

  async getStats(): Promise<QueueStats[]> {
    return Array.from(this.stats.entries()).map(([type, s]) => ({
      type,
      count: s.count,
      failed: s.failed,
    }));
  }

  async getFailed(): Promise<Job[]> {
    return [];
  }

  async retry(): Promise<void> {
    // No persisted failed jobs in the in-process queue.
  }

  async retryAll(): Promise<void> {
    // No persisted failed jobs in the in-process queue.
  }

  async close(): Promise<void> {
    // Stop scheduling new work first, then wait for what is already running. The
    // order matters: clearing the timers after the drain would let a job that
    // failed during the drain schedule a retry that fires after `close()` resolved.
    this.closed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    // `allSettled`, not `all`: one handler that throws must not leave the rest of
    // the drain un-awaited, and every promise here has already been caught.
    await Promise.allSettled(Array.from(this.inFlight));
    this.inFlight.clear();
    this.handlers.clear();
    this.stats.clear();
  }

  private async run(job: Job, attempt: number): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      log.warn({ jobType: job.type }, "no handler registered for this job type");
      return;
    }

    this.increment(job.type, "count");

    const startedAt = Date.now();
    // §5.4. The handler runs inside the enqueueing request's trace, so a log line
    // it emits joins back to that request. The context is set per job rather than
    // per process because a worker drains jobs from many requests in sequence.
    const trace = job.traceId ? { traceId: job.traceId } : undefined;
    try {
      await runWithTrace(trace, () => handler(job));
      recordQueueJob(PROVIDER, job.type, "completed", startedAt);
    } catch (err) {
      const maxAttempts = job.attempts ?? DEFAULT_ATTEMPTS;
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
        // Counted as `retried`, not as `failed`: the job is still going to run, and
        // an alert that fires on every transient dependency blip is an alert nobody
        // reads. `failed` is reserved for the last attempt, where the work is
        // genuinely lost.
        recordQueueJob(PROVIDER, job.type, "retried", startedAt);
        log.warn(
          { jobType: job.type, attempt, maxAttempts, delayMs: delay },
          "job failed, scheduling a retry"
        );
        // The rejection of the *retry* is handled here, not only the first
        // attempt's. `setTimeout(() => this.run(...))` discards the returned
        // promise, so the attempt that finally exhausts the budget threw into
        // nobody's hands and became an unhandled rejection — which terminates a
        // Node process by default. A single poison job took the server down
        // (SEC-053). The first attempt is covered by `enqueue`'s `.catch`; the
        // retries are covered here.
        // §6.3. A retry scheduled after `close()` began would fire into a cleared
        // handler map and be dropped with a misleading "no handler registered".
        // This driver has no persistence, so a retry at shutdown has nowhere to go.
        if (this.closed) return;
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          const retried = this.run(job, attempt + 1).catch((retryErr: unknown) => {
            log.error(
              { err: retryErr, jobType: job.type, attempts: maxAttempts },
              "job failed permanently and was dropped"
            );
          });
          this.inFlight.add(retried);
          void retried.then(() => this.inFlight.delete(retried));
        }, delay);
        this.retryTimers.add(timer);
        return;
      }
      this.increment(job.type, "failed");
      recordQueueJob(PROVIDER, job.type, "failed", startedAt);
      throw err;
    }
  }

  private increment(type: string, key: "count" | "failed"): void {
    const current = this.stats.get(type) ?? { count: 0, failed: 0 };
    current[key]++;
    this.stats.set(type, current);
  }
}
