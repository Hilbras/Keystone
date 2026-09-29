#!/usr/bin/env node
/**
 * Check that the SDK packages agree with each other and with the server.
 *
 * §5.3: *"one version across the five packages, released together, matching the
 * server"* and *"state the supported range explicitly: which server versions each
 * supports"*.
 *
 * The five packages were all at `1.0.0` while the server was at `3.4.0`, none of
 * them declared a peer range, and there was no gate on any of it. So a package
 * could drift from the server it is an SDK for, and nothing in the build would
 * notice — a change to a response shape, a renamed method, a new required option.
 * The version being `1.0.0` on all five is itself the clearest statement of the
 * problem: five independently-versioned things that have to move together, and no
 * mechanism making them.
 *
 * What is checked here:
 *
 * - **One version, equal to the server's.** Not a range, not "close enough". The
 *   packages are the SDK *for this server release*; a package that works against
 *   two server versions is a different product decision, and one this repository
 *   has not made.
 * - **A declared support range**, in `keystonePeer.server`, so the constraint lives
 *   in the package rather than in a README that drifts.
 * - **The declared range admits the current version.** A range that excludes the
 *   version being released is a contradiction, and reading it requires arithmetic.
 * - **Every dependency between packages is exact**, and points at the same version.
 * - **Every package compiles**, so `1.0.0` is a claim about code that exists rather
 *   than a version field nothing is built from.
 *
 * It deliberately does not check that the packages' *runtime* works. That would
 * need a test against a live server, and the honest place for that is
 * `src/tests/`, not a gate that boots nothing.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = path.join(root, "packages");

const server = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const problems = [];
/**
 * Real facts that are not failures.
 *
 * The packages compile with TypeScript 5.9 while the server compiles with
 * TypeScript 7. That is a genuine gap — a type that compiles in a package may not
 * compile in the server — and it is also not something to fail a build over,
 * because the fix is a migration rather than a mistake. Reporting it separately
 * means it is visible without being mistaken for a defect, and without a gate
 * that cries wolf on the next one.
 */
const notes = [];
const toolchainSkew = [];
const fail = (message) => problems.push(message);

const rootTypeScript = await readFile(
  path.join(root, "node_modules/typescript/package.json"),
  "utf8"
).then((text) => JSON.parse(text).version);

/** A range like `3.4.0` or `>=3.0.0 <4.0.0`, checked for whether it admits a version. */
function admits(range, version) {
  const [major, minor, patch] = version.split(".").map(Number);
  const v = (t) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(t);
    return m ? m.slice(1).map(Number) : null;
  };
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  // `>=x.y.z <a.b.c` and conjunctions thereof.
  for (const clause of range.split(/\s+(?=[<>]=?)/)) {
    const m = /^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(clause.trim());
    if (!m) return false;
    const bound = v(m[2]);
    if (!bound) return false;
    const target = [major, minor, patch];
    const op = m[1] ?? "=";
    if (op === ">=" && cmp(target, bound) < 0) return false;
    if (op === ">" && cmp(target, bound) <= 0) return false;
    if (op === "<=" && cmp(target, bound) > 0) return false;
    if (op === "<" && cmp(target, bound) >= 0) return false;
    if (op === "=" && cmp(target, bound) !== 0) return false;
  }
  return true;
}

if (!existsSync(PACKAGES)) {
  console.error("packages/ does not exist");
  process.exit(1);
}

