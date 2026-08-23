import { describe, it } from "node:test";
import assert from "node:assert";
import { validateEvent, normalizeEvent } from "../services/events/validate.js";
import { emit, subscribe, buildEvent } from "../services/events/bus.js";

describe("Event validation", () => {
  it("accepts a valid event", () => {
    const result = validateEvent(buildEvent("user_login", { userId: "1" }));
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  it("rejects an unknown event type", () => {
    const result = validateEvent(buildEvent("unknown_event", {}));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("Unknown event type")));
  });

  it("rejects a missing payload", () => {
    const result = validateEvent({ type: "user_login" } as never);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("payload")));
  });

  it("rejects an invalid version", () => {
    const result = validateEvent({ type: "user_login", version: 0, payload: {} } as never);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("version")));
  });

  it("normalizes an event with version and timestamp", () => {
    const event = normalizeEvent(buildEvent("user_login", { userId: "1" }));
    assert.strictEqual(event.type, "user_login");
    assert.strictEqual(event.version, 1);
    assert.ok(event.timestamp instanceof Date);
  });
});

describe("Event bus", () => {
  it("delivers emitted events to subscribers", async () => {
    const received: unknown[] = [];
    const unsubscribe = subscribe("user_login", (event) => {
      received.push(event.payload);
    });

    await emit(buildEvent("user_login", { userId: "42" }));
    unsubscribe();

    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual((received[0] as { userId: string }).userId, "42");
  });
});
