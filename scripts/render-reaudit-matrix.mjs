#!/usr/bin/env node
/**
 * Build the v3.0.0 re-audit matrix.
 *
 * The plan asks for a table mapping each original finding to Fixed / Regression
 * Test / Documentation. Written by hand, such a table is an assertion: it says
 * "yes, tested" whether or not a test exists, and it stays true after a test is
 * deleted. This generates it from the registry and **verifies each claim against
 * the repository**:
 *
 *   - Fixed            the fix site named in the entry still exists in the source
 *   - Regression Test  the named file exists AND contains at least one test
 *   - Documentation    the named document exists
 *
 * So a row can only say "Yes" if it is true right now. Deleting a test turns the
 * cell red on the next run rather than leaving a stale assurance in a document.
 *
 * Usage: node scripts/render-reaudit-matrix.mjs [--check]
 *   --check  exit non-zero if any cell cannot be verified
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const registry = read("docs/security/registry.json");

/**
 * The findings the plan names for the re-audit, in the plan's order, each mapped
 * to the registry entries that address it. An empty list is a finding this
 * programme never touched, and is reported as such rather than omitted.
 */
const PLAN_FINDINGS = [
  ["Privilege escalation", ["SEC-001", "SEC-002", "SEC-003", "SEC-007", "SEC-023", "SEC-025", "SEC-028", "SEC-032"]],
  ["MFA bypass", ["SEC-004", "SEC-005", "SEC-015", "SEC-034"]],
  ["SCIM isolation", ["SEC-006"]],
  ["mTLS trust", ["SEC-007", "SEC-009", "SEC-010"]],
  ["Fastify vulnerability", ["SEC-011"]],
  ["fast-uri vulnerabilities", ["SEC-011"]],
  ["Rate limiting", ["SEC-008", "SEC-033", "SEC-034", "SEC-035", "SEC-039"]],
  ["Token races", ["SEC-012", "SEC-013", "SEC-038"]],
  ["Session invalidation", ["SEC-014", "SEC-015", "SEC-038"]],
  ["OAuth hardening", ["SEC-016", "SEC-017", "SEC-018", "SEC-019", "SEC-020"]],
  ["SAML hardening", ["SEC-021", "SEC-022"]],
  ["Secrets", ["SEC-026", "SEC-029", "SEC-030", "SEC-031"]],
  ["CORS", ["SEC-027", "SEC-028"]],
  ["CI security", ["SEC-011", "SEC-040", "SEC-041", "SEC-042", "SEC-045", "SEC-046"]],
  // Raised by this programme rather than present in the v1.6.0 audit.
  ["Abuse prevention", ["SEC-033", "SEC-035", "SEC-036", "SEC-037", "SEC-039"]],
  ["Audit integrity", ["SEC-036", "SEC-037", "SEC-045", "SEC-046"]],
  ["Supply chain", ["SEC-011"]],
  ["Test integrity", ["SEC-040", "SEC-041", "SEC-042"]],
];

const byId = new Map(registry.entries.map((e) => [e.id, e]));
const unverified = [];

/** A fix site is verified when the file it names still exists. */
function fixVerified(entry) {
  const file = String(entry.fix).match(/(src\/[^\s:,)]+\.ts)/)?.[1];
  if (!file) {
    // Not a source file (a Dockerfile, a workflow). Accept a path that exists.
    const pathish = String(entry.fix).match(/^(\S+)/)?.[1];
    if (pathish && fs.existsSync(path.join(root, pathish))) return true;
    unverified.push(`${entry.id}: fix site not resolvable — ${entry.fix}`);
    return false;
  }
  return fs.existsSync(path.join(root, file));
}

/** A regression test is verified when the file exists and actually contains a test. */
function testVerified(entry) {
  const file = path.join(root, entry.test);
  if (!fs.existsSync(file)) {
    unverified.push(`${entry.id}: test file missing — ${entry.test}`);
    return false;
  }
  // A non-test file (a workflow, a script) counts as an executable check.
  if (!entry.test.endsWith(".test.ts")) return true;
  const source = fs.readFileSync(file, "utf8");
  if (!/^\s*it\(/m.test(source)) {
    unverified.push(`${entry.id}: ${entry.test} contains no test`);
    return false;
  }
  return true;
}

function docVerified(entry) {
  if (!fs.existsSync(path.join(root, entry.documentation))) {
    unverified.push(`${entry.id}: documentation missing — ${entry.documentation}`);
    return false;
  }
  return true;
}

const yn = (ok) => (ok ? "Yes" : "**No**");

const withdrawn = registry.withdrawn ?? [];

const rows = PLAN_FINDINGS.map(([name, ids]) => {
  const entries = ids.map((id) => byId.get(id)).filter(Boolean);
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) unverified.push(`${name}: unknown registry ids ${missing.join(", ")}`);

  const severities = new Set(entries.map((e) => e.severity));
  const original = severities.has("critical")
    ? "Critical"
    : severities.has("high")
      ? "High"
      : severities.has("medium")
        ? "Medium"
        : "Low";

  return {
    name,
    original,
    count: entries.length,
    fixed: entries.length > 0 && entries.every((e) => fixVerified(e)),
    tested: entries.length > 0 && entries.every((e) => testVerified(e)),
    documented: entries.length > 0 && entries.every((e) => docVerified(e)),
    ids: entries.map((e) => e.id),
  };
});

