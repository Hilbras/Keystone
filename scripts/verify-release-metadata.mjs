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

// --- publishable entry points ---------------------------------------------
// This package shipped dist/index.js and dist/index.d.ts with no `main` and no
// `types`, so `import "@hilbras/keystone"` did not resolve for anyone installing
// from npm. The `bin` worked, so the CLI was usable and the library surface was
// not — which is why it went unnoticed: nothing failed, the package just could
// not be imported.
if (!pkg.private) {
  for (const field of ["main", "types"]) {
    if (!pkg[field]) {
      failures.push(
        `package.json has no \`${field}\` field. The package ships ${
          field === "main" ? "dist/index.js" : "dist/index.d.ts"
        }, so without it the published package cannot be imported.`
      );
      continue;
    }
    const target = path.join(root, pkg[field]);
    if (!fs.existsSync(target)) {
      failures.push(`\`${field}\` points at ${pkg[field]}, which does not exist.`);
    }
  }

  const bin = typeof pkg.bin === "string" ? { [pkg.name.split("/").pop()]: pkg.bin } : pkg.bin;
  for (const [name, target] of Object.entries(bin ?? {})) {
    if (!fs.existsSync(path.join(root, target))) {
      failures.push(`bin "${name}" points at ${target}, which does not exist.`);
    }
  }
}

// --- tarball contents -----------------------------------------------------
// A published tarball is a permanent artefact, and the things that should never
// be in one are exactly the things that are easy to commit. These are checked
// here rather than left to a manual `npm pack` review, because a review that is
// only done sometimes is not a control.
const shipped = pkg.files ?? ["."];
const mustShip = ["docs", "CHANGELOG.md", "README.md"];
for (const entry of mustShip) {
  const negated = shipped.some((f) => f === `!${entry}` || f.startsWith(`!${entry}/`));
  if (negated) {
    failures.push(
      `\`files\` excludes ${entry}. Migration guides and the changelog are the only ` +
        `documentation a consumer installing from npm receives.`
    );
  }
}
if (shipped.includes("dist") && !shipped.includes("!dist/tests")) {
  failures.push(
    "`files` ships `dist` without excluding `dist/tests`. Compiled tests are not " +
      "part of the package, and they carry test-only credentials."
  );
}
for (const pattern of [/^\.env/, /\.(pem|key|p12|pfx)$/]) {
  const strays = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist", "frontend", "coverage"].includes(entry.name)) continue;
      const rel = path.relative(root, path.join(dir, entry.name));
      if (pattern.test(entry.name) && shipped.some((f) => f === entry.name || f === rel || rel.startsWith(f + "/"))) {
        strays.push(rel);
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root);
  if (strays.length) {
    failures.push(`files would publish credential material: ${strays.join(", ")}`);
  }
}

// --- report --------------------------------------------------------------
for (const note of notes) console.log(`  note: ${note}`);

if (failures.length > 0) {
  console.error("\nRelease metadata verification failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Release metadata OK (${pkg.name}@${pkg.version}).`);
