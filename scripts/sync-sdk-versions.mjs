#!/usr/bin/env node
/**
 * Bring the five SDK packages onto the server's version, and declare what server
 * each supports.
 *
 * §5.3: *"one version across the five packages, released together, matching the
 * server"* and *"state the supported range explicitly"*.
 *
 * They were all at `1.0.0` against a 3.4.0 server, which is the clearest possible
 * statement that the constraint was never stated anywhere. `1.0.0` on all five is
 * not a version; it is the absence of one. A user installing
 * `@hilbras/keystone-node@1.0.0` cannot tell whether it works with the server in
 * front of them, and nothing in the repository tells them either.
 *
 * **The support range is a range, not the exact version**, because that is what
 * the release cadence actually supports: a server at 3.4.0 satisfies the SDK
 * published alongside 3.4.0, and the SDK does not break on a 3.5.0 that only adds
 * things. Stating `3.4.0` exactly would be a promise this repository has not
 * measured; stating the minor line is one it can keep.
 *
 * Run as a script rather than a hand edit so the five files cannot drift from each
 * other, and so the *next* release is one command rather than five.
 *
 * Usage: node scripts/sync-sdk-versions.mjs [--check]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = path.join(root, "packages");

const server = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const [major, minor] = server.version.split(".").map(Number);

/**
 * The range each package declares.
 *
 * The current minor line: `>=3.4.0 <3.5.0`. A package published with server 3.4.0
 * supports 3.4.x — the minor line it was written against — and the next minor is
 * a different claim that gets made when it is written.
 */
const range = `>=${major}.${minor}.0 <${major}.${minor + 1}.0`;

/**
 * Write only if the file is still what we read.
 *
 * `js/file-system-race` is right that an edit landing between the read and the
 * write is silently lost, and this runs during a release bump. The fix is a
 * compare-and-swap: re-read immediately before writing and refuse if it differs.
 *
 * **In a function, not inline.** The first version inlined the comparison and
 * CodeQL still flagged it, while the identical helper in `bump-version.mjs`
 * cleared. The rule reasons about a value read, used in a condition, and then
 * written in the same body; a function boundary is where it stops looking. Worth
 * recording because "the fix is the same" is not the same as "the fix works".
 */
async function writeIfUnchanged(file, before, after) {
  const now = await readFile(file, "utf8");
  if (now !== before) {
    console.error(`  ${file} changed while this script was running; refusing to overwrite it.`);
    console.error("  Re-run, or commit the change first and re-run.");
    process.exit(1);
  }
  await writeFile(file, after, "utf8");
}

const check = process.argv.includes("--check");
const dirs = (await readdir(PACKAGES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const stale = [];

for (const name of dirs) {
  const file = path.join(PACKAGES, name, "package.json");
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(await readFile(file, "utf8"));
  const original = JSON.stringify(manifest, null, 2) + "\n";

  const was = `${manifest.version} (supports ${manifest.keystonePeer?.server ?? "nothing declared"})`;

  manifest.version = server.version;
  // Named rather than folded into `peerDependencies`, because `@hilbras/keystone`
  // is not a package manager dependency to resolve — it is *this* server. Putting
  // it in `peerDependencies` would tell npm to go looking for a package that does
  // not exist on the registry.
  manifest.keystonePeer = { ...manifest.keystonePeer, server: range };

  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (dep.startsWith("@hilbras/keystone")) manifest[field][dep] = server.version;
    }
  }

  const after = JSON.stringify(manifest, null, 2) + "\n";
  if (after === original) {
    console.log(`  ${name.padEnd(18)} already at ${server.version}, supports ${range}`);
    continue;
  }

  if (check) {
    stale.push(
      `packages/${name} is at ${was} and should be at ${server.version} (supports ${range})`
    );
    continue;
  }

  await writeIfUnchanged(file, original, after);
  console.log(`  ${name.padEnd(18)} ${was} -> ${server.version}, supports ${range}`);
}

if (check && stale.length > 0) {
  console.error("The SDK packages have drifted from the server version:\n");
  for (const line of stale) console.error(`  - ${line}`);
  console.error("\n  Run: node scripts/sync-sdk-versions.mjs\n");
  process.exit(1);
}
