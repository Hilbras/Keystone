import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { config } from "../config.js";

let sdk: NodeSDK | undefined;

export function startTracing(): void {
  if (sdk) return;
  if (config.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    sdk = new NodeSDK({
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
  }
}

export async function stopTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = undefined;
  }
}
