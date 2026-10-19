/**
 * Whether this process has finished booting.
 *
 * `/health/startup` answers a third question that neither of the other two probes
 * can express: *is boot still in progress?* Kubernetes disables the liveness and
 * readiness probes until the startup probe first succeeds, so a process that takes
 * two minutes to compose itself (load signing keys, seed role permissions, adopt a
 * legacy SCIM config, load workflows) is not killed at thirty seconds for being
 * slow — which is what happens when a startup probe is really a liveness probe.
 *
 * **The flag is flipped by `start()`, after `listen()` returns, and by nothing
 * else.** That placement is the whole design. `buildApp()` finishing means the
 * application object is composed; it does not mean a socket is bound. Flipping the
 * flag there would make the probe true at a moment when no client could reach it,
 * which is a probe that cannot fail and therefore reports nothing. Anchoring it to
 * the successful bind means a refused or occupied port leaves `/health/startup`
 * answering 503 forever — the correct answer, and one an operator can act on.
 *
 * A test that builds the app and uses `inject()` never calls `listen()`, so it sees
 * the *starting* answer by default and has to call `markStartupComplete()` to see
 * the other one. That is deliberate: a suite can exercise both branches, and a
 * suite that forgot the call fails loudly rather than passing on a state the
 * production process cannot actually be in.
 */

interface StartupState {
  complete: boolean;
  /** When this process began booting, for `uptimeMs`. */
  beganAt: number;
  /** When boot completed, or `null` while it is still running. */
  completedAt: number | null;
}

const state: StartupState = {
  complete: false,
  beganAt: Date.now(),
  completedAt: null,
};

export interface StartupReport {
  status: "starting" | "started";
  /** Milliseconds since the process began booting. */
  uptimeMs: number;
}

/**
 * Record that the socket is bound and the process is serving.
 *
 * Idempotent, so a second call cannot move the timestamp that `startedAt` reports.
 */
export function markStartupComplete(): void {
  state.complete = true;
  state.completedAt ??= Date.now();
}

export function isStartupComplete(): boolean {
  return state.complete;
}

/**
 * The body of `/health/startup`.
 *
 * `status` is a string rather than a bare boolean because the endpoint has three
 * possible readers — the kubelet, a human with `curl`, and a deploy script — and
 * `"started"` says what `true` leaves them to guess.
 */
export function buildStartupReport(): StartupReport {
  return {
    status: state.complete ? "started" : "starting",
    uptimeMs: Date.now() - state.beganAt,
  };
}

/**
 * Return the process to "starting".
 *
 * Exists for tests that need to observe the 503 branch. Not called from production
 * code: a process that has finished booting has no reason to un-finish, and a
 * callable reset in a request path would be a way to take a healthy instance out of
 * a load balancer.
 */
export function resetStartupState(): void {
  state.complete = false;
  state.beganAt = Date.now();
  state.completedAt = null;
}