const dirs = (await readdir(PACKAGES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (dirs.length === 0) {
  console.error("packages/ contains no packages, so there is nothing to keep in step");
  process.exit(1);
}

const manifests = new Map();
for (const name of dirs) {
  const file = path.join(PACKAGES, name, "package.json");
  if (!existsSync(file)) {
    fail(`packages/${name} has no package.json`);
    continue;
  }
  manifests.set(name, JSON.parse(await readFile(file, "utf8")));
}

const versions = new Set([...manifests.values()].map((m) => m.version));
if (versions.size > 1) {
  fail(
    `the packages do not share one version: ` +
      [...manifests].map(([n, m]) => `${n}@${m.version}`).join(", ") +
      `. They are released together, so a per-package version is a number that ` +
      `cannot mean anything.`
  );
}

for (const [name, manifest] of manifests) {
  if (manifest.version !== server.version) {
    fail(
      `packages/${name} is at ${manifest.version} but the server is at ${server.version}. ` +
        `These are released together and the package is the SDK for this server, so a ` +
        `mismatch means the package documents a version that is not what runs.`
    );
  }

  const range = manifest.keystonePeer?.server;
  if (!range) {
    fail(
      `packages/${name} declares no supported server range. Add ` +
        `"keystonePeer": { "server": "<range>" } to its package.json — the constraint ` +
        `belongs in the package, not in a README that drifts from it.`
    );
  } else if (!admits(range, server.version)) {
    fail(
      `packages/${name} declares support for server ${range}, which does not include the ` +
        `version being released (${server.version}). The package and the release disagree ` +
        `about whether they go together.`
    );
  }

  for (const [field, deps] of [
    ["dependencies", manifest.dependencies],
    ["peerDependencies", manifest.peerDependencies],
  ]) {
    for (const [dep, spec] of Object.entries(deps ?? {})) {
      if (!dep.startsWith("@hilbras/keystone")) continue;
      const target = manifests.get(dep.replace("@hilbras/", ""));
      if (!target) {
        fail(`packages/${name} depends on ${dep}, which is not in packages/`);
        continue;
      }
      if (spec !== target.version) {
        fail(
          `packages/${name} requires ${dep}@${spec}, but that package is at ` +
            `${target.version}. They are released together, so an exact version is the ` +
            `only specifier that can be right.`
        );
      }
    }
    void field;
  }

  // Compiled, so the version is a claim about code rather than a field nothing
  // builds from.
  //
  // **With the package's own TypeScript**, not the repository's. Each package
  // declares `typescript` in its own `devDependencies` and has it installed; the
  // root is on TypeScript 7. Using the root's compiler reported four of the five
  // packages as broken — `Cannot find name 'URL'`, `Cannot find name 'node:fs/promises'`
  // — which are not defects in the packages but the root compiler not seeing the
  // packages' own `@types/node` and `lib` settings. A gate that reports a toolchain
  // mismatch as a code defect is worse than no gate, because the fix it implies is
  // wrong.
  //
  // The skew itself is real and is reported separately below, because "compiles
  // with the compiler it ships with" and "compiles with the compiler the server
  // uses" are different claims and only the first one is true.
  const tsconfig = path.join(PACKAGES, name, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    fail(`packages/${name} has no tsconfig.json, so it is never compiled`);
  } else {
    const localTsc = path.join(PACKAGES, name, "node_modules/typescript/bin/tsc");
    const compiler = existsSync(localTsc) ? localTsc : path.join(root, "node_modules/typescript/bin/tsc");
    if (existsSync(localTsc)) {
      const localVersion = await readFile(
        path.join(PACKAGES, name, "node_modules/typescript/package.json"),
        "utf8"
      ).then((text) => JSON.parse(text).version);
      if (localVersion !== rootTypeScript) {
        toolchainSkew.push(
          `packages/${name} builds with TypeScript ${localVersion}; the server uses ${rootTypeScript}`
        );
      }
    } else {
      toolchainSkew.push(
        `packages/${name} has no TypeScript of its own, so it was compiled with the ` +
          `repository's. It should declare the version it builds with.`
      );
    }
    try {
      await run(
        process.execPath,
        [compiler, "--noEmit", "-p", tsconfig],
        { cwd: path.join(PACKAGES, name), maxBuffer: 8 * 1024 * 1024 }
      );
    } catch (err) {
      const e = /** @type {{ stdout?: string; stderr?: string }} */ (err);
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().split("\n").slice(0, 6).join("\n      ");
      fail(`packages/${name} does not compile with its own TypeScript:\n      ${out}`);
    }
  }
}

if (problems.length > 0) {
  console.error("SDK package consistency failed:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  if (toolchainSkew.length > 0) {
    console.error("\n  (not the cause, but true:)\n");
    for (const skew of toolchainSkew) console.error(`  - ${skew}`);
  }
  console.error("");
  process.exit(1);
}

console.log("SDK packages OK.");
console.log(`  version:  ${server.version} across all ${dirs.length} packages, matching the server`);
for (const [name, manifest] of manifests) {
  console.log(`    ${name.padEnd(18)} supports server ${manifest.keystonePeer.server}`);
}
if (toolchainSkew.length > 0) {
  console.log(`\n  toolchain skew (not a failure, but true):`);
  for (const skew of new Set(toolchainSkew)) console.log(`    - ${skew}`);
}
void notes;
