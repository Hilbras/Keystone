/**
 * Release metadata checks.
 *
 * Guards the things that are easy to get wrong and hard to notice: a version
 * that disagrees between `package.json` and the lockfile (which npm then
 * silently corrects, or rejects at publish time), and a missing license, which
 * publishes a package with no declared terms.
 *
 * Run via `npm run verify:release`. Exits non-zero on the first problem.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

const pkg = readJson("package.json");

// --- version consistency -------------------------------------------------
const lockPath = path.join(root, "package-lock.json");
if (fs.existsSync(lockPath)) {
  const lock = readJson("package-lock.json");
  if (lock.version !== pkg.version) {
    failures.push(
      `package-lock.json version (${lock.version}) does not match package.json (${pkg.version}). ` +
        `Run \`npm install --package-lock-only\`.`
    );
  }
  if (lock.packages?.[""]?.version !== pkg.version) {
    failures.push(
      `package-lock.json root package version (${lock.packages?.[""]?.version}) does not match ` +
        `package.json (${pkg.version}). Run \`npm install --package-lock-only\`.`
    );
  }
  const lockName = lock.packages?.[""]?.name;
  if (lockName !== pkg.name) {
    failures.push(`lockfile root name (${lockName}) does not match package.json (${pkg.name}).`);
  }
} else {
  failures.push("package-lock.json is missing.");
}

// Every dependency the lockfile resolves must be reachable from package.json,
// otherwise the two describe different projects.
if (fs.existsSync(lockPath)) {
  const lock = readJson("package-lock.json");
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (typeof range !== "string" || range.startsWith("file:") || range.startsWith("workspace:")) {
        continue;
      }
      if (!lock.packages?.[`node_modules/${name}`]) {
        failures.push(`${name} is declared in ${field} but absent from package-lock.json.`);
      }
    }
  }
}

// --- license -------------------------------------------------------------
if (!pkg.license) {
  failures.push(
    "package.json has no `license` field. A published package must declare its terms, " +
      "and an MIT LICENSE file alone is not machine-readable."
  );
} else if (typeof pkg.license === "string" && !/^[A-Za-z0-9.+-]+$/.test(pkg.license)) {
  // An SPDX expression contains spaces and parentheses, e.g. "MIT OR Apache-2.0".
  const looksLikeExpression = / (OR|AND|WITH) /.test(pkg.license);
  if (!looksLikeExpression) {
    failures.push(`license (${JSON.stringify(pkg.license)}) is not a valid SPDX identifier or expression.`);
  } else {
    notes.push(`license expression: ${pkg.license}`);
  }
}

if (!fs.existsSync(path.join(root, "LICENSE")) && !pkg.license) {
  failures.push("Neither a LICENSE file nor a license field is present.");
}

// --- publish hygiene -----------------------------------------------------
if (pkg.private) {
  notes.push("package is marked private; it will not be published.");
} else {
  if (!pkg.repository) {
    // npm refuses `--provenance` without a repository field.
    failures.push("package.json has no `repository` field; `npm publish --provenance` will be rejected.");
  }
  if (!pkg.description) {
    notes.push("package.json has no description.");
  }
}

// --- overrides -----------------------------------------------------------
if (pkg.overrides && Object.keys(pkg.overrides).length > 0) {
  notes.push(
    `dependency overrides in effect: ${Object.keys(pkg.overrides).join(", ")}. ` +
      `These apply to this repository only, not to consumers.`
  );
}

// --- report --------------------------------------------------------------
for (const note of notes) console.log(`  note: ${note}`);

if (failures.length > 0) {
  console.error("\nRelease metadata verification failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Release metadata OK (${pkg.name}@${pkg.version}).`);
