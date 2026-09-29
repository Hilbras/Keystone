import { pino, type Logger } from "pino";
import { config } from "../config.js";

/**
 * A structured logger for code that has no request to hang a log line off.
 *
 * Fastify gives every route a `request.log`, and a route should use that one: it
 * already carries the request id, so a log line can be joined to the request that
 * produced it. This exists for the code that runs with no request — services,
 * queue workers, event subscribers, background jobs — where `console.error` was
 * being used instead and produced an unstructured line with no service name and
 * no level, in a system whose only structured logging was Fastify's.
 *
 * Two things it deliberately is not:
 *
 * - **Not a second logger instance per call site.** `serviceLogger("webhooks")`
 *   returns a child, so every line carries the name of the thing that emitted it
 *   and one pino instance exists per process.
 * - **Not `console`.** The level comes from `KEYSTONE_LOG_LEVEL`, so the same
 *   setting silences this and Fastify's, and a test or a benchmark can quiet the
 *   whole process with one variable. `console` ignores it, which is how the
 *   benchmark ended up measuring its own logging in 3.1.0.
 */
let root: Logger | undefined;

function rootLogger(): Logger {
  root ??= pino({
    level: config.LOG_LEVEL ?? (config.NODE_ENV === "production" ? "info" : "debug"),
    base: { service: "keystone" },
  });
  return root;
}

/** A logger tagged with the emitting component. */
export function serviceLogger(name: string): Logger {
  return rootLogger().child({ component: name });
}

/**
 * Reset the cached instance.
 *
 * Test-only, and needed because the level is read once: a suite that changes
 * `KEYSTONE_LOG_LEVEL` after something has already logged would otherwise keep
 * the old level and conclude the setting does not work.
 */
export function resetServiceLogger(): void {
  root = undefined;
}
