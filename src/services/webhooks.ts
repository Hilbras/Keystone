import crypto from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { webhookDeliveries, webhookEndpoints, type WebhookEndpoint } from "../db/schema.js";
import { signWebhookPayload } from "../lib/webhookSignature.js";
import { ATTR, SPAN, recordSpan } from "./spans.js";
import { decryptSecret, encryptSecret } from "./totp.js";
import { queue } from "./queue/index.js";
import type { KeystoneEvent } from "./events/types.js";
import { serviceLogger } from "../lib/logger.js";
import { config } from "../config.js";
import { assertSafeWebhookUrl, validateWebhookUrl, OutboundUrlRejected } from "./outboundPolicy.js";

const moduleLog = serviceLogger("webhooks");

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 30_000;

/**
 * How long a `processing` claim is honoured before another worker may take it.
 *
 * Ten minutes against a delivery that times out at ten seconds: a live worker is
 * never reclaimed, and a crashed one is recovered without an operator noticing.
 * A value close to the request timeout would be tighter but would risk reclaiming
 * a slow-but-healthy delivery and double-sending it — the exact failure the claim
 * exists to prevent, reintroduced by making the lease too short.
 */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * How often to sweep for abandoned claims.
 *
 * Shorter than {@link STALE_CLAIM_MS} so a claim is recovered within one lease
 * period of ageing out rather than up to two: the worst case is
 * `STALE_CLAIM_MS + RECLAIM_INTERVAL_MS`, which is the number an operator would
 * have to reason about when asking "how long until a crashed worker's delivery
 * is retried".
 */
const RECLAIM_INTERVAL_MS = 60_000;

/**
 * A stable id for this process, recorded on every claim.
 *
 * Not for mutual exclusion — the database does that — but for the log line an
 * operator reads when a delivery is being retried by nobody. `process.pid` alone
 * is ambiguous across hosts, which is the case that matters.
 */
const WORKER_ID = `${process.env.HOSTNAME ?? "local"}#${process.pid}`;
const workerId = () => WORKER_ID;

/**
 * Turn a consumer's response into something safe to persist.
 *
 * **SEC-079.** This used to be `(await response.text()).slice(0, 2000)` — the
 * first two kilobytes of *whatever the consumer returned*, written to the
 * delivery row and served back by `GET /platform/webhook-deliveries/:id`.
 *
 * The consumer is a third party, and its response is its own data. A webhook
 * pointed at a service that echoes a request — most do, when they are debugging
 * — writes that echo into a table, and an operator with the platform-owner role
 * can read it through the admin API. Two shapes of exposure follow, and the
 * second is the one that is easy to miss:
 *
 * 1. **Cross-tenant.** A delivery is made *to* a tenant's endpoint, but the row
 *    is read by whoever holds the platform role. Content the consumer returned
 *    therefore crosses a boundary the endpoint's owner did not choose.
 * 2. **A durable copy of transient data.** Two kilobytes of a response body is
 *    often a stack trace, a debug dump, or — from a service that reflects the
 *    request — the signed payload and the signature header, persisted in a
 *    database that is backed up, replicated, and readable by anyone with a dump.
 *
 * So by default only the **shape** is kept: the status, the content type, and the
 * byte length. That is what an operator actually needs to answer "is the consumer
 * rejecting us, and is it rejecting us for a reason we can see" — and the answer
 * to a 500 is almost never in the body, it is in the consumer's own logs.
 *
 * `WEBHOOK_DEBUG_CAPTURE_BODY=true` keeps a redacted prefix, for the operator
 * debugging a consumer they control. It is opt-in, it says so in the stored value
 * itself, and it is not a silent capture.
 */
function summariseWebhookResponse(
  status: number,
  contentType: string | null,
  body: string
): string {
  const bytes = Buffer.byteLength(body, "utf8");
  const type = contentType ?? "unknown";
  const summary = `HTTP ${status} · ${type} · ${bytes} bytes`;

  if (!config.WEBHOOK_DEBUG_CAPTURE_BODY) return summary;

  // Even in debug mode the body is truncated, because the column is bounded and a
  // long response would otherwise be silently cut mid-token with no marker.
  const CAPTURE_LIMIT = 512;
  const captured = body.length > CAPTURE_LIMIT ? `${body.slice(0, CAPTURE_LIMIT)}…[truncated]` : body;
  // Control characters are stripped: a consumer can return them, and they turn a
  // stored value into a log-injection vector for anyone tailing the row. The rule
  // is suppressed deliberately and for that reason — stripping control characters
  // is precisely what this line is for, and the escape form is used so the source
  // carries no literal control byte.
  // oxlint-disable-next-line no-control-regex
  const printable = captured.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return `${summary} · body(captured): ${printable}`;
}

