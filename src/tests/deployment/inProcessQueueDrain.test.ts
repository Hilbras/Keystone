import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.KEYSTONE_QUEUE_PROVIDER = "in-process";

const { InProcessQueue } = await import("../../services/queue/inProcess.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * §6.3. The in-process driver's `close()` cleared the handler map and returned.
 * Work that was already running kept running, un-awaited, and a retry timer fired
 * into an empty map and was dropped as "no handler registered" — which reads like a
 * configuration bug rather than a shutdown.
 */
describe("in-process queue drain", () => {
  it("waits for a handler that is already running", async () => {
    const queue = new InProcessQueue();
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = false;

    queue.process("slow", async () => {
      started();
      await sleep(40);
      finished = true;
    });

    await queue.enqueue({ type: "slow", payload: {} });
    await startedPromise;
    await queue.close();

    assert.equal(finished, true, "close() must not resolve before the handler does");
  });

  it("drops a retry that was scheduled before shutdown", async () => {
    const queue = new InProcessQueue();
    let attempts = 0;
    let firstFailed: () => void = () => {};
    const firstFailure = new Promise<void>((resolve) => {
      firstFailed = resolve;
    });

    queue.process("flaky", async () => {
      attempts += 1;
      firstFailed();
      throw new Error("transient");
    });

    await queue.enqueue({ type: "flaky", payload: {} });
    await firstFailure;
    // Let the failure path schedule its retry (1s for attempt 1).
    await sleep(20);
    await queue.close();
    await sleep(1100);

    assert.equal(attempts, 1, "a retry timer must not fire after close()");
  });

  it("is live again once a handler is registered", async () => {
    const queue = new InProcessQueue();
    await queue.close();

    let ran = false;
    queue.process("again", async () => {
      ran = true;
    });
    await queue.enqueue({ type: "again", payload: {} });
    await sleep(20);

    // Registering a handler is what makes a queue live, so `close()` is a drain
    // point rather than a tombstone that breaks a re-initialised container.
    assert.equal(ran, true);
  });
});
