import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ok, err, type Result } from "../../lib/result.js";
import type { ConfigWriter } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export class EnvFileConfigWriter implements ConfigWriter {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(__dirname, "../../../.env");
  }

  async read(): Promise<Record<string, string | undefined>> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const values: Record<string, string | undefined> = {};
      for (const line of content.split(/\r?\n/)) {
        const { key, value } = parseEnvLine(line);
        if (key) values[key] = value;
      }
      return values;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async write(values: Record<string, string>): Promise<Result<void>> {
    try {
      const stats = await fs.stat(this.filePath).catch(() => null);
      if (stats && !stats.isFile()) {
        return err({ code: "NOT_A_FILE", message: `${this.filePath} is not a regular file`, statusCode: 400 });
      }

      const existing = await this.read();
      const merged = { ...existing, ...values };

      // Preserve comments and ordering from existing file when possible.
      let lines: string[] = [];
      try {
        const content = await fs.readFile(this.filePath, "utf-8");
        lines = content.split(/\r?\n/);
      } catch {
        // File does not exist yet; start fresh.
      }

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

      await fs.writeFile(this.filePath, updatedLines.join("\n") + "\n", { mode: 0o600 });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: "WRITE_FAILED", message, statusCode: 500 });
    }
  }

  async backup(): Promise<Result<string>> {
    try {
      const stats = await fs.stat(this.filePath).catch(() => null);
      if (!stats || !stats.isFile()) {
        return ok("");
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${this.filePath}.backup-${timestamp}`;
      await fs.copyFile(this.filePath, backupPath);
      return ok(backupPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: "BACKUP_FAILED", message, statusCode: 500 });
    }
  }
}

export class JsonConfigWriter implements ConfigWriter {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(__dirname, "../../../config/keystone.json");
  }

  async read(): Promise<Record<string, string | undefined>> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null) return {};
      const result: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(parsed)) {
        result[key] = typeof value === "string" ? value : String(value);
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async write(values: Record<string, string>): Promise<Result<void>> {
    try {
      const existing = await this.read();
      const merged = { ...existing, ...values };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: "WRITE_FAILED", message, statusCode: 500 });
    }
  }

  async backup(): Promise<Result<string>> {
    try {
      const stats = await fs.stat(this.filePath).catch(() => null);
      if (!stats || !stats.isFile()) {
        return ok("");
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${this.filePath}.backup-${timestamp}`;
      await fs.copyFile(this.filePath, backupPath);
      return ok(backupPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err({ code: "BACKUP_FAILED", message, statusCode: 500 });
    }
  }
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
