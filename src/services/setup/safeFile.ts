import fs from "node:fs/promises";
import { constants as C, type Stats } from "node:fs";

/**
 * Opening a configuration file without a window between checking it and writing it.
 *
 * ## The two problems, which are not the same problem
 *
 * **A race.** `EnvFileConfigWriter.write` did `fs.stat(path)`, checked the result
 * was a regular file, and then called `fs.writeFile(path, …)`. Those are two
 * separate resolutions of the same name. Anything that can replace the path between
 * them — a symlink — makes the second resolution land somewhere else entirely.
 * CodeQL flagged it as `js/file-system-race`, twice, and it was right.
 *
 * **A symlink, in the steady state.** The race is the narrow version. The wide one
 * is that `fs.writeFile` follows a symlink *by design*, so a `.env` that is a
 * symlink is not a race at all — it is the ordinary case, and the writer will
 * read the target, merge into it, and overwrite it with mode `0600`. No timing
 * required. Fixing only the window would have left the more common half untouched.
 *
 * Both are closed the same way: **do every step through one file descriptor.**
 *
 * - `O_NOFOLLOW` makes the kernel refuse to open a final-component symlink rather
 *   than resolve it. This is the part that removes the steady-state problem, and it
 *   is the part a stat-then-write fix would miss.
 * - Reading and writing through the *same handle* means there is no second path
 *   resolution to attack, so there is no window left to close. The `fstat` is on
 *   the handle, so it describes the file that is about to be written rather than
 *   whatever the name pointed at a moment ago.
 *
 * ## The error codes, measured rather than assumed
 *
 * `open` refuses some paths before any descriptor exists, and the codes are not
 * what a reading of the manual suggests. Probed on this platform:
 *
 * | what is at the path        | `open` with `O_NOFOLLOW` | code    |
 * |----------------------------|--------------------------|---------|
 * | a directory                | refused                  | EISDIR  |
 * | a symlink (final component)| refused                  | ELOOP   |
 * | a symlink, with `O_EXCL`   | refused                  | EEXIST  |
 * | a FIFO, a socket, a device | **opens**                | —       |
 *
 * The last row is why the `fstat` below is not dead code. A directory is caught by
 * `open`, so concluding from that alone that the stat check could never run would
 * have been wrong — and the FIFO case in the test suite is what proves it is not.
 *
 * An earlier version also mapped `ENOTDIR` to a symlink, on the theory that some
 * filesystems report a refused link that way. `ENOTDIR` actually means a path
 * *component* is not a directory: a different problem with a different cause, and
 * folding it in would have produced a message pointing at the wrong thing.
 *
 * ## What this does not fix, stated plainly
 *
 * `O_NOFOLLOW` applies to the **final** path component. A symlink in a parent
 * directory is still followed, and closing that needs `openat` with `O_NOFOLLOW` on
 * every component — which Node's `fs` does not expose. Anyone who can replace a
 * parent directory of your config file can already replace the config file, so this
 * is not a meaningful escalation; but "this closes the symlink problem" would be an
 * overstatement, so it is written here instead.
 *
 * `O_NOFOLLOW` is also absent on Windows, where `fs.constants.O_NOFOLLOW` is
 * `undefined`. The flag is then omitted and the protection is genuinely gone. That
 * is reported rather than papered over: {@link symlinkProtection} says which of the
 * two you are getting, so a caller can refuse to proceed if it needs the real thing.
 */

/** Whether the kernel will refuse a final-component symlink on this platform. */
export const symlinkProtection: "O_NOFOLLOW" | "unavailable" =
  typeof C.O_NOFOLLOW === "number" ? "O_NOFOLLOW" : "unavailable";

const NOFOLLOW = typeof C.O_NOFOLLOW === "number" ? C.O_NOFOLLOW : 0;

/** What {@link openExistingOrNew} hands back. */
export interface OpenFile {
  /** The single descriptor every read and write goes through. */
  handle: fs.FileHandle;
  /** `fstat` on the **handle**, so it describes the file that will be written. */
  stats: Stats;
  /** Whether the file already existed when it was opened. */
  existed: boolean;
}

/**
 * The path exists and is not something this writer will touch.
 *
 * Reached two ways, and both are handled: `open` refuses a directory with `EISDIR`,
 * while a FIFO, a socket or a device node open successfully and are caught only by
 * the `fstat` afterwards.
 */
