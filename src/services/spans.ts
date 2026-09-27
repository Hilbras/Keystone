import { trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";

/**
 * Span names and attribute keys for the four chokepoints.
 *
 * The analysis found that OpenTelemetry was a production dependency, wired into
 * the bootstrap, and instrumenting nothing: `rg -c 'span\(|tracer' src/` returned
 * zero. Every trace was HTTP-and-database auto-instrumentation, which cannot
 * distinguish a correct argon2id cost from a database query in a loop.
 *
 * So the spans live here, in one place, with the names as constants. A span name
 * in a string literal at the call site is a span name a dashboard query and a
 * test can drift from, and a dashboard that has quietly stopped matching is worse
 * than no dashboard.
 */
export const SPAN = {
  /** Every token issuance, whatever the flow. */
  tokenIssuance: "keystone.token.issue",
  /** Refresh token rotation, including replay detection. */
  tokenRotation: "keystone.token.rotate",
  /** SCIM group membership reconcile. */
  scimGroupReconcile: "keystone.scim.group.reconcile",
  /** Webhook payload signing, and delivery attempts. */
  webhookDelivery: "keystone.webhook.deliver",
} as const;

export const ATTR = {
  flow: "keystone.flow",
  outcome: "keystone.outcome",
  /** Does the account have a second factor enrolled. A property of the user. */
  mfaEnabled: "keystone.mfa_enabled",
  /** Was a factor presented for this login. A property of this issuance. */
  mfaSatisfied: "keystone.mfa_satisfied",
  mfaFactor: "keystone.mfa_factor",
  clientId: "keystone.client_id",
  rotated: "keystone.rotated",
  groupId: "keystone.group_id",
  submitted: "keystone.members_submitted",
  added: "keystone.members_added",
  removed: "keystone.members_removed",
  endpointId: "keystone.webhook_endpoint_id",
  attempt: "keystone.attempt",
  statusCode: "keystone.status_code",
  durationMs: "keystone.duration_ms",
} as const;

/**
 * The tracer, resolved once and reused.
 *
 * `trace.getTracer` returns a proxy that forwards to whichever provider is
 * registered, so taking it before the SDK starts is fine — the provider only has
 * to be in place by the time a span is *created*, not by the time the tracer is.
 *
 * (This was worth checking rather than assuming. The first version of the
 * chokepoint test failed with zero spans, and the tracer was the obvious suspect.
 * It was not the tracer: `startTracing` accepted a bare `traceExporter`, which the
 * NodeSDK wraps in a BatchSpanProcessor that flushes on a timer. Nothing was
 * broken except the test, and a broken test for the wrong reason is the kind of
 * thing that gets "fixed" by deleting the assertion.)
 */
let cached: Tracer | undefined;

export function getTracer(): Tracer {
  cached ??= trace.getTracer("keystone", "3.1.0");
  return cached;
}

/**
 * Record a one-shot span describing a decision.
 *
 * Used where the interesting signal is the *outcome* rather than the work — a
 * rotation that was refused, a webhook a consumer rejected. The surrounding
 * queries and HTTP exchanges are already covered by the postgres and undici
 * auto-instrumentation, so wrapping them would add a layer of nesting without
 * adding a fact.
 */
export function recordSpan(
  name: string,
  attributes: Record<string, string | number | boolean>
): Span {
  const span = getTracer().startSpan(name, { attributes });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
  return span;
}

/**
 * Run `fn` inside a span, recording its duration and outcome.
 *
 * Used where the work itself is the thing worth timing — the SCIM reconcile,
 * where a large group push is a realistic workload and the duration is the
 * question an operator is trying to answer.
 *
 * Both helpers are no-ops when the SDK is not started, which is the normal case
 * in development and in tests that do not care. So instrumenting a hot path costs
 * a tracer lookup and an allocation, and never requires an exporter to exist.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes }, async (span) => {
    const started = Date.now();
    try {
      const result = await fn(span);
      span.setAttribute(ATTR.durationMs, Date.now() - started);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setAttribute(ATTR.durationMs, Date.now() - started);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
