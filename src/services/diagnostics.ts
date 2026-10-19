import { hostname } from "node:os";
import { config } from "../config.js";
import { buildReadinessReport, type ReadinessReport } from "./health.js";
import { buildStartupReport } from "./startup.js";
import { WORKER_ID, HEARTBEAT_INTERVAL_MS, DEFAULT_CONCURRENCY } from "./queue/workerIdentity.js";
import { getPublicJwks } from "./tokens.js";
import { scrubDriverErrorText } from "../lib/logSanitizer.js";
import type { Queue } from "./queue/types.js";
import type { SecretsProvider } from "./secrets/provider.js";

/**
 * §5.5: what an operator can find out about a running instance without a debugger.
 *
 * The requirement names six things — database, Redis, queue, worker, key and
 * configuration status — and the value of putting them behind one endpoint is that
 * they are read *at the same moment*. Diagnosis is the act of comparing readings:
 * "Redis went down at 14:02, the queue stopped draining at 14:02, and the workers
 * were fine" is a conclusion nobody reaches from three screens refreshed by hand.
 *
 * ## What is not here, and why that is the design
 *
 * Every field below is a status, a count, an identifier that is already public
 * (`kid`), or a configuration value that is a boolean or an enum. Nothing is
 * echoed from the environment. That rule is not about this endpoint being
 * unreachable — it is owner-only — but about where diagnostics end up: a
 * diagnostic endpoint is pasted into issues, attached to incidents and rendered in
 * dashboards, and a connection string travels with it. `secretsProvider.name`
 * rather than its configuration, `kid` rather than key material, and a scrubbed
 * error message rather than the message itself.
 *
 * The ready-made probe in `services/health.ts` is reused rather than re-implemented,
 * so this page cannot report a database that `/ready` calls unhealthy.
 */

export interface DiagnosticsReport {
  instance: {
    workerId: string;
    hostname: string;
    pid: number;
    uptimeSeconds: number;
    startedAt: string;
  };
  startup: ReturnType<typeof buildStartupReport>;
  dependencies: ReadinessReport;
  queue: {
    provider: string;
    configuredProvider: string | undefined;
    concurrency: number;
    heartbeatIntervalMs: number;
    backlog: { waiting: number; failed: number; delayed: number } | null;
    error?: string;
  };
  keys: {
    provider: string;
    /** Public identifiers and dates only — never key material. */
    active: Array<{ keyId: string; createdAt: string; expiresAt: string | null }>;
    count: number;
    /**
     * The `kid`s this process actually serves from `/.well-known/jwks.json`.
     *
     * Reported next to `active` because the two can differ, and the difference is
     * the diagnosis. `active` is what the *secrets provider* holds; `published` is
     * what this process signs with and hands to verifiers. They come from different
     * places on purpose — `loadSigningKeys` prefers `JWT_PRIVATE_KEY` in the
     * environment and never consults the database when it is set — so a deployment
     * that has both configured has a set of database keys that nothing uses, and a
     * rotation performed through `/platform/keys/rotate` that changed nothing. One
     * response showing both lists is the shortest path to seeing that.
     */
    published: string[];
    error?: string;
  };
  configuration: { environment: string; logLevel: string; warnings: string[] };
}

/**
 * Configuration facts that are safe to publish, plus the ones that are *wrong*.
 *
 * A warning list rather than a value dump: the question an operator has at 3am is
 * "is this instance configured the way I think it is", and the answer is the
 * handful of settings that differ between a working deployment and a broken one.
 *
 * This is the read-only half of §6.1, which is where the same checks move to
 * startup and become fatal-or-loud. Doing it here first is deliberate: a validator
 * that refuses to boot is only trustworthy once the conditions it refuses on have
 * been visible in the running system for a release.
 */
function configurationSummary(): DiagnosticsReport["configuration"] {
  const warnings: string[] = [];

  if (config.NODE_ENV === "production") {
    if (!config.REDIS_URL) {
      warnings.push(
        "no REDIS_URL: the queue is in-process and the rate limiter is per-instance, so a second instance would not share either"
      );
    }
    if (config.KEYSTONE_QUEUE_PROVIDER === "in-process") {
      warnings.push(
        "KEYSTONE_QUEUE_PROVIDER is in-process in production: background work does not survive a restart and is not shared between instances"
      );
    }
  }

  return {
    environment: config.NODE_ENV,
    logLevel: config.LOG_LEVEL ?? (config.NODE_ENV === "production" ? "info" : "debug"),
    warnings,
  };
}

export async function buildDiagnosticsReport(
  queue: Queue,
  secrets: SecretsProvider
): Promise<DiagnosticsReport> {
  const dependencies = await buildReadinessReport();

  const queueReport: DiagnosticsReport["queue"] = {
    provider: queue.provider,
    configuredProvider: config.KEYSTONE_QUEUE_PROVIDER,
    concurrency: config.QUEUE_CONCURRENCY ?? DEFAULT_CONCURRENCY,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    backlog: null,
  };
  try {
    const stats = queue.getStats ? await queue.getStats() : [];
    // The drivers summarise every type into one row; a driver that reported per
    // type would be summed here rather than reported as a list, because the
    // question is "is work piling up", not "which type".
    queueReport.backlog = stats.reduce(
      (totals, row) => ({
        waiting: totals.waiting + row.count,
        failed: totals.failed + (row.failed ?? 0),
        delayed: totals.delayed + (row.delayed ?? 0),
      }),
      { waiting: 0, failed: 0, delayed: 0 }
    );
  } catch (err) {
    // Redis unreachable, most likely — which is itself the answer, and is reported
    // instead of failing the whole page. A diagnostics endpoint that goes down with
    // the thing it is diagnosing is useless exactly when it is needed.
    queueReport.error = err instanceof Error ? scrubDriverErrorText(err.message) : String(err);
  }

  const keysReport: DiagnosticsReport["keys"] = {
    provider: secrets.name,
    active: [],
    count: 0,
    published: [],
  };
  try {
    // `keyId` and `createdAt`, never key material. The public half is already
    // served from `/.well-known/jwks.json`, and the private half must not be
    // reachable from anywhere — least of all from a page that gets pasted into a
    // ticket.
    const keys = await secrets.listActiveSigningKeys();
    keysReport.active = keys.map((key) => ({
      keyId: key.keyId,
      createdAt: key.createdAt.toISOString(),
      expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
    }));
    keysReport.count = keys.length;
    keysReport.published = (await getPublicJwks()).keys
      .map((key) => key.kid)
      .filter((kid): kid is string => typeof kid === "string");
  } catch (err) {
    keysReport.error = err instanceof Error ? scrubDriverErrorText(err.message) : String(err);
  }

  return {
    instance: {
      workerId: WORKER_ID,
      hostname: hostname(),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    startup: buildStartupReport(),
    dependencies,
    queue: queueReport,
    keys: keysReport,
    configuration: configurationSummary(),
  };
}
