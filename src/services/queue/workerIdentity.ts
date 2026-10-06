import { hostname } from "node:os";
import crypto from "node:crypto";

/**
 * A stable identity for this process as a queue worker.
 *
 * **§2.5, worker ownership.** BullMQ guarantees a job runs on one worker at a time.
 * What it does not expose is *which* one, so with two or more Keystone instances
 * there was no way to answer "is instance 3 still draining its queue, or did it die
 * holding jobs?"
 *
 * That question has to be answerable before any of the rest of the distributed work
 * can be: a distributed lock needs an owner to name, and a crashed owner needs to be
 * identifiable so its work can be recovered.
 *
 * ## Why `hostname` alone is not enough
 *
 * Two Keystone instances behind one load balancer are two pods, and Kubernetes gives
 * every pod a distinct hostname — so `hostname` does separate them in the case that
 * matters. It does *not* separate two processes on one host, which is what a
 * developer's machine and a `docker compose up` both produce, and that is exactly the
 * configuration where "which one holds this job" is hardest to answer by eye.
 *
 * So `hostname#pid` — unique across both, and readable in a log line without a lookup
 * table. The random suffix handles a recycled pid on a long-lived host: a restarted
 * process that reuses the pid of a dead one would otherwise present as the same
 * worker holding the same lease.
 *
 * Deliberately **not** configurable. An operator who sets it to something constant
 * across instances reintroduces exactly the ambiguity this exists to remove, and a
 * misconfiguration here is worse than no configuration at all.
 */
export const WORKER_ID = `${hostname()}#${process.pid}#${crypto.randomBytes(4).toString("hex")}`;

/**
 * How often a worker reports that it is alive.
 *
 * A lease (§2.5) is only as good as the interval at which its holder renews it, and
 * the two numbers have to be read together: a lease must outlive more than one
 * heartbeat, or a live worker loses its claim to a slow tick. 30s against a 120s
 * lease is a four-miss margin, which tolerates a GC pause or a slow Redis without a
 * second instance stealing work that is still running.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Default jobs one instance runs at once.
 *
 * Was hardcoded to `5`. Concurrency is the primary lever on how much load one
 * instance puts on its database and on every downstream HTTP consumer, so a
 * deployment cannot choose its own — which for a multi-instance deployment (§2.7)
 * means the operator cannot divide capacity between instances at all.
 *
 * The default is unchanged at 5 so behaviour does not shift for anyone who sets
 * nothing.
 */
export const DEFAULT_CONCURRENCY = 5;