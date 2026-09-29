#!/usr/bin/env node
/**
 * Check the security regression registry against the repository.
 *
 * The registry is only useful if it is true. A registry that claims a fix is
 * tested while the test has been renamed, or that skips a whole security suite,
 * is worse than no registry: it converts an unknown into a false assurance. So
 * this is enforced rather than trusted.
 *
 * Fails when:
 *   - an entry is missing a required field
 *   - an entry names a test file that does not exist
 *   - a security test suite is claimed by no entry (unregistered coverage)
 *   - a mandatory attack class is covered by no entry
 *   - ids are duplicated or not a contiguous SEC-NNN sequence
 *
 * Usage: node scripts/verify-security-registry.mjs [--quiet]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");

const registry = JSON.parse(
  fs.readFileSync(path.join(root, "docs", "security", "registry.json"), "utf8")
);

const REQUIRED = ["id", "title", "severity", "component", "release", "issue", "fix", "test", "documentation", "covers"];
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const errors = [];

/** Every `*.test.ts` under src/tests/security, by repository-relative path. */
function securitySuites() {
  const base = path.join(root, "src", "tests", "security");
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts")) out.push(path.relative(root, full));
    }
  };
  walk(base);
  return out.sort();
}

const entries = registry.entries ?? [];
const ids = entries.map((e) => e.id);
const withdrawn = registry.withdrawn ?? [];

/**
 * Resolve the file a `fix` field points at.
 *
 * This check was missing, and that is how two entries came to name
 * `src/services/saml/validator.ts` — a file that does not exist, in a directory
 * that does not exist — while the registry reported itself healthy. The entry
 * names a test, the test existed, and the test was unrelated to the claim. A
 * registry that says "fixed" should have to name somewhere real.
 */
function resolveFixPath(fix) {
  const source = String(fix).match(/(src\/[^\s:,—)]+\.ts)/)?.[1];
  if (source) return fs.existsSync(path.join(root, source)) ? source : null;
  // Not a TypeScript source file — a workflow, a config, a Dockerfile.
  const leading = String(fix).trim().split(/\s+—|\s+-\s/)[0].trim();
  return fs.existsSync(path.join(root, leading)) ? leading : null;
}

// The scope decision is only meaningful if its named paths exist. A scope that
// names a tree nobody has is a boundary drawn around nothing.
if (!registry.scope) {
  errors.push('no "scope" — the registry must say what it covers and what it does not');
} else {
  if (typeof registry.scope.decision !== "string" || registry.scope.decision.trim() === "") {
    errors.push('scope.decision must be a sentence, not empty');
  }
  const trees = [
    ...(registry.scope.in_scope ?? []),
    ...(registry.scope.excluded ?? []).map((e) => e.what),
  ].map((t) => t.replace(/`/g, "").split(/[\s,—-]/)[0]);
  for (const tree of trees) {
    if (!fs.existsSync(path.join(root, tree))) {
      errors.push(`scope names ${tree}, which is not in the repository`);
    }
  }
  for (const excluded of registry.scope.excluded ?? []) {
    if (!excluded.why || String(excluded.why).trim().length < 20) {
      errors.push(`scope exclusion "${excluded.what}" has no reason`);
    }
  }
}

for (const entry of entries) {
  for (const field of REQUIRED) {
    if (entry[field] === undefined) errors.push(`${entry.id}: missing "${field}"`);
  }
  if (entry.severity && !SEVERITIES.has(entry.severity)) {
    errors.push(`${entry.id}: unknown severity "${entry.severity}"`);
  }
  if (entry.test && !fs.existsSync(path.join(root, entry.test))) {
    errors.push(`${entry.id}: test file does not exist — ${entry.test}`);
  }
  if (entry.documentation && !fs.existsSync(path.join(root, entry.documentation))) {
    errors.push(`${entry.id}: documentation does not exist — ${entry.documentation}`);
  }
  if (entry.fix) {
    const resolved = resolveFixPath(entry.fix);
    if (!resolved) {
      errors.push(
        `${entry.id}: fix site does not resolve to a file in the repository — ${entry.fix}. ` +
          `An entry must name somewhere real; a plausible path that does not exist is worse than none.`
      );
    }
  }
}

for (const id of new Set(ids)) {
  if (ids.filter((x) => x === id).length > 1) errors.push(`duplicate id ${id}`);
}
for (const w of withdrawn) {
  if (ids.includes(w.id)) errors.push(`${w.id} is both an entry and withdrawn.`);
  if (!w.reason) errors.push(`${w.id}: withdrawn without a reason.`);
}

// Ids must be unique, and every id between SEC-001 and the highest must be
// accounted for by either an entry or a withdrawal. A positional comparison is
// wrong here: withdrawing one id in the middle leaves the rest of the tail
// shifted, and the ids after the gap are still perfectly accounted for.
//
// Renumbering to keep the sequence contiguous would change every id other
// documents already cite, and a registry whose ids shift is one nobody can
// reference.
const known = new Set([...ids, ...withdrawn.map((w) => w.id)]);
const highest = Math.max(...[...known].map((id) => Number(id.slice(4))));
const missing = [];
for (let n = 1; n <= highest; n++) {
  const id = `SEC-${String(n).padStart(3, "0")}`;
  if (!known.has(id)) missing.push(id);
}
if (missing.length) {
  errors.push(
    `ids absent from both entries and withdrawals: ${missing.join(", ")}. ` +
      `Either add the entry or record a withdrawal with a reason; a silent gap reads as ` +
      `an oversight.`
  );
}

const coverage = registry.coverage ?? [];
for (const c of coverage) {
  if (!c.test || !fs.existsSync(path.join(root, c.test))) {
    errors.push(`coverage entry names a missing file — ${c.test}`);
  }
}

const claimed = new Set(entries.map((e) => e.test).filter((t) => t?.startsWith("src/tests/")));
for (const c of coverage) if (c.test?.startsWith("src/tests/")) claimed.add(c.test);
const suites = securitySuites();
for (const suite of suites) {
  if (!claimed.has(suite)) {
    errors.push(
      `security suite is unaccounted for — ${suite}. Add a registry entry if it covers a ` +
        `finding, or a \`coverage\` entry if it asserts a property without one. ` +
        `Do not invent a finding to satisfy this check.`
    );
  }
}

const covered = new Set(entries.flatMap((e) => e.covers ?? []));
for (const cls of registry.mandatoryAttackClasses ?? []) {
  if (!covered.has(cls)) errors.push(`mandatory attack class is uncovered — ${cls}`);
}

if (errors.length) {
  console.error("Security registry check FAILED:\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error("");
  process.exit(1);
}

if (!quiet) {
  const bySeverity = {};
  for (const e of entries) bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
  console.log(`Security registry OK (${entries.length} entries, ${suites.length} suites).`);
  console.log(
    "  " +
      Object.entries(bySeverity)
        .sort((a, b) => ["critical", "high", "medium", "low"].indexOf(a[0]) - ["critical", "high", "medium", "low"].indexOf(b[0]))
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")
  );
  console.log(`  ${(registry.mandatoryAttackClasses ?? []).length} mandatory attack classes covered.`);
}
