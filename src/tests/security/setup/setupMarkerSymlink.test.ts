import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SymlinkError, symlinkProtection } from "../../../services/setup/safeFile.js";
import { writeSetupMarker } from "../../../services/setup/setupMarker.js";

/**
 * The setup completion marker. (SEC-069)
 *
 * **What was wrong.** `src/routes/setup.ts` wrote it with
 * `fs.writeFile(SETUP_MARKER_PATH, …)`, where the path is resolved from `__dirname`.
 * `writeFile` takes a name and follows a symlink planted at it — in the steady state, with
 * no race involved. The marker is a timestamp, so the contents are not sensitive; what is
 * withdrawn is the primitive, "write to any path this process can write, following whatever
 * is there".
 *
 * **Why it survived SEC-065.** The semgrep rule that catches exactly this,
 * `keystone-config-writes-by-descriptor`, was scoped to `src/services/setup/**` — the
 * directory that happened to contain the code being fixed. This call sat one file over, in
 * `src/routes/`, and so outside a rule that was really about the defect. The rule's scope
 * was widened in the same change.
 *
 * **Why the write was extracted.** It was three inline lines behind a route that needs a
 * database, a Redis and a bootstrapped owner, so there was no way to reach it from a test.
 * A defect whose fix can only be taken on trust is not fixed so much as asserted, and this
 * one now has the same end-to-end assertion the config writer has: the symlink target's
 * content is unchanged.
 */
let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "keystone-marker-"));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const STAMP = "2026-09-30T00:00:00.000Z";

describe("the setup completion marker", () => {
  it("writes the marker when nothing is in the way", async () => {
    const marker = path.join(dir, ".keystone-setup-complete");
    await writeSetupMarker(marker, STAMP);
    assert.equal(await fsp.readFile(marker, "utf-8"), STAMP);
  });

  it("replaces an existing marker rather than failing on it", async () => {
    // The second setup attempt is the ordinary case, not an edge one: the marker is
    // there precisely because setup already ran once. `createExclusive` would be wrong
    // here, and a reader of the file could easily assume otherwise.
    const marker = path.join(dir, ".keystone-setup-complete");
    await fsp.writeFile(marker, "an earlier run", "utf-8");
    await writeSetupMarker(marker, STAMP);
    assert.equal(await fsp.readFile(marker, "utf-8"), STAMP);
  });

  it("does not write through a symlink planted at the marker path", async (t) => {
    if (symlinkProtection === "unavailable") {
      t.skip("O_NOFOLLOW is not available on this platform");
      return;
    }
    const elsewhere = path.join(dir, "elsewhere.txt");
    const victim = "do not overwrite me";
    await fsp.writeFile(elsewhere, victim, "utf-8");

    const marker = path.join(dir, ".keystone-setup-complete");
    await fsp.symlink(elsewhere, marker);

    await assert.rejects(() => writeSetupMarker(marker, STAMP), SymlinkError);

    // The assertion that matters, and the one that stays green for the wrong reason if
    // the write is merely reordered: the file the link points at is untouched.
    assert.equal(
      await fsp.readFile(elsewhere, "utf-8"),
      victim,
      "the symlink target was overwritten. This is the whole defect: `writeFile` follows " +
        "the link in the steady state, so no race is required for the contents to land " +
        "wherever the link points."
    );
    // And the link itself is still a link, rather than having been replaced by a file.
    assert.ok((await fsp.lstat(marker)).isSymbolicLink(), "the marker path was replaced");
  });

  it("refuses a directory in the marker's place, rather than writing into it", async () => {
    // The other steady-state hazard: `writeFile` on a directory fails with EISDIR, and
    // `safeFile` turns that into a refusal that says which thing it was.
    const marker = path.join(dir, ".keystone-setup-complete");
    await fsp.mkdir(marker);
    await assert.rejects(() => writeSetupMarker(marker, STAMP), /symbolic link|not a regular file/i);
  });

  it("closes the descriptor, including when the write is refused", async () => {
    // The first version of `writeSetupMarker` did not close the handle. Nothing failed:
    // the marker was written correctly and all four other tests passed. The only evidence
    // was `DeprecationWarning: Closing a FileHandle object on garbage collection` on
    // stderr — a leak that shows up as a warning until the process runs out of descriptors.
    //
    // A warning is not a test, so this is. It reads the open descriptor count before and
    // after, which is a real property rather than a proxy for one.
    const marker = path.join(dir, ".keystone-setup-complete");
    const openDescriptors = async (): Promise<number> => {
      const entries = await fsp.readdir("/proc/self/fd").catch(() => null);
      return entries ? entries.length : -1;
    };

    const before = await openDescriptors();
    assert.ok(before > 0, "this check needs /proc; skipping rather than passing silently");

    for (let i = 0; i < 25; i++) {
      await writeSetupMarker(marker, `${STAMP}#${i}`);
    }
    const afterWrites = await openDescriptors();
    assert.ok(
      afterWrites - before < 5,
      `25 marker writes grew the open descriptor count by ${afterWrites - before}. Each ` +
        `call opens a descriptor, so a handle that is never closed leaks one per setup.`
    );

    // And on the refusal path, which is a separate `finally` in every implementation that
    // has one — a `catch` that returns early skips a close placed after it.
    const link = path.join(dir, "link-marker");
    const target = path.join(dir, "target.txt");
    await fsp.writeFile(target, "untouched", "utf-8");
    await fsp.symlink(target, link);
    const beforeRefusals = await openDescriptors();
    for (let i = 0; i < 25; i++) {
      await assert.rejects(() => writeSetupMarker(link, STAMP), SymlinkError);
    }
    const afterRefusals = await openDescriptors();
    assert.ok(
      afterRefusals - beforeRefusals < 5,
      `25 refused marker writes grew the open descriptor count by ${afterRefusals - beforeRefusals}. ` +
        `The refusal path must close the descriptor too.`
    );
  });
});