/**
 * Make a diagnostic string safe to store in the delivery row.
 *
 * The same two concerns as {@link summariseWebhookResponse}, for the paths that
 * record a *reason* rather than a body: an undici fetch error can carry text
 * influenced by the remote peer, and a policy message is ours but reaches us
 * through a code path an operator may be reading in a terminal. Control characters
 * are stripped so a stored value cannot forge log lines, and the length is
 * bounded so a pathological message cannot fill the column.
 *
 * Not a redaction: these strings describe *our* request failing, which is exactly
 * the distinction an operator needs and which they cannot get from the consumer's
 * own logs. The third-party **body** is the thing that must not be kept, and
 * {@link summariseWebhookResponse} is where that happens.
 */
function sanitiseDiagnostic(value: string): string {
  const LIMIT = 2000;
  // Same deliberate suppression as the response summariser: stripping control
  // characters is the point of this line.
  // oxlint-disable-next-line no-control-regex
  const printable = value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return printable.length > LIMIT ? `${printable.slice(0, LIMIT)}…[truncated]` : printable;
}

/** Record the terminal state of a delivery and drop the claim. */
async function releaseClaim(
  deliveryId: string,
  status: "pending" | "success" | "failed",
  body?: string
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status,
      lastAttemptAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      ...(body === undefined ? {} : { responseBody: sanitiseDiagnostic(body) }),
    })
    .where(eq(webhookDeliveries.id, deliveryId));
}

export type { WebhookEndpoint };

/**
 * Webhook signing secrets are encrypted at rest.
 *
 * Not hashed, which is the more usual answer for a credential, because Keystone
 * *signs* outbound payloads with this secret rather than merely comparing
 * against it. Hashing would make signing impossible; the plaintext has to be
 * recoverable, so recoverable secrets are the ones that must be encrypted.
 *
 * Stored in plaintext, a database dump yielded a working signing key for every
 * endpoint, letting an attacker forge deliveries the receiving service would
 * accept as genuine.
 *
 * Rows written before this change are still plaintext. `decryptSecret` detects
 * the versioned envelope and falls back to returning the value unchanged, so
 * existing endpoints keep verifying without a migration step; re-saving or
 * rotating an endpoint upgrades it.
 */
function encryptWebhookSecret(secret: string): string {
  return encryptSecret(secret);
}

/** Mirrors the envelope prefix used by `encryptSecret`. */
const ENCRYPTED_SECRET_PREFIX = "v2";

/**
 * Read a stored secret, accepting both the encrypted envelope and legacy
 * plaintext.
 *
 * `decryptSecret` cannot be used directly: it throws on anything that is not an
 * encrypted envelope, and the alternative it offers is a legacy *CBC* form, not
 * plaintext. Every webhook secret written before this change is plain, so
 * delegating to it would have thrown on the first delivery for every existing
 * endpoint.
 *
 * So the envelope is detected here and anything else is returned unchanged.
 * A plaintext secret is `whsec_` followed by base64url, which contains neither
 * the `.` of the versioned envelope nor the `:` of the legacy CBC form, so the
 * test is unambiguous.
 */
export function readWebhookSecret(stored: string): string {
  if (stored.startsWith(`${ENCRYPTED_SECRET_PREFIX}.`)) {
    return decryptSecret(stored);
  }
  return stored;
}

export async function listEndpoints(appId?: string) {
  if (appId) {
    return db.select().from(webhookEndpoints).where(eq(webhookEndpoints.appId, appId)).orderBy(webhookEndpoints.createdAt);
  }
  return db.select().from(webhookEndpoints).orderBy(webhookEndpoints.createdAt);
}