export class NotAFileError extends Error {
  constructor(readonly filePath: string) {
    super(`${filePath} exists but is not a regular file`);
    this.name = "NotAFileError";
  }
}

/**
 * A name that already exists, and this writer will not overwrite it.
 *
 * Separate from {@link SymlinkError} because the two need different answers from a
 * caller: a collision means pick another name, a link means something is trying to
 * redirect the write.
 */
export class AlreadyExistsError extends Error {
  constructor(readonly filePath: string) {
    super(`${filePath} already exists, and this writer will not overwrite it`);
    this.name = "AlreadyExistsError";
  }
}

/** The path is a symbolic link, and this writer will not follow one. */
export class SymlinkError extends Error {
  constructor(readonly filePath: string) {
    super(
      `${filePath} is a symbolic link, and this writer refuses to follow one. ` +
        `Writing through a link would put the contents wherever the link points.`
    );
    this.name = "SymlinkError";
  }
}

/**
 * Turn an `open` failure into the refusal it actually is.
 *
 * Async because the `EEXIST` case needs one `lstat` to say which of two very
 * different things it is: a name that is already taken, or a link planted to
 * redirect the write.
 */
async function refusalFor(filePath: string, error: unknown): Promise<Error | null> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP") return new SymlinkError(filePath);
  if (code === "EISDIR") return new NotAFileError(filePath);
  if (code === "EEXIST") {
    // O_EXCL reports a name that already exists as EEXIST whether what is there is
    // a file or a link, and the two deserve different messages. lstat is the one
    // call here that is *meant* to see a symlink; it decides nothing about whether
    // to follow one.
    const existing = await fs.lstat(filePath).catch(() => null);
    if (existing?.isSymbolicLink()) return new SymlinkError(filePath);
    return new AlreadyExistsError(filePath);
  }
  return null;
}

/**
 * Open a file for reading and writing, creating it if absent, and refuse a symlink.
 *
 * `excl` is for destinations that must not already exist — a backup, say — where
 * `O_EXCL` refuses both an existing file and a symlink at that name.
 */
export async function openExistingOrNew(
  filePath: string,
  options: { mode?: number; excl?: boolean } = {}
): Promise<OpenFile> {
  const { mode = 0o600, excl = false } = options;

  // Whether the file is already there, answered with `lstat` so that "does this
  // exist" is asked the same way the open will be asked. This is reported, never
  // used to decide anything: the decision is the open's.
  const existed = await fs
    .lstat(filePath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, C.O_RDWR | (excl ? C.O_EXCL : C.O_CREAT) | NOFOLLOW, mode);
  } catch (error) {
    throw (await refusalFor(filePath, error)) ?? error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new NotAFileError(filePath);
    return { handle, stats, existed };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Open a file read-only, refusing a symlink. `null` when it does not exist. */
export async function openExistingOrNull(filePath: string): Promise<OpenFile | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, C.O_RDONLY | NOFOLLOW, 0o600);
  } catch (error) {
    const refusal = await refusalFor(filePath, error);
    if (refusal) throw refusal;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new NotAFileError(filePath);
    return { handle, stats, existed: true };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Read the whole file **through the handle**, leaving the offset at the end. */
export async function readViaHandle(handle: fs.FileHandle): Promise<string> {
  const chunks: Buffer[] = [];
  // A read at an explicit position, so this does not depend on where the descriptor
  // happens to be. `readFile` on a handle reads from the current offset, which is a
  // detail that only matters once something else has moved it.
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Replace the file's contents **through the handle**.
 *
 * The position is explicit because reading and writing share one descriptor: after
 * {@link readViaHandle} the offset is at end-of-file, and a plain `writeFile` on the
 * handle would append to what it just read. That is the bug this function exists to
 * make impossible rather than to document.
 */
export async function replaceViaHandle(handle: fs.FileHandle, content: string): Promise<void> {
  const bytes = Buffer.from(content, "utf-8");
  await handle.truncate(0);
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written);
    if (bytesWritten === 0) throw new Error("write made no progress");
    written += bytesWritten;
  }
  await handle.sync();
}

/** Create a file that must not already exist, refusing a symlink. */
export async function createExclusive(filePath: string, content: string, mode = 0o600): Promise<void> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, mode);
  } catch (error) {
    throw (await refusalFor(filePath, error)) ?? error;
  }
  try {
    const bytes = Buffer.from(content, "utf-8");
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written);
      if (bytesWritten === 0) throw new Error("write made no progress");
      written += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}
