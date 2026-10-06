import type { Queue, Job, JobHandler, QueueStats } from "./types.js";
import { serviceLogger } from "../../lib/logger.js";
import { WORKER_ID } from "./workerIdentity.js";

const log = serviceLogger("queue");

const DEFAULT_ATTEMPTS = 3;

export class InProcessQueue implements Queue {
  private handlers = new Map<string, JobHandler>();
  private stats = new Map<string, { count: number; failed: number }>();

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
    };
    setImmediate(() => {
      this.run(owned, 1).catch((err) => {
        log.error({ err, jobType: owned.type }, "job failed permanently");
      });
    });
  }

  process(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
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

    try {
      await handler(job);
    } catch (err) {
      const maxAttempts = job.attempts ?? DEFAULT_ATTEMPTS;
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
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
        setTimeout(() => {
          this.run(job, attempt + 1).catch((retryErr: unknown) => {
            log.error(
              { err: retryErr, jobType: job.type, attempts: maxAttempts },
              "job failed permanently and was dropped"
            );
          });
        }, delay);
        return;
      }
      this.increment(job.type, "failed");
      throw err;
    }
  }

  private increment(type: string, key: "count" | "failed"): void {
    const current = this.stats.get(type) ?? { count: 0, failed: 0 };
    current[key]++;
    this.stats.set(type, current);
  }
}
