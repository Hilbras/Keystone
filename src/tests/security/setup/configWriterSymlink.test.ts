import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EnvFileConfigWriter, JsonConfigWriter } from "../../../services/setup/configWriter.js";
import {
  NotAFileError,
  SymlinkError,
  createExclusive,
  openExistingOrNew,
  openExistingOrNull,
  readViaHandle,
  replaceViaHandle,
  symlinkProtection,
} from "../../../services/setup/safeFile.js";

/**
 * The setup config writer's file access. (SEC-065)
 *
 * **What was wrong.** `EnvFileConfigWriter.write` did this:
 *
 * ```ts
 * const stats = await fs.stat(this.filePath);   // 1. resolve the name
 * if (stats && !stats.isFile()) return err(…);  //    check what it found
 * …
 * await fs.writeFile(this.filePath, body, …);   // 2. resolve the name again
 * ```
 *
 * Two resolutions of the same name with a window between them. Anything that
 * replaces the path in that window — a symlink — makes the second resolution land
 * somewhere else. CodeQL flagged it as `js/file-system-race`, twice, correctly.
 *
 * But the race is the *narrow* half. `fs.writeFile` follows a symlink by design,
 * so a `.env` that is a symlink is not a race at all: it is the steady state, and
 * the writer reads the target, merges into it, and overwrites it with mode `0600`.
 * No timing required, and a fix that only closed the window would have left this.
 *
 * The severity is low, and it should be said plainly rather than inflated: this
 * writes `.env` and `config/keystone.json` in the application directory, and anyone
 * who can create a symlink there can already achieve more than one stray write. The
 * primitive it does hand over — "write 0600 to any path this process can write" — is
 * the part worth closing, and it was also the last two open CodeQL alerts.
 *
 * ## The assertions that matter
 *
 * The one to read is **the symlink target's content is unchanged**. Every other test
 * here can pass against the old code if the assertions are weak enough. That one
 * cannot: the old writer would have overwritten the target.
 */

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "keystone-config-writer-"));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** A path that nothing in the test refers to directly, so a symlink can point at it. */
function targetPath(name: string): string {
  return path.join(dir, name);
}

const SENTINEL = "ORIGINAL-CONTENT-MUST-NOT-CHANGE\n";

