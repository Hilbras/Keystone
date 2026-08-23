import { Queue as BullQueue, Worker, type Job as BullJob } from "bullmq";
import type { Queue, Job, JobHandler, QueueStats } from "./types.js";

export class BullMQQueue implements Queue {
  private queue: BullQueue;
  private workers = new Map<string, Worker>();
  private handlers = new Map<string, JobHandler>();
  private redisUrl: string;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
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
      console.warn(`[bullmq-queue] handler for ${type} already registered`);
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
        };
        await handler(job);
      },
      {
        connection: { url: this.redisUrl },
        concurrency: 5,
      }
    );

    worker.on("failed", (job, err) => {
      console.error(`[bullmq-queue] job ${job?.name} ${job?.id} failed:`, err);
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
  }
}
