import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { config } from "../config.js";

let sdk: NodeSDK | undefined;

export interface StartTracingOptions {
  /**
   * Override how spans are processed.
   *
   * Exists so a test can assert that the chokepoint spans are *actually created*,
   * rather than asserting that a `startSpan` call exists in the source. The
   * analysis found zero spans in a codebase that had the OpenTelemetry dependency,
   * was wired into the bootstrap, and looked instrumented — a source-level
   * assertion would have passed on that codebase too.
   *
   * Span *processors*, not an exporter, on purpose: the NodeSDK wraps a bare
   * `traceExporter` in a BatchSpanProcessor, which only flushes on its export
   * interval. A test that passed an exporter and asserted immediately would see
   * nothing, and would pass on a build where the instrumentation did not exist
   * either. A test supplies a synchronous processor and sees exactly the spans
   * that were created.
   */
  spanProcessors?: unknown[];
  /** Auto-instrumentation is skipped when only the span plumbing is under test. */
  autoInstrument?: boolean;
}

export function startTracing(options: StartTracingOptions = {}): void {
  if (sdk) return;
  const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint && !options.spanProcessors) return;
  sdk = new NodeSDK({
    spanProcessors: options.spanProcessors as never,
    instrumentations: options.autoInstrument === false ? [] : [getNodeAutoInstrumentations()],
  });
  sdk.start();
}

export async function stopTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = undefined;
  }
}
