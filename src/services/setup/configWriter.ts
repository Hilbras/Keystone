import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ok, err, type Result } from "../../lib/result.js";
import type { ConfigWriter } from "./types.js";
import {
  NotAFileError,
  SymlinkError,
  createExclusive,
  openExistingOrNew,
  openExistingOrNull,
  readViaHandle,
  replaceViaHandle,
} from "./safeFile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The configuration writers.
 *
 * Every file access here goes through a single file descriptor opened with
 * `O_NOFOLLOW` — see `./safeFile.ts` for why, and for what it does not cover.
 *
 * Before, `write()` did `fs.stat(path)`, checked the result was a regular file, and
 * then called `fs.writeFile(path, …)`: two resolutions of the same name with a
 * window between them, and a writer that followed a symlink in the steady state
 * rather than only during one. CodeQL flagged the race twice as
 * `js/file-system-race`, and it was right about the shape while the symlink half
 * was the larger problem.
 *
 * The merge behaviour is deliberately unchanged. `write()` still merges plain
 * `{ ...existing, ...values }`, because the two callers need different things from
 * it: `routes/config.ts` passes a **fully merged** set — it has already applied
 * redaction and will not send a secret it was shown as `••••` — while
 * `routes/setup.ts` passes only the new values and relies on this merge to preserve
 * the rest of the file. Unifying those would change what one of them writes.
 */

function formatEnvValue(value: string): string {
  // Quote values that contain whitespace or special characters.
  if (/[\s#'"]/.test(value)) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

function parseEnvLine(line: string): { key?: string; value?: string; comment?: boolean } {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return { comment: true };
  }
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return { comment: true };
  let value = match[2];
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return { key: match[1], value };
}

function parseEnvValues(content: string): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const line of content.split(/\r?\n/)) {
    const { key, value } = parseEnvLine(line);
    if (key) values[key] = value;
  }
  return values;
}

/** Build the new file body, preserving comments and ordering from `raw`. */
function buildEnvContent(raw: string, merged: Record<string, string | undefined>): string {
  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();
  const updatedLines: string[] = [];

  for (const line of lines) {
    const { key } = parseEnvLine(line);
    if (key && key in merged) {
      updatedLines.push(`${key}=${formatEnvValue(merged[key]!)}`);
      seen.add(key);
    } else {
      updatedLines.push(line);
    }
  }

  // Append any new keys at the end.
  const newKeys = Object.keys(merged).filter((k) => !seen.has(k));
  if (newKeys.length > 0) {
    if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== "") {
      updatedLines.push("");
    }
    for (const key of newKeys) {
      updatedLines.push(`${key}=${formatEnvValue(merged[key]!)}`);
    }
  }

  return updatedLines.join("\n") + "\n";
}

