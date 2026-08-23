import { config } from "../../config.js";
import { InProcessQueue } from "./inProcess.js";
import { BullMQQueue } from "./bullmq.js";
import type { Queue } from "./types.js";

export * from "./types.js";
export { InProcessQueue } from "./inProcess.js";
export { BullMQQueue } from "./bullmq.js";

export function createQueue(): Queue {
  const explicitProvider = config.KEYSTONE_QUEUE_PROVIDER;
  if (explicitProvider === "in-process") return new InProcessQueue();
  if (explicitProvider === "bullmq") return new BullMQQueue(config.REDIS_URL);
  // Default to bullmq when Redis is available, otherwise fall back to in-process.
  if (config.REDIS_URL) return new BullMQQueue(config.REDIS_URL);
  return new InProcessQueue();
}

export const queue = createQueue();