export async function createEndpoint(input: {
  appId?: string | null;
  url: string;
  description?: string;
  events?: string[];
}): Promise<WebhookEndpoint & { signingSecret: string }> {
  // Validated before it is stored, not only before it is used. A private address
  // in the column is a row an operator can read back and mistake for a working
  // configuration, and it means the endpoint was accepted by the API that
  // advertises itself as validating it.
  validateWebhookUrl(input.url);
  const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      appId: input.appId ?? null,
      url: input.url,
      description: input.description ?? null,
      events: input.events ?? [],
      // Encrypted at rest; the plaintext is returned exactly once, at creation.
      secret: encryptWebhookSecret(secret),
    })
    .returning();
  return { ...endpoint, signingSecret: secret };
}

export async function updateEndpoint(
  id: string,
  input: Partial<{ url: string; description: string | null; events: string[]; isActive: boolean }>
) {
  // Validated only when the URL is *changing*. Validating unconditionally would
  // make an unrelated `isActive` toggle fail for an endpoint created before this
  // policy existed, which is the wrong trade: the address is not being re-read.
  if (input.url !== undefined) validateWebhookUrl(input.url);
  const [updated] = await db
    .update(webhookEndpoints)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return updated;
}

export async function deleteEndpoint(id: string) {
  const [deleted] = await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).returning();
  return deleted;
}

export async function rotateEndpointSecret(id: string) {
  const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  const [updated] = await db
    .update(webhookEndpoints)
    .set({ secret: encryptWebhookSecret(secret), updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return updated ? { endpoint: updated, signingSecret: secret } : undefined;
}

export async function listDeliveries(endpointId: string, limit = 50) {
  return db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, endpointId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
}

/**
 * Fan an event out to every active endpoint subscribed to it.
 * Each delivery is persisted first, then handed to the queue worker.
 */
export async function dispatchEvent(event: KeystoneEvent): Promise<void> {
  const endpoints = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.isActive, true));

  for (const endpoint of endpoints) {
    // App-scoped endpoints only receive events for their own application.
    if (endpoint.appId && event.payload.appId && endpoint.appId !== event.payload.appId) continue;
    if (endpoint.events.length > 0 && !endpoint.events.includes(event.type)) continue;

    const body = {
      id: crypto.randomUUID(),
      type: event.type,
      version: event.version,
      timestamp: event.timestamp,
      payload: event.payload,
    };

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({ endpointId: endpoint.id, eventType: event.type, payload: body })
      .returning();

    await queue.enqueue({
      type: "webhook-delivery",
      payload: { deliveryId: delivery.id },
    });
  }
}

/**
 * Take exclusive ownership of a delivery, or report that someone else has it.
 *
 * **SEC-078.** `deliverNow` used to `SELECT` the row, act on it, and write the
 * result back — with nothing in between that said "this worker owns it". Two
 * workers holding the same `deliveryId` therefore both sent the payload, and the
 * consumer received the same event twice. A webhook consumer that credits an
 * account once per delivery gets charged twice, and nothing in the system
 * reported it: each worker's own write succeeded, last one winning.
 *
 * The claim is one conditional `UPDATE`, so the decision is made by the database
 * rather than by a read followed by a hope:
 *
 * ```sql
 * UPDATE webhook_deliveries SET status = 'processing', ...
 * WHERE id = ? AND status = 'pending'
 * ```
 *
 * Exactly one caller gets `rowCount = 1`; every other gets 0 and returns. That
 * holds across processes and across machines, which a `SELECT` cannot, and it
 * needs no lock held across the HTTP request — which would be worse, since the
 * request can take ten seconds and a lock held that long blocks the database.
 *
 * `lockedAt` exists so a worker that dies mid-delivery does not strand the row
 * in `processing` forever. See {@link reclaimStaleDeliveries}.
 */
async function claimDelivery(
  deliveryId: string
): Promise<{ delivery: typeof webhookDeliveries.$inferSelect; endpoint: typeof webhookEndpoints.$inferSelect } | null> {
  const now = new Date();
  // A claim older than this is assumed abandoned. Ten minutes is above the
  // delivery timeout (10s) by a wide margin, so a live worker is never reclaimed;
  // a crashed one is recovered without an operator noticing.
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

  const [claimed] = await db
    .update(webhookDeliveries)
    .set({ status: "processing", lockedAt: now, lockedBy: workerId() })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        or(
          eq(webhookDeliveries.status, "pending"),
          // A `processing` row whose lock has expired: a previous attempt died.
          and(
            eq(webhookDeliveries.status, "processing"),
            lt(webhookDeliveries.lockedAt, staleBefore)
          )
        )
      )
    )
    .returning();

  if (!claimed) return null;

  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, claimed.endpointId))
    .limit(1);
  if (!endpoint) return null;
  return { delivery: claimed, endpoint };
}