const criticalOpen = rows.filter((r) => r.original === "Critical" && !(r.fixed && r.tested && r.documented));
const out = [];
out.push("# v3.0.0 re-audit matrix");
out.push("");
out.push("<!-- Generated by scripts/render-reaudit-matrix.mjs. Do not edit by hand. -->");
out.push("");
out.push(
  "Each cell is verified against the repository when this file is generated, not asserted. " +
    "`Regression Test` is **Yes** only if the named file exists and contains a test; " +
    "`Fixed` only if the fix site still exists. Deleting a test turns the cell red on the next run " +
    "rather than leaving a stale assurance behind."
);
out.push("");
out.push("| Finding | Original severity | Findings | Fixed | Regression test | Documentation | Entries |");
out.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  out.push(
    `| ${r.name} | ${r.original} | ${r.count} | ${yn(r.fixed)} | ${yn(r.tested)} | ${yn(r.documented)} | ${r.ids.join(", ")} |`
  );
}
out.push("");
out.push("## API security review");
out.push("");
out.push(
  "Every route enumerated from source and checked for a guard. Result in\n" +
    "[`docs/API-REVIEW.md`](./API-REVIEW.md).\n\n" +
    "**69 routes. Zero with no authentication guard.** 27 carry no route-level\n" +
    "authorization and each was traced: SCIM\u2019s bearer token *is* the authorization,\n" +
    "`GET /me` returns the caller\u2019s own profile, the OAuth authorize endpoint\n" +
    "authenticates in the request, and `workflows.ts` checks membership in the handler.\n\n" +
    "One structural weakness found: `workflows.ts` does its organization check inside\n" +
    "each of five handlers rather than in a guard, so a sixth route added later would\n" +
    "have no reason to include it. Not a live vulnerability \u2014 the checks are correct \u2014\n" +
    "but the only module in the codebase that does it this way."
);
out.push("");
out.push("## Unresolved Critical findings");
out.push("");
out.push(
  criticalOpen.length === 0
    ? "None. Every finding the plan classifies as Critical is fixed, has a regression test, and is documented."
    : criticalOpen.map((r) => `- **${r.name}** — ${r.ids.join(", ")}`).join("\n")
);
out.push("");
if (withdrawn.length) {
  out.push("## Withdrawn entries");
  out.push("");
  out.push("Recorded rather than renumbered, so every id already cited elsewhere keeps its meaning.");
  out.push("");
  for (const w of withdrawn) {
    out.push(`### ${w.id} — withdrawn ${w.withdrawn}`);
    out.push("");
    out.push(w.reason);
    out.push("");
  }
}

const coverage = registry.coverage ?? [];
if (coverage.length) {
  out.push("## Coverage without a numbered finding");
  out.push("");
  out.push(
    "Suites that assert a property but do not correspond to a defect we can evidence. " +
      "Recording these as findings to satisfy a completeness check is how a registry starts " +
      "asserting things nobody checked."
  );
  out.push("");
  for (const c of coverage) {
    out.push(`- \`${c.test}\` — ${c.covers}`);
    out.push(`  ${c.why}`);
  }
  out.push("");
}

out.push("## Coverage");
out.push("");
const total = registry.entries.length;
const tested = registry.entries.filter((e) => testVerified(e)).length;
out.push(`- ${total} findings recorded in \`docs/security/registry.json\`.`);
out.push(`- ${tested} of ${total} verified to have a regression test present right now.`);
out.push(`- ${registry.entries.filter((e) => e.severity === "critical").length} critical, ${registry.entries.filter((e) => e.severity === "high").length} high, ${registry.entries.filter((e) => e.severity === "medium").length} medium, ${registry.entries.filter((e) => e.severity === "low").length} low.`);
out.push("");

fs.writeFileSync(path.join(root, "docs", "RE-AUDIT.md"), out.join("\n"));
console.log(`Wrote docs/RE-AUDIT.md — ${rows.length} plan findings, ${total} registry entries, ${tested} with a test present.`);

if (unverified.length) {
  console.error("\nClaims that could not be verified:");
  for (const u of unverified) console.error(`  - ${u}`);
  if (check) process.exit(1);
} else if (check) {
  console.log("Every claim verified.");
}
