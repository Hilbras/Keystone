#!/usr/bin/env node
/**
 * Bump the release version everywhere it is written, in one command.
 *
 * The version appears in five places, and `verify-k8s-manifests.mjs` fails if the
 * Kubernetes image tag disagrees with `package.json` — which is the gate working
 * as intended, and also means a release is a five-place manual edit with a build
 * failure if you miss one.
 *
 * So: one file per concern, one command. `package.json` is the source of truth;
 * everything else is derived.
 *
 * What it touches:
 *
 * - `package.json` — the source of truth.
 * - each `packages/<name>/package.json` — via `sync-sdk-versions.mjs`, which also
 *   recomputes each package's declared server range. A package published for 3.5.0
 *   that claims to support `>=3.4.0 <3.5.0` would be a package that does not
 *   support the server it shipped with.
 * - `k8s/base/deployment.yaml` and `k8s/base/kustomization.yaml` — the image tag.
 *   The kustomization's `images[].newTag` **overrides** the Deployment's own tag,
 *   so both are written and both are checked: `newTag: latest` once made the tag
 *   in `deployment.yaml` decorative.
 *
 * Usage: node scripts/bump-version.mjs <version>
 *        node scripts/bump-version.mjs --show
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(file) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

/** The exact text of a repo file, for the compare-and-swap below. */
async function readText(file) {
  return readFile(path.join(root, file), "utf8");
}

/**
 * Write only if the file is still what we read.
 *
 * Both release scripts read a file, transform it, and write it back — and CodeQL's
 * `js/file-system-race` is right that an edit landing between the read and the
 * write is silently lost. During a release bump that is the worst possible moment
 * to lose a change: the version moves, the manifest moves, and the edit vanishes
 * with no error anywhere.
 *
 * The fix is a compare-and-swap: re-read immediately before writing and refuse if
 * it differs from what we transformed. It is the same lesson as
 * `scripts/lib/patch.mjs` — a write that does not land, or a write that lands on
 * something other than what you read, should be loud rather than quiet.
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

  /**
   * The value of the `key:` line in `source`, ignoring comments.
   *
   * **No regex.** This used to build one per call from the key, which meant a key
   * containing `.` or `(` matched more than intended, and made a reader reason about
   * escaping in a script whose previous version once shipped a bug by writing the
   * wrong thing to a manifest. A trimmed line either starts with `key:` or it does
   * not, and that is a string comparison.
   */
  function scalarOnLine(source, key, { tagOnly = false } = {}) {
    for (const line of source.split("\n")) {
      const code = line.replace(/^\s*#.*$/, "");
      const value = valueOnKeyLine(code, key);
      if (value === null) continue;
      if (!tagOnly) return value;
      // `image: registry/name:tag` — the tag is the last colon-separated segment.
      const lastColon = value.lastIndexOf(":");
      return lastColon === -1 ? null : value.slice(lastColon + 1);
    }
    return null;
  }

  /**
   * The value on a `key:` line, or null. Leading whitespace is left in place, because
   * the writer needs to reproduce it.
   */
  function valueOnKeyLine(line, key) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(`${key}:`)) return null;
    const rest = trimmed.slice(key.length + 1);
    // A YAML key ends at the colon, so `key:` must be followed by whitespace or the
    // end of the line. Without this, `version:` would also match `versionOverride:`.
    if (rest !== "" && !/^\s/.test(rest)) return null;
    return rest.trimStart();
  }

if (process.argv.includes("--show")) {
  const pkg = await read("package.json");
  const deployment = await readFile(path.join(root, "k8s/base/deployment.yaml"), "utf8");
  const kustomization = await readFile(path.join(root, "k8s/base/kustomization.yaml"), "utf8");
  // Line-anchored, and the image read tag-only. The first version used loose
  // regexes over the whole file and reported the kustomization as "latest`" — a
  // value it found *in the explanatory comment* above the real `newTag`.
  const imageTag = scalarOnLine(kustomization, "newTag");
  const inDeployment = scalarOnLine(deployment, "image", { tagOnly: true });
  console.log("Release version, and where it is written:");
  console.log(`  package.json          ${pkg.version}`);
  console.log(`  k8s kustomization     ${imageTag ?? "(none)"}`);
  console.log(`  k8s deployment.yaml   ${inDeployment ?? "(none)"}`);
  if (imageTag !== pkg.version || inDeployment !== pkg.version) {
    console.log("\n  These disagree. A release with a mismatched image tag ships code the");
    console.log("  documentation does not describe, which is what the gate is for.");
    process.exit(1);
  }
  process.exit(0);
}

