#!/usr/bin/env node
/**
 * The Node version must be stated once, and every consumer must agree.
 *
 * Dependabot opened PR #34 to bump `node:22-slim` to `26-slim` in the Dockerfile.
 * Merging it would have produced a container running Node 26 while CI tested Node
 * 22, `engines` said nothing, and `.nvmrc` **did not exist** — even though
 * `benchmark.yml` already pointed `setup-node` at it:
 *
 * ```yaml
 * node-version-file: .nvmrc
 * ```
 *
 * So the runtime version was written out in ten places, two of them in the
 * Dockerfile, one of them pointing at a file that was never created, and nothing
 * anywhere said which one was authoritative. A Dependabot PR that changes one of
 * ten is the normal way that inconsistency gets shipped.
 *
 * What this checks:
 *
 * - **`.nvmrc` exists** and holds a bare major version.
 * - **Every `setup-node` step reads it**, rather than hardcoding a version. Ten
 *   copies of `node-version: 22` is nine places to forget.
 * - **`package.json` declares `engines.node`**, and admits the `.nvmrc` version.
 *   An `engines` field that excludes the version you run is worse than none.
 * - **The Dockerfile's `FROM node:` matches the major version.** This is the one
 *   that matters most and the one nothing checked: a container on a different Node
 *   major from the one the suite passed on is the difference between "tests pass"
 *   and "the release works".
 *
 * It is deliberately not a gate on *which* version. Bumping the runtime is a
 * decision with a test run behind it, not a lint. What this enforces is that the
 * decision gets made in one file and reaches everywhere.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const fail = (message) => problems.push(message);

/**
 * Does a semver range admit a major version?
 *
 * A small parser rather than a regex, because the first version of this was a
 * regex with a fallback that **accepted every range it did not understand** —
 * `>=23` was admitted for a project on 22, and the check passed. A permissive
 * fallback in a gate is worse than no fallback: it reports the one thing the gate
 * exists to catch as fine.
 *
 * So an unrecognised range returns `false`, and says so.
 */
function rangeAdmits(range, majorVersion) {
  const text = String(range).trim();

  // ">=22", ">22", "<=22", "<22" — possibly several clauses joined by whitespace.
  const clauses = text.split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return false;

  for (const clause of clauses) {
    const comparator = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(clause);
    if (!comparator) return false;
    const [, op = "=", majorText] = comparator;
    const bound = Number(majorText);
    if (!Number.isInteger(bound)) return false;

    if (op === ">=" && !(majorVersion >= bound)) return false;
    if (op === ">" && !(majorVersion > bound)) return false;
    if (op === "<=" && !(majorVersion <= bound)) return false;
    if (op === "<" && !(majorVersion < bound)) return false;
    // `^22` and `^22.x` admit 22 and nothing above it. `^0.x` would be a range
    // within 0, but this project has never been on Node 0 and a caret there
    // means nothing sensible, so it is treated as a plain major match.
    if (op === "^" && majorVersion !== bound) return false;
    // `~22` admits 22.x only; `~22.4` admits 22.4.x. Either way the major must match.
    if (op === "~" && majorVersion !== bound) return false;
    if (op === "=" && majorVersion !== bound) return false;
  }
  return true;
}

/* --- 1. .nvmrc, the one place the version lives ----------------------------- */

const nvmrcPath = path.join(root, ".nvmrc");
if (!existsSync(nvmrcPath)) {
  console.error(
    ".nvmrc does not exist, so the Node version has no single home and every " +
      "consumer is a copy that can drift. Create it with the intended major version."
  );
  process.exit(1);
}
const nvmrcRaw = (await readFile(nvmrcPath, "utf8")).trim();
if (!/^\d+$/.test(nvmrcRaw)) {
  fail(`.nvmrc holds "${nvmrcRaw}" — it must be a bare major version, e.g. "22"`);
}
const major = Number(nvmrcRaw);
if (!Number.isInteger(major)) {
  fail(`.nvmrc holds "${nvmrcRaw}", which is not a version number`);
}
const version = Number.isInteger(major) ? major : null;

/* --- 2. every setup-node reads it ------------------------------------------- */

const WORKFLOWS = path.join(root, ".github/workflows");
const workflowFiles = (await readdir(WORKFLOWS)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
let reading = 0;
const hardcoded = [];

for (const file of workflowFiles) {
  const text = await readFile(path.join(WORKFLOWS, file), "utf8");
  // Step-scoped enough for this file's shape: each `setup-node` block is its own
  // `with:` map, and the version key is the only thing that matters.
  const blocks = text.split(/uses:\s*actions\/setup-node@[^\s]+/).slice(1);
  blocks.forEach((block, index) => {
    const step = block.split(/\n  - /)[0];
    const literal = /node-version:\s*(\S+)/.exec(step);
    const fromFile = /node-version-file:\s*(\S+)/.exec(step);
    const where = `.github/workflows/${file} (setup-node #${index + 1})`;
    if (literal && !fromFile) {
      hardcoded.push(`${where}: node-version: ${literal[1]}`);
    } else if (fromFile) {
      if (fromFile[1] !== ".nvmrc") {
        fail(`${where}: reads ${fromFile[1]}, not .nvmrc — the version should have one home`);
      } else {
        reading++;
      }
    } else {
      fail(`${where}: no node-version and no node-version-file, so the version is whatever the runner has`);
    }
  });
}

for (const line of hardcoded) {
  fail(
    `${line} — hardcoded. Ten copies of the version is nine places to forget, and ` +
      `a bump that changes one of them is how a release ends up running a different ` +
      `Node major from the one the suite passed on. Use node-version-file: .nvmrc.`
  );
}

/* --- 3. engines admits it ---------------------------------------------------- */

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const engines = pkg.engines?.node;
if (!engines) {
  fail(
    'package.json has no "engines.node". npm then installs on whatever Node it finds, ' +
      "with no warning at install time and no record of what was intended."
  );
} else if (version !== null) {
  if (!rangeAdmits(engines, version)) {
    fail(
      `package.json engines.node is "${engines}", which does not admit the .nvmrc ` +
        `version (${version}). An engines field that excludes the version you run is ` +
        `worse than none — it fails installs on the developer's machine and not in CI.`
    );
  }
}

/* --- 4. the Dockerfile agrees, which is the one that matters --------------- */

const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
const froms = [...dockerfile.matchAll(/^FROM\s+node:(\d+)/gm)].map((m) => m[1]);
if (froms.length === 0) {
  fail("Dockerfile has no `FROM node:` line, so the runtime image's Node cannot be checked");
} else {
  const wrong = froms.filter((m) => m !== String(version));
  if (wrong.length > 0) {
    fail(
      `Dockerfile builds on Node ${[...new Set(wrong)].join(", ")} but .nvmrc says ${version}. ` +
        `CI would test ${version} and ship ${[...new Set(wrong)].join(", ")}. This is the one ` +
        `mismatch that turns "the tests passed" into "the release does not work".`
    );
  }
}

if (problems.length > 0) {
  console.error("Node version is not stated once:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log("Node version OK.");
console.log(`  version:  ${version} (.nvmrc), engines.node "${engines}", Dockerfile node:${version}`);
console.log(`  readers:  ${reading} setup-node step(s) across ${workflowFiles.length} workflow(s), none hardcoded`);
