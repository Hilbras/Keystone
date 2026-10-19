export interface Job<T = unknown> {
  id?: string;
  type: string;
  payload: T;
  attempts?: number;
  createdAt?: Date;
  /**
   * Which instance is running this job, and its heartbeat timestamp.
   *
   * **Added for §2.5.** BullMQ already guarantees one job runs on one worker at a
   * time; what it does not do is tell you *which* one. With two or more Keystone
   * instances there was no way to answer "is instance 3 still draining its queue, or
   * did it die holding jobs?" — the information existed in BullMQ's internals and
   * nowhere a handler could reach.
   *
   * It matters because every attempt at a distributed lock needs an owner to name,
   * and because a crashed instance holding work is a recovery problem you cannot
   * diagnose without knowing it held work.
   *
   * Optional and additive: a handler that ignores it is unaffected, and the
   * in-process driver supplies the same shape so code written against it works on
   * both.
   */
  workerId?: string;
  workerHeartbeatAt?: Date;
  /**
   * The trace id of the work that enqueued this job.
   *
   * **Added for §5.4.** A job runs on a worker, often a different process, minutes
   * after the request that produced it has been answered — so every log line the
   * handler emits was previously unattributable. The enqueueing site almost never
   * sets this: both drivers stamp it from the ambient trace when the job is
   * accepted, so a caller that knows nothing about tracing still gets correlation.
   *
   * Optional because a job legitimately has no cause — a startup recovery pass, a
   * timer — and inventing an id for it would file unrelated work under one trace.
   */
  traceId?: string;
}

export type JobHandler = (job: Job) => void | Promise<void>;

export interface QueueStats {
  type: string;
  count: number;
  failed?: number;
  delayed?: number;
}

export interface Queue {
  /**
   * Which driver this is, as the same string the queue metrics carry under
   * `keystone_queue_jobs_total{provider}`.
   *
   * **Added for §5.5.** Diagnostics has to say which queue a deployment is actually
   * running on, and "which class is this" is not something a route can answer
   * without `instanceof` against the concrete driver — which would put the choice of
   * driver in the HTTP layer. Required rather than optional so a third driver cannot
   * be added without stating its label, and so the metric and the diagnostic can
   * never disagree about what this instance is.
   */
  readonly provider: string;
  enqueue<T>(job: Job<T>): Promise<void>;
  process(type: string, handler: JobHandler): void;
  getStats?(): Promise<QueueStats[]>;
  getFailed?(limit: number): Promise<Job[]>;
  retry?(jobId: string): Promise<void>;
  retryAll?(): Promise<void>;
  close?(): Promise<void>;
}
