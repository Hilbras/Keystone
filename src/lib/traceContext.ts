import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

/**
 * The correlation id that follows work across the process boundary.
 *
 * §5.4 asks for a trace id through HTTP → queue → webhook. OpenTelemetry already
 * produces a distributed trace, but only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
 * — `startTracing` returns early otherwise — so on a deployment that has not stood
 * up a collector there is *no* id joining a log line to the request that caused
 * it. An operator's only handle was `requestId`, which is minted per HTTP request
 * and therefore absent from every queue worker and webhook delivery, exactly the
 * two places where "which request caused this?" is the question being asked.
 *
 * This is that id, and it is deliberately independent of OpenTelemetry: it always
 * exists, it costs one `AsyncLocalStorage` lookup, and it works with no exporter.
 * When tracing *is* configured the two coincide rather than compete, because the
 * inbound `traceparent` header is parsed here too — so the id in a log line is the
 * same id the collector filed the span under, and the two views join.
 *
 * `AsyncLocalStorage` rather than threading a parameter: a trace id is context,
 * not data. Every function between the route and the query would otherwise need a
 * parameter it does not otherwise care about, and the first one somebody forgets
 * is a gap in the trace that looks like the work never happened.
 */

export interface TraceContext {
  /** A 32-hex-character id, W3C-shaped so it can be reused as an OTel trace id. */
  traceId: string;
  /**
   * The caller's span id, when the request arrived with a `traceparent`.
   *
   * Kept because it is the only record that this work was a continuation of
   * somebody else's — without it a trace that entered from an upstream service
   * looks like it started here.
   */
  parentSpanId?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/**
 * The W3C `traceparent` header, version `00` only.
 *
 * A later version is *not* guessed at. Version `01` and beyond may restructure the
 * fields, and parsing a future header with today's grammar is how a valid trace
 * becomes a corrupt one. An unrecognised version is treated as absent, which means
 * the request gets a fresh id — a lost correlation, never a wrong one.
 */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A fresh 32-hex id. `randomBytes` rather than a counter: ids must not be guessable. */
export function newTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Read a `traceparent` header, or `undefined` if it is absent or malformed.
 *
 * The all-zero trace id and span id are reserved by the specification to mean "no
 * value"; a peer that sends them is asking for no correlation, and treating zeros
 * as a real id would collapse every such request into one trace.
 */
export function parseTraceparent(
  header: string | string[] | undefined
): TraceContext | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;

  const match = TRACEPARENT.exec(value.trim());
  if (!match) return undefined;

  const [, traceId, spanId] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;

  return { traceId, parentSpanId: spanId };
}

/**
 * Run `fn` with `context` as the ambient trace.
 *
 * Passing `undefined` runs `fn` outside any context rather than inventing one, so
 * a caller that has no id to contribute — a timer, a startup task — does not paint
 * unrelated work with a fabricated trace.
 */
export function runWithTrace<T>(context: TraceContext | undefined, fn: () => T): T {
  if (!context) return fn();
  return storage.run(context, fn);
}

export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/** The id alone, which is what almost every caller wants. */
export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}
