#!/usr/bin/env node
/**
 * The changelog must describe the version being released.
 *
 * `CHANGELOG.md` is a Keep a Changelog file, it is required to ship in the
 * tarball, and `verify-release-metadata` checks that it ships. It did **not** check
 * that it was current — and 3.3.0 and 3.4.0 were both published with no entry at
 * all. The file's newest heading was `[3.2.0]` while the package was at 3.4.0.
 *
 * That is the same shape as the gaps this programme keeps finding: the artifact
 * exists, a control mentions it, and nobody checked the thing that mattered. Here
 * the control checked *shipping* and the thing that mattered was *currency*.
 *
 * So this checks:
 *
 * - **A heading exists for the current `package.json` version.** One line.
 * - **Headings descend.** Changelogs get appended to rather than inserted, and a
 *   file ordered by accident is a file nobody reads to answer "when did this
 *   change".
 * - **Every published version is represented.** The npm registry is the record of
 *   what was actually published; a version on the registry with no heading here
 *   means a release went out undocumented. This needs network access and says so
 *   rather than failing, because a gate that cannot run offline is a gate that
 *   gets skipped.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const fail = (message) => problems.push(message);

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const changelogPath = path.join(root, "CHANGELOG.md");

if (!existsSync(changelogPath)) {
  console.error("CHANGELOG.md does not exist");
  process.exit(1);
}
const text = await readFile(changelogPath, "utf8");

/** `## [3.4.0] - 2026-09-28` and the variants people actually write. */
const headings = [...text.matchAll(/^##\s*\[?v?(\d+\.\d+\.\d+)\]?(?:\s*[-–]\s*(.+))?$/gm)].map(
  (m) => ({ version: m[1], date: (m[2] ?? "").trim(), line: text.slice(0, m.index).split("\n").length })
);

if (headings.length === 0) {
  console.error(
    "CHANGELOG.md has no version headings. Expected lines like `## [3.4.0] - 2026-09-28`.\n" +
      "Nothing was parsed, which means this gate has stopped gating."
  );
  process.exit(1);
}

/* --- 1. the version being released is described ----------------------------- */

if (!headings.some((h) => h.version === pkg.version)) {
  fail(
    `CHANGELOG.md has no entry for ${pkg.version}, which is the version in package.json. ` +
      `The newest heading is [${headings[0].version}]. A release with no changelog entry ` +
      `means nobody can find out what changed, and a changelog whose newest entry is ` +
      `behind the package is a changelog nobody reads.`
  );
}

/* --- 2. descending --------------------------------------------------------- */

const compare = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
};
for (let i = 1; i < headings.length; i++) {
  if (compare(headings[i - 1].version, headings[i].version) < 0) {
    fail(
      `CHANGELOG.md is out of order: [${headings[i - 1].version}] at line ` +
        `${headings[i - 1].line} comes before the older [${headings[i].version}] at line ` +
        `${headings[i].line}. Changelogs get appended to rather than inserted.`
    );
  }
}

/**
 * Each version appears exactly once.
 *
 * **Added 3.5.11, after this file passed a changelog that had two of them.**
 *
 * The ordering check above cannot see a duplicate. `compare(a, a) === 0`, which is not
 * `< 0`, so `[3.5.8]` followed by `[3.5.10]` and then `[3.5.8]` again is in order by that
 * rule — and it was, twice, in releases this project had already published.
 *
 * Both duplicates were mine, both from the same mistake: writing a release entry, then
 * writing a *second, expanded* entry for the same version and inserting it above the first
 * instead of replacing it. The gate reported "38 headings, newest first" both times, which
 * is true of the file it was looking at and useless as a statement about whether the
 * changelog is well formed.
 *
 * That is the failure this file exists to prevent, in the shape it is least expected in: a
 * release-notes file is the one artefact nobody reads as code and everybody reads as
 * documentation, so "two entries for 3.5.8" is invisible to review and nonsense to a
 * reader — which of the two is the real one?
 *
 * The check is deliberately about *count*, not about content. Two sections for one version
 * are wrong whether the second is a superset, a subset, or a contradiction, and trying to
 * judge which to keep would be a heuristic where a fact will do.
 */
const seenVersions = new Map();
for (const h of headings) {
  const at = seenVersions.get(h.version);
  if (at === undefined) seenVersions.set(h.version, h.line);
  else {
    fail(
      `CHANGELOG.md has two sections for [${h.version}]: line ${at} and line ${h.line}. ` +
        `A version gets one entry. If the second is an expanded replacement for the first, ` +
        `the first is deleted rather than left above it — a reader cannot tell which of the ` +
        `two is the release notes.`
    );
  }
}

/* --- 3. the newest heading carries a date ----------------------------------- */

const newest = headings.find((h) => h.version === pkg.version);
if (newest && !/^\d{4}-\d{2}-\d{2}$/.test(newest.date)) {
  fail(
    `CHANGELOG.md entry [${pkg.version}] has no ISO date` +
      `${newest.date ? ` (found "${newest.date}")` : ""}. Expected "## [${pkg.version}] - YYYY-MM-DD.`
  );
}

/* --- 4. what was published, against what is documented ---------------------- */

let registryNote = "registry not checked (offline)";
try {
  const response = await fetch("https://registry.npmjs.org/@hilbras%2Fkeystone", {
    signal: AbortSignal.timeout(8000),
  });
  if (response.ok) {
    const body = await response.json();
    const published = Object.keys(body.versions ?? {});
    const undocumented = published.filter((v) => !headings.some((h) => h.version === v));
    if (undocumented.length > 0) {
      fail(
        `${undocumented.length} version(s) on the npm registry have no CHANGELOG.md entry: ` +
          `${undocumented.join(", ")}. Each was installed by somebody.`
      );
    }
    registryNote = `${published.length} published version(s), all documented`;
  }
} catch {
  // Said rather than assumed: a gate that quietly skips half its work is the
  // problem this file exists to address.
  registryNote = "registry not checked (no network — the offline case is reported, not hidden)";
}

if (problems.length > 0) {
  console.error("CHANGELOG is not current:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log("Changelog OK.");
console.log(`  ${pkg.version} documented and dated`);
console.log(`  ${headings.length} headings, newest first`);
console.log(`  ${registryNote}`);
