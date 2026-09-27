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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
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
}

for (const id of new Set(ids)) {
  if (ids.filter((x) => x === id).length > 1) errors.push(`duplicate id ${id}`);
}
entries.forEach((_, i) => {
  const expected = `SEC-${String(i + 1).padStart(3, "0")}`;
  if (ids[i] !== expected) errors.push(`entry ${i} is ${ids[i]}, expected ${expected} (the sequence must stay contiguous)`);
});

const claimed = new Set(entries.map((e) => e.test).filter((t) => t?.startsWith("src/tests/")));
const suites = securitySuites();
for (const suite of suites) {
  if (!claimed.has(suite)) {
    errors.push(`security suite is not registered — ${suite}. Add a registry entry so it cannot be dropped without a decision.`);
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
