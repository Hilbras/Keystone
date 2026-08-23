import type { KeystoneEvent, EventHandler, EventPayload } from "./types.js";
import { normalizeEvent } from "./validate.js";

const subscribers = new Map<string, EventHandler[]>();
const allSubscribers: EventHandler[] = [];

export function subscribe(eventType: string, handler: EventHandler): () => void {
  const list = subscribers.get(eventType) ?? [];
  list.push(handler);
  subscribers.set(eventType, list);
  return () => {
    const updated = subscribers.get(eventType)?.filter((h) => h !== handler) ?? [];
    subscribers.set(eventType, updated);
  };
}

export function subscribeAll(handler: EventHandler): () => void {
  allSubscribers.push(handler);
  return () => {
    const idx = allSubscribers.indexOf(handler);
    if (idx >= 0) allSubscribers.splice(idx, 1);
  };
}

export type EmittableEvent = Omit<KeystoneEvent, "timestamp" | "version"> & { version?: number };

export async function emit(event: EmittableEvent): Promise<void> {
  const fullEvent = normalizeEvent(event);
  const handlers = [...allSubscribers, ...(subscribers.get(fullEvent.type) ?? [])];
  await Promise.all(
    handlers.map(async (handler) => {
      try {
        await handler(fullEvent);
      } catch (err) {
        console.error(`[event-bus] handler failed for ${fullEvent.type}:`, err);
      }
    })
  );
}

export function buildEvent(type: string, payload: EventPayload): EmittableEvent {
  return { type, payload };
}
