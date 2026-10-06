import { Queue as BullQueue, Worker, type Job as BullJob } from "bullmq";
import type { Queue, Job, JobHandler, QueueStats } from "./types.js";
import { serviceLogger } from "../../lib/logger.js";
import { config } from "../../config.js";
import { WORKER_ID } from "./workerIdentity.js";

const moduleLog = serviceLogger("queue");

export class BullMQQueue implements Queue {
  private queue: BullQueue;
  private workers = new Map<string, Worker>();
  private handlers = new Map<string, JobHandler>();
  private redisUrl: string;
  private concurrency: number;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
    // §2.5: was a hardcoded 5. Read once here rather than per `process()` call so
    // every queue type on one instance drains at the same rate.
    this.concurrency = config.QUEUE_CONCURRENCY;
    this.queue = new BullQueue("keystone", {
      connection: { url: redisUrl },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 100,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    });
  }

  async enqueue<T>(job: Job<T>): Promise<void> {
    await this.queue.add(job.type, job.payload, {
      jobId: job.id,
      attempts: job.attempts ?? 3,
    });
  }

  process(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) {
      moduleLog.warn("queue");
      return;
    }
    this.handlers.set(type, handler);

    const worker = new Worker(
      "keystone",
      async (bullJob: BullJob) => {
        const job: Job = {
          id: bullJob.id,
          type: bullJob.name,
          payload: bullJob.data,
          attempts: bullJob.attemptsMade,
          createdAt: bullJob.timestamp ? new Date(bullJob.timestamp) : undefined,
          // §2.5. Recorded per job rather than per process, so a handler can name
          // its owner in a span or a lock without reaching for a global. The
          // in-process driver sets the same two fields, so a handler written
          // against one driver behaves identically on the other.
          workerId: WORKER_ID,
          workerHeartbeatAt: new Date(),
        };
        await handler(job);
      },
      {
        connection: { url: this.redisUrl },
        concurrency: this.concurrency,
      }
    );

    worker.on("failed", (job, err) => {
      moduleLog.error({ err }, "queue");
    });

    this.workers.set(type, worker);
  }

  async getStats(): Promise<QueueStats[]> {
    const counts = await this.queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    return [
      {
        type: "all",
        count: (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.completed ?? 0),
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      },
    ];
  }

  async getFailed(limit = 50): Promise<Job[]> {
    const jobs = await this.queue.getFailed(0, limit);
    return jobs.map((j) => ({
      id: String(j.id),
      type: j.name,
      payload: j.data,
      attempts: j.attemptsMade,
      createdAt: j.timestamp ? new Date(j.timestamp) : undefined,
    }));
  }

  async retry(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (job) await job.retry();
  }

  async retryAll(): Promise<void> {
    const jobs = await this.queue.getFailed();
    await Promise.all(jobs.map((j) => j.retry()));
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.workers.values()).map((worker) => worker.close()));
    await this.queue.close();
    // Reset registries so a closed instance (e.g. the shared singleton after a
    // test's app.close()) can accept process()/enqueue() again with fresh
    // connections instead of silently reusing dead ones.
    this.workers.clear();
    this.handlers.clear();
  }
}
