import { serviceLogger } from "../lib/logger.js";

const moduleLog = serviceLogger("shutdown");

/**
 * §6.3. Graceful shutdown.
 *
 * Before this file there were **no signal handlers anywhere in the server**. Node's
 * default disposition for SIGTERM is to terminate immediately, so a deploy, a
 * `docker stop`, or a Kubernetes pod eviction severed every in-flight request and
 * killed background work mid-flight. Worse, the existing teardown — the `onClose`
 * hook that closes the queue and the cache — never ran either, because nothing ever
 * called `app.close()` in production: there was no stop path to run it from.
 *
 * ## The order, and why each step is where it is
 *
 * ```text
 * stop accepting requests      app.close() closes the listener first
 * finish active requests       ...and waits for them before resolving
 * stop workers                 queue.close() runs from onClose, draining active jobs
 * finish safe jobs             BullMQ's non-forced worker.close() awaits them;
 *                              the in-process driver drains its in-flight set
 * release locks                every lock is released from a `finally` or expires
 * close DB                     after the queue, because a draining job writes
 * close Redis                  last, because the queue and cache own connections
 *                              derived from it
 * exit
 * ```
 *
 * The database is closed *after* the queue on purpose: a job that finishes during
 * the drain still needs to persist its result. Closing the pool first would turn a
 * graceful drain into a wave of "connection terminated" errors.
 *
 * ## A bounded wait
 *
 * A dependency that never settles must not make a deploy hang until the orchestrator
 * SIGKILLs it. The whole sequence is given a deadline (`KEYSTONE_SHUTDOWN_TIMEOUT_MS`,
 * default 10s). On expiry the process exits non-zero and says which step it was on,
 * so the next run has a diagnosis rather than a mystery.
 */

export interface ShutdownDependencies {
  /** Fastify's `close()`: stops the listener, drains in-flight requests, runs onClose hooks. */
  closeApp: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  closeRedis: () => Promise<void>;
}

export interface ShutdownOptions {
  /** Deadline for the whole sequence. Default 10 000 ms. */
  timeoutMs?: number;
  /** Injected so a test can observe the exit code instead of ending the test run. */
  exit?: (code: number) => void;
  log?: (message: string) => void;
  error?: (message: string, err?: unknown) => void;
}

export interface ShutdownResult {
  ok: boolean;
  timedOut: boolean;
  /** Steps that completed, in order — the same list the log carries. */
  completed: string[];
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

let inProgress: Promise<ShutdownResult> | null = null;
let signalCount = 0;

function report(options: ShutdownOptions) {
  return {
    log: options.log ?? ((message: string) => moduleLog.info({}, message)),
    error:
      options.error ??
      ((message: string, err?: unknown) =>
        err === undefined ? moduleLog.error({}, message) : moduleLog.error({ err }, message)),
  };
}

/**
 * Run the shutdown sequence. Idempotent: the second caller awaits the first.
 *
 * Steps are individually isolated — one failing dependency does not skip the rest.
 * A database that refuses to close is a reason to log an error, not a reason to
 * leave Redis open.
 */
export function runShutdown(
  deps: ShutdownDependencies,
  options: ShutdownOptions = {}
): Promise<ShutdownResult> {
  if (inProgress) return inProgress;

  const { log, error } = report(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  inProgress = (async () => {
    const completed: string[] = [];
    let timedOut = false;
    let current = "shutdown";

    const deadline = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      // Do not let the deadline itself keep the process alive.
      timer.unref?.();
    });

    const sequence = (async () => {
      const steps: Array<[string, () => Promise<void>]> = [
        ["http-server", deps.closeApp],
        ["database", deps.closeDatabase],
        ["redis", deps.closeRedis],
      ];

      for (const [name, step] of steps) {
        current = name;
        try {
          await step();
          completed.push(name);
          log(`shutdown: ${name} closed`);
        } catch (err) {
          error(`shutdown: ${name} failed to close`, err);
        }
      }
      return "done" as const;
    })();

    const outcome = await Promise.race([sequence, deadline]);
    if (outcome === "timeout") {
      timedOut = true;
      error(
        `shutdown timed out after ${timeoutMs}ms while closing ${current}; ` +
          `completed: ${completed.join(", ") || "none"}. Exiting so the orchestrator is not left waiting.`
      );
    }

    log(
      `shutdown ${timedOut ? "forced" : "complete"}: ` +
        `${completed.join(" -> ") || "no steps completed"}`
    );

    exit(timedOut ? 1 : 0);
    return { ok: !timedOut, timedOut, completed };
  })();

  return inProgress;
}

/**
 * Install SIGTERM/SIGINT handlers.
 *
 * Returns a disposer, because a test that installs handlers on the shared process
 * must be able to take them off again.
 *
 * A second signal exits immediately. That is the operator's "I already asked once"
 * — the alternative is a process that appears to ignore `docker stop` and then
 * receives SIGKILL anyway, with no explanation.
 */
export function installShutdownHandlers(
  deps: ShutdownDependencies,
  options: ShutdownOptions = {}
): () => void {
  const { log, error } = report(options);
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const onSignal = (signal: NodeJS.Signals) => {
    signalCount += 1;
    if (signalCount > 1) {
      error(`received ${signal} again; exiting immediately`);
      exit(1);
      return;
    }
    log(`received ${signal}; draining`);
    void runShutdown(deps, options);
  };

  const onTerm = () => onSignal("SIGTERM");
  const onInt = () => onSignal("SIGINT");
  // `on`, not `once`. With `once` the listener is removed by the first signal, so
  // the second-signal path could never run — the process would sit in the drain
  // exactly as if it had never asked twice. The disposer, not the emitter, is what
  // removes these.
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  return () => {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  };
}

/** Test seam: put the module back to its initial state and clear the signal counter. */
export function resetShutdownStateForTests(): void {
  inProgress = null;
  signalCount = 0;
}

/** The shutdown currently running, if any — for diagnostics. */
export function isShuttingDown(): boolean {
  return inProgress !== null;
}
