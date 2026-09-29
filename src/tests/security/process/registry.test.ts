import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");

/**
 * The registry's whole value is that it is true.
 *
 * A registry that names a test which no longer exists, or that quietly omits a
 * security suite, is worse than no registry at all: it converts "I don't know
 * whether this is covered" into "yes, covered". So the registry is checked
 * mechanically rather than trusted, and this suite is what makes the check part
 * of the normal test run instead of something a release author has to remember.
 */
describe("Security regression registry", () => {
  it("is internally consistent and matches the repository", () => {
    // Throws with a per-problem report and a non-zero exit on any mismatch.
    execFileSync(
      process.execPath,
      [path.join(projectRoot, "scripts", "verify-security-registry.mjs"), "--quiet"],
      { cwd: projectRoot, stdio: "pipe" }
    );
  });

  it("names a test file for every entry, and every suite is named", () => {
    // A second, independent read of the same invariant, expressed against the
    // script's own output, so a script that silently checked nothing would fail
    // here rather than pass silently.
    let stdout = "";
    try {
      stdout = execFileSync(
        process.execPath,
        [path.join(projectRoot, "scripts", "verify-security-registry.mjs")],
        { cwd: projectRoot, encoding: "utf8" }
      );
    } catch {
      assert.fail("the registry check must pass for this suite to be meaningful");
    }
    assert.match(stdout, /Security registry OK \(\d+ entries, \d+ suites\)/);
    assert.match(stdout, /mandatory attack classes covered/);
  });

  it("the re-audit matrix is regenerated and every claim in it verifies", () => {
    // The v3.0.0 matrix is generated, not written, and `--check` fails if any cell
    // cannot be verified against the repository. Run as part of the suite so a
    // matrix that has drifted from the code is caught here rather than by whoever
    // next reads the document and believes it.
    execFileSync(
      process.execPath,
      [path.join(projectRoot, "scripts", "render-reaudit-matrix.mjs"), "--check"],
      { cwd: projectRoot, stdio: "pipe" }
    );

    const matrix = readFileSync(
      path.join(projectRoot, "docs", "RE-AUDIT.md"),
      "utf8"
    );
    assert.match(matrix, /\| Finding \| Original severity \|/);
    assert.doesNotMatch(
      matrix,
      /\| \*\*No\*\* \|/,
      "a cell that cannot be verified must not read Yes; the generator marks it **No**"
    );
  });

  it("records every withdrawn id with a reason, and every coverage suite", () => {
    // A registry gap is only honest if it is explained. An id that is neither an
    // entry nor a withdrawal is an oversight that reads as coverage.
    const registry = JSON.parse(
      readFileSync(path.join(projectRoot, "docs", "security", "registry.json"), "utf8")
    );
    for (const w of registry.withdrawn ?? []) {
      assert.ok(w.reason && w.reason.length > 40, `${w.id} needs a substantive reason`);
      assert.ok(w.replacedBy, `${w.id} should say what replaced it`);
    }
    for (const c of registry.coverage ?? []) {
      assert.ok(c.covers && c.why, `${c.test} must say what it covers and why it is not a finding`);
    }
  });
});
