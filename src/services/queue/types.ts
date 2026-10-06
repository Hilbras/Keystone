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
}

export type JobHandler = (job: Job) => void | Promise<void>;

export interface QueueStats {
  type: string;
  count: number;
  failed?: number;
  delayed?: number;
}

export interface Queue {
  enqueue<T>(job: Job<T>): Promise<void>;
  process(type: string, handler: JobHandler): void;
  getStats?(): Promise<QueueStats[]>;
  getFailed?(limit: number): Promise<Job[]>;
  retry?(jobId: string): Promise<void>;
  retryAll?(): Promise<void>;
  close?(): Promise<void>;
}
