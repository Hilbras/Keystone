#!/usr/bin/env node
/**
 * Write `docs/dashboards/authentication.json` — a Grafana dashboard that answers
 * "is authentication healthy" without a log search.
 *
 * §5.1's closing line: *"a dashboard answers 'is authentication healthy' without a
 * log search."* The series are only half of that; the other half is somebody
 * assembling them under time pressure at 3am, which is exactly when assembling them
 * is least likely to happen. So the dashboard is a file, generated rather than
 * hand-drawn, and the generator fails if a panel names a series that does not
 * exist.
 *
 * That last part is the gate. A dashboard is the one artefact in this repository
 * that nobody runs, so a renamed series leaves it pointing at nothing and it fails
 * silently — a panel with no data looks exactly like a panel with no incidents.
 * Checking every series name in the file against the live registry means the
 * breakage is a build failure instead of a blank graph at 3am.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "prom-client";

// The app is imported for its side effect of registering the series, so the
// comparison below is against the real set rather than a list kept in step by hand.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:5432/unused";
process.env.KEYSTONE_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef";
await import(path.join(root, "dist/plugins/operationalMetrics.js"));
await import(path.join(root, "dist/plugins/metrics.js"));

const registered = new Set(
  (await register.metrics())
    .split("\n")
    .filter((line) => line.startsWith("# TYPE "))
    .map((line) => line.split(/\s+/)[2])
    .filter((name) => name?.startsWith("keystone_"))
);

const panel = (title, description, targets, unit, thresholds) => ({
  title,
  description,
  type: targets.some((t) => t.expr.includes("rate(")) || targets.some((t) => t.expr.includes("quantile")) ? "timeseries" : "stat",
  unit,
  targets: targets.map((t) => ({ expr: t.expr, legendFormat: t.legend })),
  fieldConfig: {
    defaults: {
      unit,
      ...(thresholds
        ? {
            thresholds: {
              mode: "absolute",
              steps: thresholds.map((value, i) => ({ value, color: ["green", "yellow", "red"][i] ?? "red" })),
            },
          }
        : {}),
    },
    overrides: [],
  },
  options: { legend: { displayMode: "list", placement: "bottom", showLegend: true } },
});

const series = [
  {
    title: "Authentication outcomes",
    description:
      "Every login attempt, by outcome and reason. A rise in invalid_credentials is a " +
      "spray; a rise in mfa_failed is a user with a broken second factor; a rise in " +
      "rate_limited is a client with a bug. One undifferentiated failure count answers " +
      "none of those.",
    unit: "short",
    targets: [
      { expr: 'sum by (outcome, reason) (rate(keystone_authentication_attempts_total[5m]))', legend: "{{outcome}} / {{reason}}" },
    ],
  },
  {
    title: "Failed logins per second",
    description: "The alertable shape of the panel above.",
    unit: "reqps",
    targets: [
      {
        expr: 'sum(rate(keystone_authentication_attempts_total{outcome="failure"}[5m]))',
        legend: "failures",
      },
    ],
  },
  {
    title: "Token operations",
    description:
      "Issuance, rotation, and replays. A replay means a credential leaked and somebody " +
      "came back with it — the single most security-relevant line on this dashboard.",
    unit: "short",
    targets: [
      { expr: 'sum by (operation, outcome) (rate(keystone_token_operations_total[5m]))', legend: "{{operation}} / {{outcome}}" },
    ],
  },
  {
    title: "Replays detected",
    description: "Alert on any sustained non-zero value.",
    unit: "short",
    targets: [{ expr: 'increase(keystone_token_operations_total{operation="replay"}[15m])', legend: "replays / 15m" }],
  },
  {
    title: "Redis unavailable to the rate limiter",
    description:
      "Every rate-limit check that could not reach Redis. The global limiter has no " +
      "emergency fallback, so a non-zero value here means the **global rate limit is " +
      "not being applied at all**.",
    unit: "short",
    targets: [
      { expr: 'sum by (key_prefix) (rate(keystone_rate_limit_redis_errors_total[5m]))', legend: "{{key_prefix}}" },
    ],
  },
  {
    title: "Emergency local limiter engaged",
    description:
      "Rate limiting has fallen back to per-process budgets, so **it is no longer shared " +
      "across the fleet** — the exact weakness the distributed limiter exists to remove. " +
      "`allowed` is the one to watch: denials are visible to users, allowances are " +
      "invisible and are what hide the degradation.",
    unit: "short",
    targets: [
      { expr: 'sum by (key_prefix, outcome) (rate(keystone_emergency_local_limiter_total[5m]))', legend: "{{key_prefix}} / {{outcome}}" },
    ],
  },
  {
    title: "Outbound deliveries",
    description: "SCIM provisioning and webhook delivery, by outcome.",
    unit: "short",
    targets: [{ expr: 'sum by (kind, outcome) (rate(keystone_deliveries_total[5m]))', legend: "{{kind}} / {{outcome}}" },
    ],
  },
  {
    title: "Delivery latency, p95",
    description: "Which consumer is slow, rather than that something is.",
    unit: "s",
    targets: [
      { expr: 'histogram_quantile(0.95, sum by (le, kind) (rate(keystone_delivery_duration_seconds_bucket[5m])))', legend: "{{kind}} p95" },
    ],
  },
  {
    title: "Dependency state",
    description:
      "Straight from `/ready`. `1` is healthy, `0` is not, so this reads as a health " +
      "column rather than a graph. `degraded` means Redis is down and the queue is " +
      "in-process — authentication still works, which is why `/ready` answers 200.",
    unit: "short",
    targets: [
      { expr: 'max(keystone_dependency_up{database="postgres"})', legend: "postgres" },
      { expr: 'max(keystone_dependency_up{redis="redis"})', legend: "redis" },
    ],
  },
];

const missing = new Set();
for (const p of series) {
  for (const t of p.targets) {
    for (const name of t.expr.match(/keystone_[a-z_]+/g) ?? []) {
      // A histogram's scrape publishes `_bucket`, `_sum` and `_count` alongside
      // the base name that is registered. Checking the suffixed name against the
      // registry reports a metric that does exist, which is the same class of false
      // report as the two this gate produced on its first run.
      const base = name.replace(/_(bucket|sum|count)$/, "");
      if (!registered.has(name) && !registered.has(base)) missing.add(name);
    }
  }
}
if (missing.size > 0) {
  console.error(
    `the dashboard names series that are not registered: ${[...missing].sort().join(", ")}\n` +
      `  registered: ${[...registered].sort().join(", ")}`
  );
  process.exit(1);
}

const dashboard = {
  __inputs: [{ name: "DS_PROMETHEUS", label: "Prometheus", type: "datasource", pluginId: "prometheus", pluginName: "Prometheus" }],
  annotations: { list: [] },
  editable: true,
  graphTooltip: 1,
  id: null,
  links: [],
  panels: series.map((p) => panel(p.title, p.description, p.targets, p.unit)),
  refresh: "30s",
  schemaVersion: 39,
  tags: ["keystone", "authentication"],
  templating: { list: [] },
  time: { from: "now-6h", to: "now" },
  timepicker: {},
  timezone: "browser",
  title: "Keystone — authentication",
  uid: "keystone-authentication",
  version: 1,
};

const out = path.join(root, "docs", "dashboards", "authentication.json");
await writeFile(out, `${JSON.stringify(dashboard, null, 2)}\n`, "utf8");

console.log("Authentication dashboard OK.");
console.log(`  ${dashboard.panels.length} panels, every series name verified against the registry`);
for (const p of dashboard.panels) console.log(`    - ${p.title}`);