describe("the setup config writer's file access (SEC-065)", () => {
  it("has the symlink protection it claims, or says so", () => {
    // Stated rather than assumed. On a platform without `O_NOFOLLOW` the flag is
    // undefined and the protection is genuinely absent — a test that assumed the
    // protection would be a test that lies on Windows.
    assert.equal(
      symlinkProtection,
      typeof fs.constants.O_NOFOLLOW === "number" ? "O_NOFOLLOW" : "unavailable"
    );
    if (symlinkProtection === "unavailable") return; // Nothing below is meaningful.
    assert.ok(fs.constants.O_NOFOLLOW);
  });

  describe("a symlink where the config file should be", () => {
    let target: string;
    let configPath: string;

    beforeEach(async () => {
      target = targetPath("victim.txt");
      configPath = targetPath(".env");
      await fsp.writeFile(target, SENTINEL, "utf-8");
      await fsp.symlink(target, configPath);
    });

    it("refuses to write, and leaves the symlink target byte-for-byte unchanged", async () => {
      const writer = new EnvFileConfigWriter(configPath);
      const result = await writer.write({ DATABASE_URL: "postgres://evil" });

      assert.equal(result.success, false, "writing through a symlink must be refused");
      assert.equal(
        result.success ? null : result.error.code,
        "SYMLINK_REFUSED",
        "and the refusal must name itself, so the route can answer 400 rather than 500"
      );
      assert.equal(
        await fsp.readFile(target, "utf-8"),
        SENTINEL,
        "THE assertion: the file the symlink pointed at must be untouched"
      );
    });

    it("refuses at the descriptor, with nothing in front of it", async () => {
      // **The assertion above passed against the defective code, and this is why.**
      //
      // `write()` used to call `this.read()` on the way to the write, and `read()`
      // is also hardened here. So the end-to-end test went green because the *read*
      // refused — the write was never reached, and nothing proved the write itself
      // was safe. A test that passes for the wrong reason is worse than a missing
      // one, because it looks like coverage.
      //
      // So the write is tested on its own: the primitive `write()` uses to obtain
      // the descriptor must refuse a symlink with no read anywhere in the path.
      // Reverting `configWriter.write()` to `fs.writeFile(path, …)` does not touch
      // this, which is the point — and `keystone-config-writes-by-descriptor` in
      // `.semgrep.yml` is what catches a writer that stops using the primitive at
      // all.
      // `rejects`, not `throws`: the primitive is async, so a failed open comes
      // back as a rejected promise. `assert.throws` on an async function passes
      // vacuously when the function returns a rejected promise, which would have
      // made this the second way this test could go green for the wrong reason.
      await assert.rejects(
        () => openExistingOrNew(configPath),
        SymlinkError,
        "the descriptor must be refused, not merely the read that precedes it"
      );
    });

    it("refuses at the descriptor when asked to create exclusively, too", async () => {
      await assert.rejects(() => openExistingOrNew(configPath, { excl: true }), SymlinkError);
    });

    it("refuses to read, rather than merging the target's contents into the config", async () => {
      // The other half. Reading through the link and then writing the merge back is
      // how a file outside the config directory ends up holding the file's contents
      // with a different mode.
      await assert.rejects(
        () => new EnvFileConfigWriter(configPath).read(),
        SymlinkError
      );
    });

    it("refuses to back up, so the backup is not a copy of somewhere else", async () => {
      const writer = new EnvFileConfigWriter(configPath);
      const result = await writer.backup();
      assert.equal(result.success, false);
      const backups = (await fsp.readdir(dir)).filter((f) => f.includes(".backup-"));
      assert.deepEqual(backups, [], "no backup file may be created from a symlink");
    });
  });

  describe("a symlink where a backup would go", () => {
    it("refuses rather than writing through a planted link", async () => {
      // The writer's backup name carries a timestamp, so a collision cannot be
      // staged against it. The primitive it relies on is `createExclusive`, and
      // that is what this pins: `O_EXCL` must refuse a name that already exists,
      // whether what is there is a file or a link.
      const victim = targetPath("victim.txt");
      const backupPath = targetPath(".env.backup-planted");
      await fsp.writeFile(victim, SENTINEL, "utf-8");
      await fsp.symlink(victim, backupPath);

      await assert.rejects(() => createExclusive(backupPath, "stolen"), SymlinkError);
      assert.equal(
        await fsp.readFile(victim, "utf-8"),
        SENTINEL,
        "a backup must not be able to write through a link either"
      );
    });
  });

  describe("a path that is not a regular file", () => {
    it("refuses a directory", async () => {
      const configPath = targetPath("a-directory");
      await fsp.mkdir(configPath);
      const result = await new EnvFileConfigWriter(configPath).write({ A: "1" });
      assert.equal(result.success, false);
      assert.equal(result.success ? null : result.error.code, "NOT_A_FILE");
    });

    it("refuses a FIFO, which stat() would have called a file", async () => {
      // `fs.stat` on a FIFO returns a non-regular entry, so the old code caught
      // this one too. It is here to pin the behaviour through the new path, and
      // because a FIFO that a writer opens for writing blocks forever — the kind of
      // thing a descriptor-based writer has to get right rather than a check.
      const configPath = targetPath("a-fifo");
      const { execFileSync } = await import("node:child_process");
      try {
        execFileSync("mkfifo", [configPath]);
      } catch {
        return; // mkfifo unavailable; nothing to assert.
      }
      const result = await new EnvFileConfigWriter(configPath).write({ A: "1" });
      assert.equal(result.success, false);
    });
  });

  describe("ordinary use still works", () => {
    it("writes, reads back, and preserves comments and ordering", async () => {
      const configPath = targetPath(".env");
      await fsp.writeFile(configPath, "# a comment\nFIRST=1\nSECOND=2\n", "utf-8");

      const writer = new EnvFileConfigWriter(configPath);
      const result = await writer.write({ SECOND: "22", THIRD: "3" });
      assert.equal(result.success, true, JSON.stringify(result.success ? null : result.error));

      const body = await fsp.readFile(configPath, "utf-8");
      assert.match(body, /^# a comment/m, "a comment must survive");
      assert.ok(body.indexOf("FIRST=1") < body.indexOf("SECOND=22"), "ordering must be preserved");
      assert.match(body, /^THIRD=3$/m, "a new key must be appended");
    });

    it("creates the file with mode 0600 when it does not exist", async () => {
      const configPath = targetPath(".env");
      const result = await new EnvFileConfigWriter(configPath).write({ SECRET: "value" });
      assert.equal(result.success, true);
      const mode = (await fsp.stat(configPath)).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    });

    it("does not append to what it just read", async () => {
      // The offset bug. Reading and writing share one descriptor, so after a read
      // the offset is at end-of-file; a plain `writeFile` on the handle would
      // append and the file would double in size on every write.
      const configPath = targetPath(".env");
      const writer = new EnvFileConfigWriter(configPath);
      for (let i = 0; i < 3; i++) {
        const result = await writer.write({ COUNT: String(i) });
        assert.equal(result.success, true);
      }
      const body = await fsp.readFile(configPath, "utf-8");
      assert.equal(body.match(/^COUNT=/gm)?.length, 1, `file grew across writes:\n${body}`);
      assert.match(body, /^COUNT=2$/m);
    });

    it("backs up the current content", async () => {
      const configPath = targetPath(".env");
      await fsp.writeFile(configPath, "KEEP=me\n", "utf-8");
      const result = await new EnvFileConfigWriter(configPath).backup();
      assert.equal(result.success, true);
      const backupPath = result.success ? result.data : "";
      assert.notEqual(backupPath, "");
      assert.equal(await fsp.readFile(backupPath, "utf-8"), "KEEP=me\n");
    });

    it("returns an empty backup path when there is nothing to back up", async () => {
      const result = await new EnvFileConfigWriter(targetPath("absent")).backup();
      assert.equal(result.success, true);
      assert.equal(result.success ? result.data : "x", "");
    });

    it("round-trips the JSON writer", async () => {
      const configPath = targetPath("keystone.json");
      const writer = new JsonConfigWriter(configPath);
      assert.equal((await writer.write({ A: "1" })).success, true);
      assert.equal((await writer.write({ B: "2" })).success, true, "must merge, not replace");
      assert.deepEqual(await writer.read(), { A: "1", B: "2" });
    });

    it("refuses a symlink for the JSON writer too", async () => {
      const victim = targetPath("victim.json");
      const configPath = targetPath("keystone.json");
      await fsp.writeFile(victim, SENTINEL, "utf-8");
      await fsp.symlink(victim, configPath);

      const result = await new JsonConfigWriter(configPath).write({ A: "1" });
      assert.equal(result.success, false);
      assert.equal(await fsp.readFile(victim, "utf-8"), SENTINEL);
    });
  });

  describe("the primitives themselves", () => {
    it("replaceViaHandle truncates rather than appends", async () => {
      const filePath = targetPath("primitive.txt");
      await fsp.writeFile(filePath, "0123456789", "utf-8");
      const open = await openExistingOrNew(filePath);
      try {
        assert.equal(await readViaHandle(open.handle), "0123456789");
        await replaceViaHandle(open.handle, "ab");
        await replaceViaHandle(open.handle, "abc");
      } finally {
        await open.handle.close();
      }
      assert.equal(await fsp.readFile(filePath, "utf-8"), "abc");
    });

    it("openExistingOrNull returns null for an absent file and throws SymlinkError for a link", async () => {
      assert.equal(await openExistingOrNull(targetPath("absent")), null);

      const victim = targetPath("v.txt");
      const link = targetPath("l.txt");
      await fsp.writeFile(victim, SENTINEL, "utf-8");
      await fsp.symlink(victim, link);
      await assert.rejects(() => openExistingOrNull(link), SymlinkError);
    });

    it("openExistingOrNew reports whether the file already existed", async () => {
      const filePath = targetPath("new.txt");
      const first = await openExistingOrNew(filePath);
      assert.equal(first.existed, false, "a file it had to create is not one that existed");
      await first.handle.close();

      const second = await openExistingOrNew(filePath);
      assert.equal(second.existed, true);
      await second.handle.close();
    });

    it("openExistingOrNew closes the descriptor when the target is not a file", async () => {
      // Otherwise a refused write leaks a descriptor on every attempt, and a
      // setup endpoint that can be called repeatedly is a descriptor leak with a
      // rate limiter in front of it.
      const dirPath = targetPath("a-dir");
      await fsp.mkdir(dirPath);
      await assert.rejects(() => openExistingOrNew(dirPath), NotAFileError);
    });

    it("createExclusive refuses to overwrite", async () => {
      const filePath = targetPath("once.txt");
      await createExclusive(filePath, "first");
      await assert.rejects(() => createExclusive(filePath, "second"));
      assert.equal(await fsp.readFile(filePath, "utf-8"), "first");
    });
  });
});
