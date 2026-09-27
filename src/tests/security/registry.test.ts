import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../..");

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
});