const target = process.argv[2];
if (!target || !/^\d+\.\d+\.\d+$/.test(target)) {
  console.error("usage: node scripts/bump-version.mjs <major.minor.patch>   (or --show)");
  process.exit(2);
}

const pkgPath = path.join(root, "package.json");
const pkgBefore = await readText("package.json");
const pkg = JSON.parse(pkgBefore);
const from = pkg.version;
if (from === target) {
  console.log(`  already at ${target}`);
} else {
  pkg.version = target;
  await writeIfUnchanged(pkgPath, pkgBefore, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  package.json          ${from} -> ${target}`);
}

/* --- the k8s image tag, in both places, because one overrides the other ------ */

/**
 * Rewrite a scalar on its own line, never inside a comment.
 *
 * The first version of this used a plain regex over the whole file, and the
 * kustomization's own comment says "`newTag: latest` made the tag in
 * deployment.yaml decorative" — so the bump rewrote the **comment** and left the
 * real `newTag` at the old version. The script reported success; `verify:k8s`
 * caught the result. A comment that mentions the thing you are replacing is a trap
 * for any text-based editor, and the only reliable defence is to anchor on the line
 * rather than on the text.
 */
function replaceYamlScalar(source, key, value, { keepPrefix = false } = {}) {
  let changed = 0;
  const out = source
    .split("\n")
    .map((line) => {
      const code = line.replace(/^\s*#.*$/, ""); // what remains after comments
      // `keepPrefix` rewrites only the last colon-separated segment — the tag of
      // `image: registry/name:tag` — rather than the whole value. Without it the
      // first version replaced the entire reference with the bare version number,
      // leaving the manifest saying `image: 3.5.0`, which the gate caught.
        const current = valueOnKeyLine(code, key);
        if (current === null) return line;
        changed++;
        // `keepPrefix` rewrites only the last colon-separated segment — the tag of
        // `image: registry/name:tag` — rather than the whole value. Without it the
        // first version replaced the entire reference with the bare version number,
        // leaving the manifest saying `image: 3.5.0`, which the gate caught.
        if (keepPrefix) {
          const lastColon = current.lastIndexOf(":");
          if (lastColon === -1) return line;
          return line.replace(current, `${current.slice(0, lastColon + 1)}${value}`);
        }
        // Replace only the value, leaving the indentation and `key:` exactly as they
        // were. Rebuilding the line from a regex match is what let an earlier version
        // rewrite a comment instead of a value.
        return `${line.slice(0, line.length - current.length)}${value}`;
    })
    .join("\n");
  return { out, changed };
}

for (const [file, key, keepPrefix] of [
  ["k8s/base/deployment.yaml", "image", true],
  ["k8s/base/kustomization.yaml", "newTag", false],
]) {
  const full = path.join(root, file);
  if (!existsSync(full)) continue;
  const before = await readFile(full, "utf8");
  const { out, changed } = replaceYamlScalar(before, key, target, { keepPrefix });
  if (changed === 0) {
    console.error(`  ${file}: found no "${key}:" line to update — refusing to assume one`);
    process.exit(1);
  }
  // A reference that lost its registry is a manifest that cannot be applied, so
  // the resulting shape is verified rather than assumed.
  if (keepPrefix && !out.includes(`ghcr.io/hilbras-dev/hilbras-keystone:${target}`)) {
    console.error(`  ${file}: the image reference is not the expected registry/name:${target}`);
    console.error("  Refusing to write a manifest that cannot be applied.");
    process.exit(1);
  }
  await writeIfUnchanged(full, before, out);
  console.log(`  ${file.padEnd(23)} -> ${target} (${changed} line${changed === 1 ? "" : "s"})`);
}

/* --- package-lock.json, which carries the version twice --------------------- */

const lockPath = path.join(root, "package-lock.json");
if (existsSync(lockPath)) {
  const lockBefore = await readFile(lockPath, "utf8");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  // Two places: the top-level `version`, and `packages[""].version` for the root
  // package. `verify-release-metadata` checks both, and reported both.
  lock.version = target;
  if (lock.packages?.[""]) lock.packages[""].version = target;
  await writeIfUnchanged(lockPath, lockBefore, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`  package-lock.json      -> ${target} (2 places)`);
}

/* --- the five SDK packages, and their declared server range ---------------- */

await run(process.execPath, [path.join(root, "scripts/sync-sdk-versions.mjs")], {
  cwd: root,
  stdio: "inherit",
});

console.log(`\n  Now run: npm run verify:node && npm run verify:k8s && npm run verify:sdk`);
console.log(`  and add a CHANGELOG.md entry for ${target} — verify:changelog will fail without it.`);