/**
 * Return deliveries stuck in `processing` to `pending`.
 *
 * The recovery half of the claim. Without it, one crashed worker permanently
 * removes a delivery from the queue: it is neither pending nor failed, so nothing
 * retries it and nothing reports it. Called on worker start and periodically.
 *
 * Exported because the test drives it directly rather than waiting ten minutes for
 * a lock to age out.
 */
export async function reclaimStaleDeliveries(): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  const reclaimed = await db
    .update(webhookDeliveries)
    .set({ status: "pending", lockedAt: null, lockedBy: null })
    .where(
      and(eq(webhookDeliveries.status, "processing"), lt(webhookDeliveries.lockedAt, staleBefore))
    )
    .returning({ id: webhookDeliveries.id });
  return reclaimed.length;
}

export async function deliverNow(deliveryId: string): Promise<void> {
  // **The claim, before any work.** Everything below this line happens only for
  // the one caller that won it; every other caller returns having sent nothing.
  const claim = await claimDelivery(deliveryId);
  if (!claim) return;
  const { delivery, endpoint } = claim;

  if (!endpoint.isActive) {
    await releaseClaim(deliveryId, "failed", "endpoint is inactive");
    return;
  }

  const attempts = delivery.attempts + 1;
  const now = new Date();

  try {
    // Re-checked at delivery, not only at creation. Three reasons this cannot be
    // a creation-time check alone:
    //
    // 1. DNS rebinding — a name that resolved to a public address when the
    //    endpoint was created can resolve to 127.0.0.1 when the delivery runs,
    //    which is the whole point of the attack.
    // 2. Rows written before this policy existed were never validated, and
    //    migrations are not required to fix existing data.
    // 3. The URL is tenant-controlled, so the trust decision belongs as close to
    //    the request as possible.
    await assertSafeWebhookUrl(endpoint.url);

    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keystone-Signature": signWebhookPayload(readWebhookSecret(endpoint.secret), delivery.payload),
        "X-Keystone-Event": delivery.eventType,
        "X-Keystone-Delivery": delivery.id,
      },
      body: JSON.stringify(delivery.payload),
      signal: AbortSignal.timeout(10_000),
    });

    // The span covers the attempt and its outcome, which is what an operator
    // needs when a consumer starts rejecting: which endpoint, which attempt
    // number, and what came back. The HTTP exchange itself is already traced by
    // the auto-instrumentation, so it is not nested again.
    recordSpan(SPAN.webhookDelivery, {
      [ATTR.endpointId]: endpoint.id,
      [ATTR.attempt]: attempts,
      [ATTR.statusCode]: response.status,
      [ATTR.outcome]: response.ok ? "delivered" : "rejected",
    });

    const responseBody = summariseWebhookResponse(
      response.status,
      response.headers.get("content-type"),
      await response.text()
    );
    await db
      .update(webhookDeliveries)
      .set({
        attempts,
        lastAttemptAt: now,
        responseStatus: response.status,
        responseBody,
        status: response.ok ? "success" : "failed",
        // The claim is dropped on every terminal write. Leaving it set would make
        // the row look live to `claimDelivery` for another ten minutes, and
        // `reclaimStaleDeliveries` would eventually return a `success` row to
        // `pending` — re-sending a delivery that already succeeded.
        lockedAt: null,
        lockedBy: null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));

    if (!response.ok && attempts < MAX_ATTEMPTS) {
      await retryLater(deliveryId);
    }
  } catch (err) {
    // A policy rejection is **permanent**: the URL will be refused identically on
    // every future attempt, because nothing about it changes between now and the
    // next retry. So it is recorded as `failed` on the first attempt and no
    // retry is scheduled — five attempts against `169.254.169.254` is five
    // requests a hostile operator asked for, and the retry ladder exists for
    // transient network faults, not for a decision the policy has already made.
    //
    // Distinct from the `catch` below it, which covers a network failure and
    // *does* retry. The two are separated by the error type, not by the message.
    if (err instanceof OutboundUrlRejected) {
      recordSpan(SPAN.webhookDelivery, {
        [ATTR.endpointId]: endpoint.id,
        [ATTR.attempt]: attempts,
        [ATTR.statusCode]: 0,
        [ATTR.outcome]: "url-rejected",
      });
      moduleLog.warn(
        { endpointId: endpoint.id, deliveryId, reason: err.message },
        "webhook delivery refused by outbound URL policy; not retried"
      );
      await db
        .update(webhookDeliveries)
        .set({
          attempts,
          lastAttemptAt: now,
          // The message names the rule, and names no tenant data: the rejected URL
          // is operator-supplied and the policy messages are fixed strings.
          responseBody: sanitiseDiagnostic(`Refused by outbound URL policy: ${err.message}`),
          status: "failed",
          // Drop the claim here too. SEC-075's branch was written before the claim
          // existed, and a row left in `processing` is a row nobody retries — the
          // refusal is terminal, so `pending` is the wrong state for it and
          // `processing` is the wrong one for the same reason.
          lockedAt: null,
          lockedBy: null,
        })
        .where(eq(webhookDeliveries.id, deliveryId));
      return;
    }

    recordSpan(SPAN.webhookDelivery, {
      [ATTR.endpointId]: endpoint.id,
      [ATTR.attempt]: attempts,
      [ATTR.statusCode]: 0,
      [ATTR.outcome]: "unreachable",
    });
    await db
      .update(webhookDeliveries)
      .set({
        attempts,
        lastAttemptAt: now,
        responseBody: sanitiseDiagnostic(err instanceof Error ? err.message : "Delivery error"),
        // `pending` here is what makes the retry possible, so the claim has to go:
        // a `pending` row with a live lock would be claimable only after it went
        // stale, adding ten minutes to every transient network failure.
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        lockedAt: null,
        lockedBy: null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));

    if (attempts < MAX_ATTEMPTS) {
      await retryLater(deliveryId);
    }
  }
}

