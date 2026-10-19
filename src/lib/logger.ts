import { pino, stdSerializers, type Logger, type LoggerOptions } from "pino";
import { config } from "../config.js";
import { sanitizeLogValue, scrubDriverErrorText, stripQuery } from "./logSanitizer.js";

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

/**
 * The options both loggers are built from.
 *
 * Fastify builds its own pino instance from the options passed to `fastify()`, so
 * "both loggers" is not one logger — it is two instances that must behave the same
 * way, and §5.1's redaction requirement would be worth nothing if it held on one
 * of them. Sharing the options object is what makes them the same: the scrubbing
 * is installed once and applies to `request.log` and to `serviceLogger()` alike,
 * and a future second instance cannot be added without it.
 *
 * `level` is left to the caller, because Fastify already resolves it from
 * `KEYSTONE_LOG_LEVEL` and the two must not disagree.
 */
export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { service: "keystone" },
    serializers: {
      /**
       * §5.1, and the half that was missed on the first pass.
       *
       * Redacting `requestLogger`'s own line was not enough, because Fastify logs
       * the request itself — "incoming request" carries a serialized `req`, and the
       * default serializer includes `url` verbatim, query string and all. So the
       * token still reached stdout on the line next to the sanitised one. Measured,
       * not inferred: the probe in `tests/observability/logging.test.ts` failed on
       * exactly that line.
       *
       * This reproduces Fastify's default shape (`node_modules/fastify/lib/logger-pino.js`)
       * field for field, with `url` reduced to its path — no field is dropped, so no
       * log-based dashboard or alert loses what it was reading. `req` is a top-level
       * key that only ever holds a request, which is why one serializer is safe to
       * install on both loggers.
       */
      req(request: {
        method?: string;
        url?: string;
        headers?: Record<string, unknown>;
        host?: string;
        ip?: string;
        socket?: { remotePort?: number };
      }) {
        return {
          method: request.method,
          url: stripQuery(request.url ?? ""),
          version: request.headers?.["accept-version"],
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
      /**
       * §5.1 again: the driver's bound parameters, in the message and the stack.
       *
       * pino's own error serializer is the right shape to keep — `type`, `message`,
       * `stack` — so this wraps it rather than replacing it, and the only change is
       * that the Drizzle parameter list is cut out of the two fields that carry a
       * copy of the message. See `scrubDriverErrorText` for why the values are in
       * there at all.
       */
      err(error: Error) {
        const serialized = stdSerializers.err(error);
        if (typeof serialized.message === "string") {
          serialized.message = scrubDriverErrorText(serialized.message);
        }
        if (typeof serialized.stack === "string") {
          serialized.stack = scrubDriverErrorText(serialized.stack);
        }
        return serialized;
      },
    },
    hooks: {
      /**
       * §5.1. The first argument of a log call is where structured fields live, so
       * it is the only place a secret can be written as a field. Everything else —
       * the message, a `%s` substitution, a later argument — reaches pino as a
       * string, and a secret interpolated into a message is not recoverable by any
       * key-based rule; that is why the sanitizer is one half of the requirement
       * and the review of log *call sites* is the other.
       */
      logMethod(this: Logger, args: Parameters<Logger["info"]>, method: Logger["info"]) {
        const [first] = args;
        if (first !== null && typeof first === "object") {
          args[0] = sanitizeLogValue(first) as typeof first;
        }
        method.apply(this, args);
      },
    },
  };
}

function resolveLevel(): string {
  return config.LOG_LEVEL ?? (config.NODE_ENV === "production" ? "info" : "debug");
}

function rootLogger(): Logger {
  root ??= pino(loggerOptions(resolveLevel()));
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
