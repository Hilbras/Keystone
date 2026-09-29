import type { Queue, Job, JobHandler, QueueStats } from "./types.js";
import { serviceLogger } from "../../lib/logger.js";

const log = serviceLogger("queue");

const DEFAULT_ATTEMPTS = 3;

export class InProcessQueue implements Queue {
  private handlers = new Map<string, JobHandler>();
  private stats = new Map<string, { count: number; failed: number }>();

  async enqueue<T>(job: Job<T>): Promise<void> {
    setImmediate(() => {
      this.run(job, 1).catch((err) => {
        log.error({ err, jobType: job.type }, "job failed permanently");
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
        setTimeout(() => this.run(job, attempt + 1), delay);
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
