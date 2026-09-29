#!/usr/bin/env node
/**
 * Every third-party action in a workflow must be pinned to a commit SHA.
 *
 * CodeQL's `actions/unpinned-tag` rule flagged 8 of them. They were all pinned to
 * a *major version* — `actions/checkout@v4` — which looks pinned and is not:
 * `@v4` is a mutable tag, and whoever owns the action can re-point it at a new
 * commit. A tag pin means the code that runs in a release is decided by someone
 * else, after the review that approved it.
 *
 * This is the same class as the other controls in this repository that were
 * assumed to cover something they did not: the pin looked like a pin.
 *
 * A SHA pin is opaque on its own — nobody can read `11d5960a` and know it is
 * `checkout` v4 — so each pin carries its version in a trailing comment. That
 * makes the pin reviewable and makes updating it a deliberate act rather than a
 * search-and-replace.
 *
 * The rules this enforces, and the two things it deliberately does not:
 *
 * - **Local and Docker actions are exempt.** `./.github/actions/x` and
 *   `docker://alpine` are in this repository; there is nothing to pin.
 * - **Reusable workflows from this repository are exempt** for the same reason,
 *   but a *remote* one is pinned like any other action, because
 *   `owner/repo/.github/workflows/x.yml@main` is exactly the mutable reference
 *   this is about.
 *
 * It runs in the `gates` job, so a newly added unpinned action fails a pull
 * request rather than waiting for CodeQL to notice on a schedule.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(root, ".github/workflows");

const SHA = /^[0-9a-f]{40}$/;
const problems = [];
let pinned = 0;
let exempt = 0;

const files = (await readdir(WORKFLOWS)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
if (files.length === 0) {
  console.error(".github/workflows contains no workflows, so there is nothing to pin");
  process.exit(1);
}

for (const file of files.sort()) {
  const full = path.join(WORKFLOWS, file);
  const text = await readFile(full, "utf8");
  const lines = text.split("\n");

  lines.forEach((line, index) => {
    const match = /uses:\s*"?([^"'\s]+)"?/.exec(line);
    if (!match) return;
    const spec = match[1];
    const at = spec.lastIndexOf("@");

    if (at === -1) {
      problems.push(`.github/workflows/${file}:${index + 1} — "uses: ${spec}" has no version at all`);
      return;
    }

    const action = spec.slice(0, at);
    const ref = spec.slice(at + 1);

    if (action.startsWith("./") || action.startsWith("docker://")) {
      exempt++;
      return;
    }
    if (SHA.test(ref)) {
      pinned++;
      // A pin with no version beside it is a pin nobody can update on purpose.
      const comment = line.slice(line.indexOf("#") + 1).trim();
      if (!comment) {
        problems.push(
          `.github/workflows/${file}:${index + 1} — ${action} is pinned to a SHA with no ` +
            `version in a comment. The pin is correct and unauditable: nobody can read a ` +
            `SHA and know which release it is. Use: uses: ${action}@<sha> # v1.2.3`
        );
      }
      return;
    }
    problems.push(
      `.github/workflows/${file}:${index + 1} — ${action} is pinned to "${ref}", which is a ` +
        `moving target. Anyone who owns the action can re-point that tag at a new commit, ` +
        `so the code that ships in a release is chosen after the review that approved it. ` +
        `Pin to a commit SHA and keep the version in a comment.`
    );
  });
}

if (problems.length > 0) {
  console.error("Unpinned actions:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\n  ${pinned} pinned, ${exempt} local or container images, ${problems.length} to fix\n`);
  process.exit(1);
}

console.log("Action pins OK.");
console.log(`  ${pinned} third-party actions pinned to a commit SHA, ${exempt} local or container images exempt`);
console.log(`  across ${files.length} workflow(s), every pin annotated with its version`);
