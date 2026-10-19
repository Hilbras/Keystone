import { Queue as BullQueue, Worker, type Job as BullJob } from "bullmq";
import type { Queue, Job, JobHandler, QueueStats } from "./types.js";
import { serviceLogger } from "../../lib/logger.js";
import { config } from "../../config.js";
import { WORKER_ID } from "./workerIdentity.js";
import { recordQueueJob } from "../../plugins/operationalMetrics.js";
import { currentTraceId, runWithTrace } from "../../lib/traceContext.js";

const moduleLog = serviceLogger("queue");

/** See the note on `PROVIDER` in `inProcess.ts` — the label value, defined once. */
export const PROVIDER = "bullmq";

/**
 * The key the job payload is wrapped under, so the trace id can ride alongside it.
 *
 * §5.4 needs the enqueueing request's trace id to survive in Redis until a worker —
 * possibly a different process, minutes later — picks the job up. BullMQ gives a
 * job exactly two persisted fields, `name` and `data`, and its options bag is
 * filtered through a known-keys map on the way back out, so an extra key there is
 * written and then silently dropped on read. That leaves `data`, which means the
 * payload has to be nested one level down.
 *
 * `data` is therefore `{ [ENVELOPE]: { traceId }, payload }`. The alternative —
 * merging the id into the payload itself — was rejected because it changes what a
 * handler receives as `job.payload`, and a payload the application did not write
 * is a payload it cannot validate.
 */
const ENVELOPE = "__keystone_job__";

interface JobEnvelope {
  traceId?: string;
}

/** Read `data` back into the payload and its trace id, tolerating the old shape. */
function unwrap(data: unknown): { payload: unknown; traceId?: string } {
  // Jobs queued by the previous release are still in Redis across a deploy and
  // their `data` *is* the payload. The marker key cannot appear in a payload this
  // codebase produces, so its presence is an unambiguous discriminator — but the
  // fallback is what keeps a rolling restart from dropping work in flight.
  if (data && typeof data === "object" && ENVELOPE in (data as Record<string, unknown>)) {
    const record = data as Record<string, unknown> & { [ENVELOPE]?: JobEnvelope };
    return { payload: record.payload, traceId: record[ENVELOPE]?.traceId };
  }
  return { payload: data };
}

export class BullMQQueue implements Queue {
  readonly provider = PROVIDER;
  private queue: BullQueue;
  /**
   * One worker for every job type, not one per type.
   *
   * The per-type design was wrong in a way that only shows up under load: BullMQ
   * consumers are addressed by queue *name*, and every type here shares the single
   * `"keystone"` queue, so N workers on it are N competing consumers of the same
   * stream rather than N specialized consumers. Whichever worker grabs a job first
   * runs it, whatever its name — so registering `type_a` and `type_b` meant
   * `type_a`'s handler could be handed a `type_b` job, and `type_b`'s handler might
   * never run at all.
   *
   * The second half of that is the quieter half. A worker added by a later
   * `process()` call did not add a consumer for the new type; it joined the ones
   * already draining the queue, so a handler registered after `app.ready()` — which
   * is when the application's own registrations happen, relative to the driver
   * being constructed — could consume nothing at all. Measured: 0 of the 16 jobs
   * pushed for it in 8 seconds.
   *
   * Dispatching by `bullJob.name` at execution time through this map fixes both:
   * one consumer, and the handler is looked up when the job arrives rather than
   * frozen at registration time.
   */
  private worker?: Worker;
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
    await this.queue.add(
      job.type,
      { [ENVELOPE]: { traceId: job.traceId ?? currentTraceId() }, payload: job.payload },
      {
        jobId: job.id,
        attempts: job.attempts ?? 3,
      }
    );
  }

  process(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) {
      moduleLog.warn("queue");
      return;
    }
    this.handlers.set(type, handler);

    // Created on the first registration and reused from then on, because a second
    // worker on the same queue name would compete for jobs instead of serving the
    // type it was created for. See the note on `worker`.
    this.worker ??= this.createWorker();
  }

  private createWorker(): Worker {
    const worker = new Worker(
      "keystone",
      async (bullJob: BullJob) => {
        // Looked up per job, not captured per worker: the same consumer serves
        // every type, so the name on the job is what selects the handler.
        const handler = this.handlers.get(bullJob.name);
        if (!handler) {
          // Throwing is deliberate. Completing a job nobody handled would lose the
          // work silently, and the failure queue is the only place an operator
          // would ever see it.
          throw new Error(`no handler registered for job type "${bullJob.name}"`);
        }

        const { payload, traceId } = unwrap(bullJob.data);
        const job: Job = {
          id: bullJob.id,
          type: bullJob.name,
          payload,
          traceId,
          attempts: bullJob.attemptsMade,
          createdAt: bullJob.timestamp ? new Date(bullJob.timestamp) : undefined,
          // §2.5. Recorded per job rather than per process, so a handler can name
          // its owner in a span or a lock without reaching for a global. The
          // in-process driver sets the same two fields, so a handler written
          // against one driver behaves identically on the other.
          workerId: WORKER_ID,
          workerHeartbeatAt: new Date(),
        };
        // §5.2. Same three outcomes the in-process driver publishes, so one
        // dashboard panel covers either provider. The attempt that just ran is
        // `attemptsMade + 1` because BullMQ increments `attemptsMade` only after
        // this processor settles; reading it directly would report one less than
        // the attempt the handler actually performed and would classify the final
        // failure as a retry.
        const startedAt = Date.now();
        // §5.4. The handler runs inside the trace of whatever enqueued the job, so
        // its log lines join back to that request even though it is a different
        // process and possibly a later day.
        const trace = traceId ? { traceId } : undefined;
        try {
          await runWithTrace(trace, () => handler(job));
          recordQueueJob(PROVIDER, job.type, "completed", startedAt);
        } catch (err) {
          const maxAttempts = bullJob.opts?.attempts ?? 3;
          const attempt = (bullJob.attemptsMade ?? 0) + 1;
          recordQueueJob(
            PROVIDER,
            job.type,
            attempt < maxAttempts ? "retried" : "failed",
            startedAt
          );
          throw err;
        }
      },
      {
        connection: { url: this.redisUrl },
        concurrency: this.concurrency,
      }
    );

    worker.on("failed", (job, err) => {
      moduleLog.error({ err }, "queue");
    });

    return worker;
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
    return jobs.map((j) => {
      const { payload, traceId } = unwrap(j.data);
      return {
        id: String(j.id),
        type: j.name,
        payload,
        traceId,
        attempts: j.attemptsMade,
        createdAt: j.timestamp ? new Date(j.timestamp) : undefined,
      };
    });
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
    if (this.worker) await this.worker.close();
    await this.queue.close();
    // Reset registries so a closed instance (e.g. the shared singleton after a
    // test's app.close()) can accept process()/enqueue() again with fresh
    // connections instead of silently reusing dead ones.
    this.worker = undefined;
    this.handlers.clear();
  }
}
