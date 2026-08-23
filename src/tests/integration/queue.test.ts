import { describe, it } from "node:test";
import assert from "node:assert";
import net from "node:net";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://hilbras:hilbras@localhost:5432/hilbras";

function redisReachable(host = "localhost", port = 6379): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const redisAvailable = await redisReachable();
const { BullMQQueue } = await import("../../services/queue/bullmq.js");

describe("Background job queue", () => {
  (redisAvailable ? it : it.skip)("processes a job through BullMQ", async () => {
    const queue = new BullMQQueue(process.env.REDIS_URL || "redis://localhost:6379");
    const payload = { hello: "world" };
    let received: unknown;
    const processed = new Promise<void>((resolve) => {
      queue.process("integration_test", async (job) => {
        received = job.payload;
        resolve();
      });
    });

    try {
      await queue.enqueue({ id: `integration-test-${Date.now()}`, type: "integration_test", payload });

      // Wait for the worker to pick up the job, bounded by a timeout so a slow
      // or dead worker fails the test instead of hanging the process.
      await Promise.race([
        processed,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);

      assert.deepStrictEqual(received, payload);
    } finally {
      // Always release the worker + Redis connection, even on assertion failure,
      // or open handles keep the node:test process alive indefinitely.
      await queue.close();
    }
  });
});
