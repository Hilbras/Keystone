import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "trace-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.LOGIN_MAX_ATTEMPTS ||= "1000";
// The collector below is `http://127.0.0.1`, which the webhook transport policy
// refuses by default. Both switches are the documented opt-in (§1.1, §1.2).
process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "true";
process.env.KEYSTONE_ALLOW_INSECURE_WEBHOOK = "localhost";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { migrationsFolder } = await import("../../lib/paths.js");
const { encryptSecret } = await import("../../services/totp.js");
const { organizations, webhookEndpoints, webhookDeliveries } = await import("../../db/schema.js");
const { deliverNow } = await import("../../services/webhooks.js");
const { currentTraceId, newTraceId, parseTraceparent, runWithTrace } = await import(
  "../../lib/traceContext.js"
);
const { redis } = await import("../../services/redis.js");

/**
 * §5.4 — one id that follows work across the process boundary.
 *
 * The claim is not "a trace id exists" but "the same id is visible in the request,
 * in a job it enqueued, and in the webhook that job delivered". Each of those is a
 * different execution context, and the middle one is a different tick of the event
 * loop at best and a different process at worst — which is exactly where a
 * context-propagation bug hides, because every unit in isolation still looks right.
 *
 * So the assertions follow one id end to end: `HTTP request → job → delivery
 * header`. A test that asserted only the response header would pass on a build
 * where the job carried nothing.
 *
 * The probe route is registered here rather than in `src/` because it exists to
 * enqueue a job from inside a request and hand back the id it saw — there is no
 * application operation whose only job is to prove the plumbing works, and adding
 * one to the public API to test it would be worse than a test-only route.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
let app: FastifyInstance;
let collector: http.Server;
let collectorUrl: string;
let received: http.IncomingHttpHeaders[];
const createdOrgIds: string[] = [];
const createdEndpointIds: string[] = [];

/** Written by the probe job's handler, read by the assertion that follows it. */
const seen: { jobTraceId?: string; handlerTraceId?: string } = {};

const HEX32 = /^[0-9a-f]{32}$/;

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();

  app.post("/__trace_probe", async (request) => {
    const ambient = currentTraceId();
    await app.container.queue.enqueue({ type: "__trace_probe", payload: { run: RUN_ID } });
    return { requestTraceId: request.traceId, ambientTraceId: ambient };
  });

  await app.ready();

  app.container.queue.process("__trace_probe", (job) => {
    seen.jobTraceId = job.traceId;
    seen.handlerTraceId = currentTraceId();
  });

  collector = http.createServer((req, res) => {
    received.push(req.headers);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const { port } = collector.address() as AddressInfo;
  collectorUrl = `http://127.0.0.1:${port}/hook`;
});

after(async () => {
  // `fetch` keeps its sockets alive by default, and `server.close()` waits for every
  // open connection — so without this the teardown waits out the keep-alive timeout
  // and a suite that has already finished its assertions sits there looking hung.
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
  for (const id of createdEndpointIds) {
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).catch(() => {});
  }
  for (const id of createdOrgIds) {
    await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
  }
  await app?.close();
  await closeDb().catch(() => {});
  // The queue's worker holds a Redis connection of its own. Closed explicitly, last,
  // so nothing the runner is still draining can re-open it.
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

beforeEach(() => {
  received = [];
  // The probe handler is asynchronous — it runs on a later tick than the response
  // it was enqueued from — so a previous case's job can still be in flight. Clearing
  // here is not enough on its own; the wait below also matches the *expected* id
  // rather than merely "something arrived", which is what makes a late job from the
  // previous case harmless instead of a wrong answer.
  seen.jobTraceId = undefined;
  seen.handlerTraceId = undefined;
});

async function seedDelivery(payload: unknown): Promise<string> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const [org] = await db
    .insert(organizations)
    .values({ name: "Trace Org", slug: `trace-${suffix}` })
    .returning();
  createdOrgIds.push(org.id);
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      url: collectorUrl,
      events: ["user.login"],
      isActive: true,
      secret: encryptSecret(`whsec_${crypto.randomBytes(24).toString("base64url")}`),
    })
    .returning();
  createdEndpointIds.push(endpoint.id);
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({ endpointId: endpoint.id, eventType: "user.login", payload })
    .returning();
  return delivery.id;
}