/** A timestamped, collision-free-enough backup name beside the target. */
function backupNameFor(filePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${filePath}.backup-${timestamp}`;
}

/** Map a refusal to the Result the routes already know how to answer. */
function writeFailure(error: unknown): { code: string; message: string; statusCode: number } {
  if (error instanceof SymlinkError) {
    // 400, not 500: the request was refused because of what is at that path, and
    // retrying will not change it. The message says what to do about it.
    return { code: "SYMLINK_REFUSED", message: error.message, statusCode: 400 };
  }
  if (error instanceof NotAFileError) {
    return { code: "NOT_A_FILE", message: error.message, statusCode: 400 };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "WRITE_FAILED", message, statusCode: 500 };
}

export class EnvFileConfigWriter implements ConfigWriter {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(__dirname, "../../../.env");
  }

  async read(): Promise<Record<string, string | undefined>> {
    const open = await openExistingOrNull(this.filePath);
    if (!open) return {};
    try {
      return parseEnvValues(await readViaHandle(open.handle));
    } finally {
      await open.handle.close().catch(() => {});
    }
  }

  async write(values: Record<string, string>): Promise<Result<void>> {
    let open;
    try {
      // One descriptor for the read and the write. There is no second resolution
      // of the path, so there is no window between deciding what is there and
      // replacing it.
      open = await openExistingOrNew(this.filePath);
    } catch (error) {
      return err(writeFailure(error));
    }
    try {
      const raw = (await readViaHandle(open.handle)).trimEnd();
      const existing = parseEnvValues(raw);
      const merged = { ...existing, ...values };
      await replaceViaHandle(open.handle, buildEnvContent(raw, merged));
      return ok(undefined);
    } catch (error) {
      return err(writeFailure(error));
    } finally {
      await open.handle.close().catch(() => {});
    }
  }

  async backup(): Promise<Result<string>> {
    let open;
    let content: string;
    try {
      open = await openExistingOrNull(this.filePath);
      if (!open) return ok("");
      content = await readViaHandle(open.handle);
    } catch (error) {
      await open?.handle.close().catch(() => {});
      const failure = writeFailure(error);
      return err({ ...failure, code: failure.code === "WRITE_FAILED" ? "BACKUP_FAILED" : failure.code });
    }
    try {
      // `O_EXCL`, so a name that already exists — or a symlink planted at the
      // backup path — is refused rather than written through.
      const backupPath = backupNameFor(this.filePath);
      await createExclusive(backupPath, content);
      return ok(backupPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: "BACKUP_FAILED", message, statusCode: 500 });
    } finally {
      await open.handle.close().catch(() => {});
    }
  }
}

export class JsonConfigWriter implements ConfigWriter {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(__dirname, "../../../config/keystone.json");
  }

  async read(): Promise<Record<string, string | undefined>> {
    const open = await openExistingOrNull(this.filePath);
    if (!open) return {};
    try {
      const parsed = JSON.parse(await readViaHandle(open.handle));
      if (typeof parsed !== "object" || parsed === null) return {};
      const result: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(parsed)) {
        result[key] = typeof value === "string" ? value : String(value);
      }
      return result;
    } finally {
      await open.handle.close().catch(() => {});
    }
  }

  async write(values: Record<string, string>): Promise<Result<void>> {
    let open;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      open = await openExistingOrNew(this.filePath);
    } catch (error) {
      return err(writeFailure(error));
    }
    try {
      const existing = parseJson(await readViaHandle(open.handle));
      const merged = { ...existing, ...values };
      await replaceViaHandle(open.handle, JSON.stringify(merged, null, 2) + "\n");
      return ok(undefined);
    } catch (error) {
      return err(writeFailure(error));
    } finally {
      await open.handle.close().catch(() => {});
    }
  }

  async backup(): Promise<Result<string>> {
    let open;
    let content: string;
    try {
      open = await openExistingOrNull(this.filePath);
      if (!open) return ok("");
      content = await readViaHandle(open.handle);
    } catch (error) {
      await open?.handle.close().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: "BACKUP_FAILED", message, statusCode: 500 });
    }
    try {
      const backupPath = backupNameFor(this.filePath);
      await createExclusive(backupPath, content);
      return ok(backupPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: "BACKUP_FAILED", message, statusCode: 500 });
    } finally {
      await open.handle.close().catch(() => {});
    }
  }
}

function parseJson(content: string): Record<string, string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // A file that is not valid JSON is treated as empty rather than failing the
    // write, which is what the previous `read()` did by returning `{}` on any
    // parse error. Overwriting unparseable input is a separate decision.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(parsed)) {
    result[key] = typeof value === "string" ? value : String(value);
  }
  return result;
}

export function createConfigWriter(): ConfigWriter {
  const mode = process.env.KEYSTONE_CONFIG_MODE?.toLowerCase();
  if (mode === "json" || isRunningInDocker()) {
    return new JsonConfigWriter();
  }
  return new EnvFileConfigWriter();
}

function isRunningInDocker(): boolean {
  // Best-effort detection: presence of /.dockerenv or docker in cgroup.
  try {
    const fs = require("node:fs");
    if (fs.existsSync("/.dockerenv")) return true;
    const cgroup = fs.readFileSync("/proc/self/cgroup", "utf-8");
    return cgroup.includes("docker") || cgroup.includes("containerd");
  } catch {
    return false;
  }
}
