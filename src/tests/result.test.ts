import { describe, it } from "node:test";
import assert from "node:assert";
import { ok, err, errFromMessage, mapResult, flatMapResult } from "../lib/result.js";

describe("Result<T> helpers", () => {
  it("ok wraps data in a success result", () => {
    const result = ok(42);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data, 42);
    assert.strictEqual(result.error, undefined);
  });

  it("err wraps an error in a failure result", () => {
    const result = err<number>({ code: "FAIL", message: "failed" });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error.code, "FAIL");
    assert.strictEqual(result.error.message, "failed");
  });

  it("errFromMessage builds a failure result from code and message", () => {
    const result = errFromMessage<number>("NOT_FOUND", "missing", 404);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error.code, "NOT_FOUND");
    assert.strictEqual(result.error.statusCode, 404);
  });

  it("mapResult transforms success data", async () => {
    const mapped = mapResult(ok(2), (n) => n * 3);
    assert.strictEqual(mapped.success, true);
    assert.strictEqual(mapped.data, 6);
  });

  it("mapResult propagates errors", async () => {
    const error = errFromMessage<number>("BAD", "bad");
    const mapped = mapResult(error, (n) => n * 3);
    assert.strictEqual(mapped.success, false);
    assert.strictEqual(mapped.error.code, "BAD");
  });

  it("flatMapResult chains async results", async () => {
    const chained = await flatMapResult(ok(2), async (n) => ok(n * 3));
    assert.strictEqual(chained.success, true);
    assert.strictEqual(chained.data, 6);
  });

  it("flatMapResult short-circuits on failure", async () => {
    const error = errFromMessage<number>("BAD", "bad");
    const chained = await flatMapResult(error, async () => ok(99));
    assert.strictEqual(chained.success, false);
    assert.strictEqual(chained.error.code, "BAD");
  });
});