describe("§5.4 trace context", () => {
  describe("parseTraceparent", () => {
    it("accepts a well-formed version 00 header", () => {
      const traceId = "a".repeat(32);
      const parsed = parseTraceparent(`00-${traceId}-${"b".repeat(16)}-01`);
      assert.equal(parsed?.traceId, traceId);
      assert.equal(parsed?.parentSpanId, "b".repeat(16));
    });

    it("refuses a version it does not understand rather than guessing at the fields", () => {
      // A future version may restructure the header. Parsing it with today's
      // grammar would produce a plausible-looking id that matches nothing.
      assert.equal(parseTraceparent(`01-${"a".repeat(32)}-${"b".repeat(16)}-01`), undefined);
    });

    it("treats the reserved all-zero ids as absent", () => {
      // The spec uses zeros to mean "no value". Accepting them would collapse every
      // such request into a single trace.
      assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`), undefined);
      assert.equal(parseTraceparent(`00-${"a".repeat(32)}-${"0".repeat(16)}-01`), undefined);
    });

    it("refuses malformed input instead of salvaging something from it", () => {
      for (const bad of ["", "garbage", "00-short-${x}-01", `00-${"a".repeat(32)}-${"b".repeat(16)}`]) {
        assert.equal(parseTraceparent(bad), undefined, `${JSON.stringify(bad)} should not parse`);
      }
    });

    it("takes the first value when the header arrived more than once", () => {
      const traceId = "c".repeat(32);
      assert.equal(
        parseTraceparent([`00-${traceId}-${"d".repeat(16)}-01`, "00-zzz-zzz-01"])?.traceId,
        traceId
      );
    });
  });

  describe("over HTTP", () => {
    it("mints an id and returns it on the response when none was supplied", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/__trace_probe",
        payload: {},
      });
      assert.equal(response.statusCode, 200);
      const header = response.headers["trace-id"];
      assert.ok(typeof header === "string" && HEX32.test(header), `bad trace-id: ${String(header)}`);
      assert.equal(response.json().requestTraceId, header);

      // The route reads the id out of the ambient context, which is what every
      // service and repository below it would see. If only `request.traceId` were
      // set, the header would be right and every log line downstream would not.
      assert.equal(
        response.json().ambientTraceId,
        header,
        "the id must be ambient inside the handler, not just attached to the request"
      );
    });

    it("adopts an inbound traceparent so an upstream trace continues here", async () => {
      const traceId = "e".repeat(32);
      const response = await app.inject({
        method: "POST",
        url: "/__trace_probe",
        payload: {},
        headers: { traceparent: `00-${traceId}-${"f".repeat(16)}-01` },
      });
      assert.equal(response.headers["trace-id"], traceId, "the caller's trace id must be kept");
      assert.equal(response.json().requestTraceId, traceId);
    });

    it("issues a fresh id when the inbound header is unusable", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/__trace_probe",
        payload: {},
        headers: { traceparent: "not-a-traceparent" },
      });
      const header = response.headers["trace-id"];
      assert.ok(typeof header === "string" && HEX32.test(header));
      assert.notEqual(header, "not-a-traceparent");
    });

    it("carries the id into the job the request enqueued, and into the handler", async () => {
      const traceId = "1".repeat(32);
      const response = await app.inject({
        method: "POST",
        url: "/__trace_probe",
        payload: {},
        headers: { traceparent: `00-${traceId}-${"2".repeat(16)}-01` },
      });
      assert.equal(response.headers["trace-id"], traceId);

      assert.ok(
        await waitFor(() => seen.handlerTraceId === traceId),
        `the job never ran inside trace ${traceId}`
      );
      assert.equal(seen.jobTraceId, traceId, "the job must carry the enqueueing request's trace id");
      // The handler's own ambient id — what a log line it emits would carry.
      assert.equal(seen.handlerTraceId, traceId, "the handler must run inside that trace");
    });
  });

  describe("over a webhook delivery", () => {
    it("sends the trace id as a header", async () => {
      const deliveryId = await seedDelivery({ id: crypto.randomUUID(), type: "user.login", payload: {} });
      const traceId = newTraceId();

      await runWithTrace({ traceId }, () => deliverNow(deliveryId));

      assert.equal(received.length, 1, "the delivery must have been sent");
      assert.equal(received[0]!["x-keystone-trace-id"], traceId);
    });

    it("omits the header when the delivery has no cause", async () => {
      // A recovery pass or a manual admin retry has no originating request. An empty
      // header would be indistinguishable from a truncated one, so it is not sent.
      const deliveryId = await seedDelivery({ id: crypto.randomUUID(), type: "user.login", payload: {} });

      await deliverNow(deliveryId);

      assert.equal(received.length, 1);
      assert.equal(received[0]!["x-keystone-trace-id"], undefined);
    });
  });
});
