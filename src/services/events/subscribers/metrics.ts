import { failedLoginsTotal } from "../../../plugins/metrics.js";
import type { KeystoneEvent, EventHandler } from "../types.js";

/**
 * Counters fed from the event bus.
 *
 * `keystone_failed_logins_total` was registered in `plugins/metrics.ts` and
 * incremented from nowhere. It exported as a series with value 0, forever, which
 * on a dashboard is indistinguishable from "nobody has failed to log in" — the
 * one reading a failed-login alert must never be able to take.
 *
 * An event subscriber rather than a call at the route, because the event is
 * emitted from more places than the route. `services/domain/authentication.ts`
 * emits `user_login_failed` with five distinct reasons (`unknown_user`,
 * `invalid_password`, `account_deactivated`, `account_locked`,
 * `account_review_required`) from the login service itself, so a counter
 * incremented in `routes/auth.ts` would have counted one path out of six. The
 * bus is the one place every failure passes through.
 *
 * `reason` is the label rather than a constant, so a new failure mode shows up
 * as a new series value instead of being folded into "failed" and invisible.
 */
export const metricsSubscriber: EventHandler = async (event: KeystoneEvent): Promise<void> => {
  if (event.type !== "user_login_failed") return;
  const reason = typeof event.payload.reason === "string" ? event.payload.reason : "unknown";
  failedLoginsTotal.inc({ reason });
};
