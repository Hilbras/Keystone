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

    queue.process("integration_test", async (job) => {
      received = job.payload;
    });

    await queue.enqueue({ id: "integration-test-1", type: "integration_test", payload });

    // Wait for the worker to pick up the job.
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.deepStrictEqual(received, payload);
    await queue.close();
  });
});
