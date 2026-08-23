import { describe, it } from "node:test";
import assert from "node:assert";
import { validateDatabase, validateRedis } from "../../services/setup/validation.js";

describe("setup validation", () => {
  it("rejects missing database URL", async () => {
    const result = await validateDatabase({ databaseUrl: "" });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error?.code, "MISSING_DATABASE_URL");
  });

  it("fails for unreachable database", async () => {
    const result = await validateDatabase({ databaseUrl: "postgresql://invalid:5432/db" });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error?.code, "DATABASE_VALIDATION_FAILED");
  });

  it("rejects missing redis URL", async () => {
    const result = await validateRedis({ redisUrl: "" });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error?.code, "MISSING_REDIS_URL");
  });

  it("fails for unreachable redis", async () => {
    const result = await validateRedis({ redisUrl: "redis://invalid:6379" });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error?.code, "REDIS_VALIDATION_FAILED");
  });
});