async function retryLater(deliveryId: string): Promise<void> {
  setTimeout(() => {
    queue.enqueue({ type: "webhook-delivery", payload: { deliveryId } }).catch((err: unknown) => {
      moduleLog.error({ err }, "webhooks");
    });
  }, RETRY_DELAY_MS).unref();
}

/** Manual retry from the dashboard: reset to pending and enqueue. */
export async function retryDelivery(deliveryId: string): Promise<boolean> {
  const [updated] = await db
    .update(webhookDeliveries)
    .set({ status: "pending" })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, "failed")))
    .returning();
  if (!updated) return false;
  await queue.enqueue({ type: "webhook-delivery", payload: { deliveryId } });
  return true;
}

/** Register the delivery worker with the queue. */
export function startWebhookWorker(): void {
  queue.process("webhook-delivery", async (job) => {
    const { deliveryId } = job.payload as { deliveryId: string };
    await deliverNow(deliveryId);
  });

  /**
   * Recover deliveries stranded by a worker that died mid-request.
   *
   * Runs at startup rather than only on a timer, because the case that matters is
   * a **restart**: a process killed while holding claims leaves those rows in
   * `processing`, and without this they are never retried and never reported —
   * not pending, so nothing picks them up; not failed, so nothing surfaces them.
   * The delivery is simply gone.
   *
   * Deliberately not awaited. Startup must not block on a table scan, and a
   * failure here is logged rather than fatal — a recovery pass that cannot run is
   * a reason to complain, not a reason to refuse to boot. `.unref()` so the timer
   * never holds the process open during shutdown.
   *
   * Errors are caught and logged rather than left to become an unhandled
   * rejection. That is the SEC-053 defect in a different place: an unhandled
   * rejection terminates a Node process, and a background recovery timer is
   * exactly the kind of code where a throw nobody awaits goes unnoticed until the
   * service is inexplicably gone.
   */
  const sweep = () => {
    reclaimStaleDeliveries()
      .then((count) => {
        if (count > 0) {
          moduleLog.warn({ count }, "reclaimed webhook deliveries abandoned by a dead worker");
        }
      })
      .catch((err: unknown) => {
        moduleLog.error({ err }, "webhook stale-claim sweep failed");
      });
  };

  sweep();
  const timer = setInterval(sweep, RECLAIM_INTERVAL_MS);
  timer.unref();
}
