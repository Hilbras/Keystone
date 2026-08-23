import { config } from "../../../config.js";
import { queue } from "../../queue/index.js";
import { signWebhookPayload } from "../../../lib/webhookSignature.js";
import type { KeystoneEvent } from "../types.js";

function shouldEmit(): boolean {
  return Boolean(config.AUDIT_WEBHOOK_URL || process.env.AUDIT_WEBHOOK_URL || config.AUDIT_CONSOLE_EXPORT === "true");
}

export async function webhookSubscriber(event: KeystoneEvent): Promise<void> {
  if (!shouldEmit()) return;
  const record = {
    event: event.type,
    version: event.version,
    userId: event.payload.userId,
    orgId: event.payload.orgId,
    appId: event.payload.appId,
    ip: event.payload.ip,
    userAgent: event.payload.userAgent,
    metadata: event.payload.metadata,
    createdAt: event.timestamp,
  };

  if (config.AUDIT_CONSOLE_EXPORT === "true") {
    console.log("[audit-export]", JSON.stringify(record));
  }

  const webhookUrl = config.AUDIT_WEBHOOK_URL || process.env.AUDIT_WEBHOOK_URL;
  if (webhookUrl) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.WEBHOOK_SIGNING_SECRET) {
      headers["X-Keystone-Signature"] = signWebhookPayload(config.WEBHOOK_SIGNING_SECRET, record);
    }
    await queue.enqueue({
      type: "webhook",
      payload: { url: webhookUrl, method: "POST", body: record, headers },
    });
  }
}
