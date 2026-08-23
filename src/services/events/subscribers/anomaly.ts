import { recordFailedLogin, recordNewDevice } from "../../anomalyDetection.js";
import type { KeystoneEvent } from "../types.js";

export async function anomalySubscriber(event: KeystoneEvent): Promise<void> {
  if (event.type === "user_login_failed") {
    const identifier = event.payload.userId || event.payload.metadata?.email || event.payload.ip || "unknown";
    await recordFailedLogin(String(identifier));
  }
  if (event.type === "new_device_detected") {
    const userId = event.payload.userId;
    if (userId) await recordNewDevice(userId);
  }
}
