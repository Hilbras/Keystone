import { dispatchEvent } from "../../webhooks.js";
import type { KeystoneEvent } from "../types.js";
import { serviceLogger } from "../../../lib/logger.js";

const moduleLog = serviceLogger("events");

/**
 * Fans every platform event out to registered webhook endpoints.
 * Delivery itself happens asynchronously via the queue worker.
 */
export async function webhookDispatchSubscriber(event: KeystoneEvent): Promise<void> {
  try {
    await dispatchEvent(event);
  } catch (err) {
    moduleLog.error({ err }, "events");
  }
}
