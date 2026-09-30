import { openExistingOrNew, replaceViaHandle } from "./safeFile.js";

/**
 * Record that setup has completed, by writing a timestamp to `filePath`.
 *
 * ## Why this exists as a function
 *
 * It was three lines inline in `src/routes/setup.ts`, which is a problem for a different
 * reason than the one it looks like: **nothing could test it.** The route needs a database,
 * a Redis and a bootstrapped owner to reach that line, so the write had no test, and a
 * defect with no test is a defect whose fix is taken on trust.
 *
 * Extracting it costs nothing and makes the symlink refusal assertable directly.
 *
 * ## The defect it fixes (SEC-069)
 *
 * The inline version was:
 *
 * ```ts
 * await fs.writeFile(SETUP_MARKER_PATH, new Date().toISOString(), "utf-8");
 * ```
 *
 * `writeFile` takes a name and follows a symlink planted at it — in the steady state, with
 * no race and no timing. The marker is written to a path resolved from `__dirname`, and
 * `keystone-config-writes-by-descriptor` in `.semgrep.yml` was scoped to
 * `src/services/setup/**`, so this one file sat outside the rule that exists to catch
 * exactly this. The rule's scope was the directory that happened to contain the code being
 * fixed, which is how a rule stops being about the defect and becomes about the folder.
 *
 * The severity is the same low as SEC-065 and should not be inflated: whoever can plant a
 * symlink in the application directory can already do more than cause one stray write. The
 * primitive worth withdrawing is "write to any path this process can write, following
 * whatever is there", and `openExistingOrNew` + `replaceViaHandle` withdraw it by opening
 * once with `O_NOFOLLOW` and writing through that single descriptor.
 */
export async function writeSetupMarker(filePath: string, content: string): Promise<void> {
  const marker = await openExistingOrNew(filePath);
  // Close in a `finally`, because `openExistingOrNew` hands back a live descriptor and
  // this is a function called on every successful setup.
  //
  // The first version of this omitted the close, and the suite said so in the only way a
  // suite can: `DeprecationWarning: Closing a FileHandle object on garbage collection`,
  // printed to stderr between two passing tests. Four passing tests and a leaked
  // descriptor is the shape of a fix that works and is still wrong — the marker is
  // written correctly and the process keeps a file open for every setup it completes.
  // `configWriter` closes in a `finally` at every one of its eight open sites; this is the
  // same rule, arrived at by being told.
  try {
    await replaceViaHandle(marker.handle, content);
  } finally {
    await marker.handle.close().catch(() => {});
  }
}
