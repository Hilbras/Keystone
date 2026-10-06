import crypto from "node:crypto";
import { redis } from "./redis.js";
import { serviceLogger } from "../lib/logger.js";
import { WORKER_ID } from "./queue/workerIdentity.js";

const moduleLog = serviceLogger("lock");

/**
 * A distributed lock over Redis.
 *
 * **§2.4.** Every cross-instance invariant this project needs — one worker per job,
 * one bootstrap per setup, one key rotation at a time — reduces to "at most one
 * holder of X, and only while it is alive". BullMQ solves that for its own jobs;
 * nothing solved it for Keystone's own work.
 *
 * ## The failure this is built to avoid
 *
 * The obvious implementation is `SET key token NX PX ttl` then a plain `DEL` on
 * release. That is **not safe**, and the reason is the whole design:
 *
 * ```text
 * Caller A acquires with a 5s TTL, then pauses 6s (GC, a slow dependency).
 * The lease expires; caller B acquires.
 * A finishes and runs DEL — deleting B's lock.
 * Now two callers believe they hold it.
 * ```
 *
 * Not theoretical: it happens whenever the TTL is shorter than the holder's work.
 * The fix is **ownership verification** — release and renew only when the stored
 * token is still ours, as one atomic Lua script so two callers cannot interleave
 * between the read and the write.
 *
 * ## The token is not the worker id
 *
 * Each acquisition gets a fresh random token. Reusing `WORKER_ID` would be a
 * subtle trap: two *different* acquisitions by the same worker would share a token,
 * so the first one's release would be permitted while the second still held it —
 * exactly the bug this design removes. `WORKER_ID` goes in the *log line*, which is
 * what makes an expiry diagnosable.
 */
export interface LockHandle {
  readonly key: string;
  /** Per-acquisition token. The only thing that authorises a release. */
  readonly token: string;
  /** Which instance holds it, for diagnostics and for `inspectLock`. */
  readonly workerId: string;
  readonly acquiredAt: Date;
  /** Lease length in ms, before it may be stolen. */
  readonly ttlMs: number;
}

export interface AcquireOptions {
  /**
   * Lease length. **Must exceed the longest pause the holder could plausibly have** —
   * a GC pause, a slow downstream, a dropped Redis round trip. A TTL shorter than
   * the work is not a safety margin, it is a correctness bug.
   */
  ttlMs?: number;
  /** How long to wait for a contended lock before giving up. */
  waitMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** Clock, injected so the wait-timeout path is testable without real sleeping. */
  now?: () => number;
}

export const DEFAULT_LOCK_TTL_MS = 30_000;
export const DEFAULT_LOCK_WAIT_MS = 0;

/**
 * Compare-and-delete, in one round trip.
 *
 * A `GET` followed by a `DEL` has a window between them in which a second caller
 * acquires and is then deleted by the first. `EVAL` is atomic on Redis's single
 * thread, which is what makes the release safe.
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/** The same discipline for renewal: a blind `PEXPIRE` would extend someone else's lease. */
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The stored value: JSON, so `inspectLock` can name the holder. */
const encode = (workerId: string, token: string) => JSON.stringify({ workerId, token });
const decode = (raw: string): { workerId?: string; token?: string } => {
  try {
    const parsed = JSON.parse(raw) as { workerId?: unknown; token?: unknown };
    return {
      workerId: typeof parsed.workerId === "string" ? parsed.workerId : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
    };
  } catch {
    // A value this module did not write — a hand-set key, or a format change. It
    // must not be treated as ours, so `token` stays undefined and any release or
    // renewal is refused.
    return {};
  }
};

/**
 * Take the lock, or return `null`.
 *
 * `null` rather than a throw on contention: a contended lock is normal in a
 * multi-instance deployment and the caller usually wants to do something else
 * rather than abort.
 */
export async function acquireLock(key: string, options: AcquireOptions = {}): Promise<LockHandle | null> {
  const {
    ttlMs = DEFAULT_LOCK_TTL_MS,
    waitMs = DEFAULT_LOCK_WAIT_MS,
    pollMs = 25,
    now = Date.now,
  } = options;

  const token = crypto.randomBytes(16).toString("hex");
  const deadline = now() + waitMs;

  for (;;) {
    // PX, not EX: the lease is in milliseconds and EX takes seconds, so an EX-based
    // lock silently rounds a sub-second TTL up to a whole one.
    const acquired = await redis.set(key, encode(WORKER_ID, token), "PX", ttlMs, "NX");
    if (acquired === "OK") {
      return { key, token, workerId: WORKER_ID, acquiredAt: new Date(now()), ttlMs };
    }
    if (waitMs <= 0 || now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

/**
 * Release a lock we hold.
 *
 * `false` means the lease had expired and been taken by someone else — the caller
 * should read that as "I did not hold this", not as an error, because the work it was
 * guarding is no longer guarded.
 */
export async function releaseLock(handle: LockHandle): Promise<boolean> {
  try {
    const deleted = await redis.eval(RELEASE_SCRIPT, 1, handle.key, encode(handle.workerId, handle.token));
    return Number(deleted) === 1;
  } catch (err) {
    // Redis unreachable is the one case where we genuinely do not know whether we
    // hold the lock, and the honest answer is to say so rather than assume either
    // way. A release that could not be confirmed is usually the first sign of a
    // Redis problem, so it is logged rather than swallowed.
    moduleLog.error({ err, key: handle.key }, "lock release could not be confirmed");
    return false;
  }
}

/** Extend a lease we still hold. `false` means it had already been lost. */
export async function renewLock(handle: LockHandle, ttlMs = handle.ttlMs): Promise<boolean> {
  try {
    const renewed = await redis.eval(
      RENEW_SCRIPT,
      1,
      handle.key,
      encode(handle.workerId, handle.token),
      String(ttlMs)
    );
    return Number(renewed) === 1;
  } catch (err) {
    moduleLog.error({ err, key: handle.key }, "lock renew could not be confirmed");
    return false;
  }
}

/**
 * Who holds a lock, and for how long.
 *
 * Returns `null` when nobody holds it. For diagnostics and for §6.4 — "is instance 3
 * stuck holding the setup lock?" is a question that has to be answerable before
 * recovery can act on it.
 */
export async function inspectLock(
  key: string
): Promise<{ held: true; workerId?: string; ttlMs: number } | null> {
  const raw = await redis.get(key);
  if (raw === null) return null;
  const ttlMs = await redis.pttl(key);
  // A non-positive PTTL means the key exists with no expiry — which should be
  // impossible here, and is worth surfacing as ttlMs 0 rather than hidden.
  return { held: true, workerId: decode(raw).workerId, ttlMs: ttlMs > 0 ? ttlMs : 0 };
}

/**
 * Run `fn` under a lock, releasing it however `fn` ends.
 *
 * The release is in a `finally`, and that is not incidental: the common bug is a
 * thrown error leaving the lock held for the whole lease, turning one failure into a
 * stall for every other caller.
 *
 * `fn` receives the handle so a long operation can renew rather than lose it.
 */
export async function withLock<T>(
  key: string,
  fn: (handle: LockHandle) => Promise<T>,
  options: AcquireOptions = {}
): Promise<{ acquired: boolean; value?: T }> {
  const handle = await acquireLock(key, options);
  if (!handle) return { acquired: false };
  try {
    return { acquired: true, value: await fn(handle) };
  } finally {
    await releaseLock(handle);
  }
}