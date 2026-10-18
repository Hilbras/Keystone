import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");
const workflow = readFileSync(path.join(projectRoot, ".github/workflows/release.yml"), "utf8");

/**
 * SEC-085 — the release workflow had no manual path, so a missed dispatch was
 * unrecoverable.
 *
 * ## What actually happened
 *
 * On 2026-10-06 six annotated tags (`v3.7.1` … `v3.9.1`, all release-worthy, all
 * verified present on the remote via `git ls-remote`) were pushed in one command and
 * produced **zero** workflow runs — not queued, not in progress, not waiting, and no
 * failure record either.
 *
 * That last part is what makes this worth a test rather than a retry. A failed run is
 * visible. A run that never exists is not: the release was neither happening nor
 * reported as not happening, and the only symptom was an absence.
 *
 * And there was no way out. You cannot re-push an unchanged tag, and with no
 * `workflow_dispatch` there was nothing to re-run. Six releases were merged, verified
 * and reachable, and stuck.
 *
 * ## Why this is a test and not a comment
 *
 * Every part of the fix is a silent-failure risk. Each was wrong in a way that
 * produces no error:
 *
 * - `type=semver` reads the *git tag*; on a dispatch there is none, so the image is
 *   built and pushed **with no tag at all** — and the workflow reports success.
 * - `if: startsWith(github.ref, 'refs/tags/v')` is false on a branch, so the npm job
 *   **silently skips** rather than failing.
 * - `${GITHUB_REF_NAME#v}` on `main` expands to `main`, so the version gate compares
 *   `package.json` against the string `main`.
 *
 * A workflow that parses, runs green, and publishes nothing is the exact shape of
 * control this repository has been finding for fifty releases.
 */
describe("release workflow can be recovered by hand (SEC-085, §2.7)", () => {
  it("offers a manual dispatch, not only the tag push", () => {
    assert.match(workflow, /workflow_dispatch:/, "there must be a manual recovery path");
    assert.match(
      workflow,
      /push:\s*\n\s*tags:\s*\n\s*-\s*"v\*"/,
      "the tag push must remain the normal trigger"
    );
  });

  it("asks for the version explicitly, rather than inferring it from a ref", () => {
    assert.match(
      workflow,
      /workflow_dispatch:[\s\S]*?inputs:[\s\S]*?version:[\s\S]*?required:\s*true/,
      "a dispatch must be told which version it is publishing"
    );
  });

  it("resolves one version for the whole workflow", () => {
    // Four inline `${GITHUB_REF_NAME#v}` reads is four chances to disagree, and on a
    // branch ref all four expand to `main`.
    assert.match(
      workflow,
      /RELEASE_VERSION:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.version\s*\|\|\s*github\.ref_name\s*\}\}/,
      "the dispatch input must win for a manual run"
    );
    // Comments are stripped first: this file *documents* the old inline reads, so a
    // naive whole-file search finds the pattern in prose and fails on its own fix.
    // A structural check that trips over the explanation of the defect is a check
    // nobody will keep.
    const code = workflow.replace(/^\s*#.*$/gm, "");
    const inline = code.match(/GITHUB_REF_NAME#v/g) ?? [];
    assert.equal(
      inline.length,
      0,
      `no step may re-derive the version from GITHUB_REF_NAME (found ${inline.length})`
    );
  });

  it("does not gate publishing on the ref being a tag", () => {
    // A dispatch runs on a branch. This guard would skip npm publishing entirely —
    // no failure, no log line, just a missing publish.
    assert.doesNotMatch(
      workflow,
      /if:\s*\$\{\{\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)\s*\}\}/,
      "no job may be skipped because the ref is not a tag"
    );
    // It must still depend on verification, or the manual path becomes a bypass.
    assert.match(
      workflow,
      /if:\s*\$\{\{\s*always\(\)\s*&&\s*needs\.verify\.result\s*==\s*'success'\s*\}\}/,
      "publishing must still require a successful verify job"
    );
  });

  it("passes the resolved version to the image tagger explicitly", () => {
    // `type=semver` reads the git tag. With no tag it resolves to nothing and the
    // image is pushed untagged — while the step still succeeds.
    assert.match(
      workflow,
      /type=raw,value=\$\{\{\s*env\.RELEASE_VERSION\s*\}\}/,
      "the image tag must come from the resolved version, not only from semver"
    );
    // Both routes must produce the version tag, and `latest` must still be published.
    assert.match(workflow, /type=semver,pattern=\{\{version\}\}/);
    assert.match(workflow, /type=semver,pattern=\{\{major\}\}\.\{\{minor\}\}/);
    assert.match(workflow, /type=raw,value=latest/);
  });

  it("still gates the version against package.json", () => {
    // The dispatch input must not become a way to publish a version that does not
    // match the tree — that would make the manual path a bypass of the version gate.
    assert.match(
      workflow,
      /test "\$\(node -p "require\('\.\/package\.json'\)\.version"\)" = "\$VERSION"/,
      "package.json must still be checked against the resolved version"
    );
    assert.match(
      workflow,
      /test "\$\(node -p "require\('\.\/package-lock\.json'\)\.version"\)" = "\$VERSION"/,
      "package-lock.json must still be checked too"
    );
  });
});