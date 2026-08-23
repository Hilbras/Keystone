import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EnvFileConfigWriter, JsonConfigWriter } from "../../services/setup/configWriter.js";

describe("EnvFileConfigWriter", () => {
  it("writes and reads values", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "keystone-env-"));
    const file = path.join(dir, ".env");
    const writer = new EnvFileConfigWriter(file);

    const result = await writer.write({ DATABASE_URL: "postgres://localhost/db", REDIS_URL: "redis://localhost" });
    assert.strictEqual(result.success, true);

    const values = await writer.read();
    assert.strictEqual(values.DATABASE_URL, "postgres://localhost/db");
    assert.strictEqual(values.REDIS_URL, "redis://localhost");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves existing comments and ordering", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "keystone-env-"));
    const file = path.join(dir, ".env");
    await fs.writeFile(file, "# Database\nDATABASE_URL=old\n\n# Redis\nREDIS_URL=old\n");

    const writer = new EnvFileConfigWriter(file);
    await writer.write({ DATABASE_URL: "new" });

    const content = await fs.readFile(file, "utf-8");
    assert.ok(content.includes("# Database"));
    assert.ok(content.includes("# Redis"));
    assert.ok(content.includes("DATABASE_URL=new"));
    assert.ok(content.includes("REDIS_URL=old"));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates backups", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "keystone-env-"));
    const file = path.join(dir, ".env");
    await fs.writeFile(file, "DATABASE_URL=old\n");

    const writer = new EnvFileConfigWriter(file);
    const backup = await writer.backup();
    assert.strictEqual(backup.success, true);
    assert.ok(backup.data);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("JsonConfigWriter", () => {
  it("writes and reads values", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "keystone-json-"));
    const file = path.join(dir, "config.json");
    const writer = new JsonConfigWriter(file);

    const result = await writer.write({ DATABASE_URL: "postgres://localhost/db" });
    assert.strictEqual(result.success, true);

    const values = await writer.read();
    assert.strictEqual(values.DATABASE_URL, "postgres://localhost/db");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
