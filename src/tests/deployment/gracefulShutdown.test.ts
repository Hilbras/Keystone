import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  installShutdownHandlers,
  resetShutdownStateForTests,
  runShutdown,
  type ShutdownDependencies,
} from "../../services/shutdown.js";

/**
 * §6.3. There were no signal handlers at all before this: SIGTERM killed the
 * process with Node's default disposition and severed every in-flight request.
 * These tests pin the two properties that make the handler useful — the order, and
 * that it terminates even when a dependency will not.
 */

function recorder(order: string[]) {
  return (name: string, result: "ok" | "throw" = "ok") => async () => {
    order.push(name);
    if (result === "throw") throw new Error(`${name} refused to close`);
  };
}

function silentOptions(exitCode: { code: number | null }) {
  return {
    exit: (code: number) => {
      exitCode.code = code;
    },
    log: () => {},
    error: () => {},
  };
}

beforeEach(() => resetShutdownStateForTests());

describe("graceful shutdown", () => {
  it("closes HTTP before the database before Redis", async () => {
    const order: string[] = [];
    const exitCode: { code: number | null } = { code: null };
    const deps: ShutdownDependencies = {
      closeApp: recorder(order)("http-server"),
      closeDatabase: recorder(order)("database"),
      closeRedis: recorder(order)("redis"),
    };

    const result = await runShutdown(deps, silentOptions(exitCode));

    // The database must outlive the queue (which drains inside `closeApp`), and
    // Redis last because the queue and cache own connections derived from it.
    assert.deepEqual(order, ["http-server", "database", "redis"]);
    assert.deepEqual(result.completed, ["http-server", "database", "redis"]);
    assert.equal(result.ok, true);
    assert.equal(exitCode.code, 0);
  });

  it("keeps closing the rest when one dependency refuses", async () => {
    const order: string[] = [];
    const exitCode: { code: number | null } = { code: null };
    const deps: ShutdownDependencies = {
      closeApp: recorder(order)("http-server", "throw"),
      closeDatabase: recorder(order)("database"),
      closeRedis: recorder(order)("redis"),
    };

    const result = await runShutdown(deps, silentOptions(exitCode));

    assert.deepEqual(order, ["http-server", "database", "redis"]);
    assert.deepEqual(result.completed, ["database", "redis"]);
    assert.equal(result.ok, true, "a failed close is reported, not a failed shutdown");
    assert.equal(exitCode.code, 0);
  });

  it("runs the sequence once even when two signals arrive", async () => {
    const order: string[] = [];
    const exitCode: { code: number | null } = { code: null };
    const deps: ShutdownDependencies = {
      closeApp: recorder(order)("http-server"),
      closeDatabase: recorder(order)("database"),
      closeRedis: recorder(order)("redis"),
    };

    const [first, second] = await Promise.all([
      runShutdown(deps, silentOptions(exitCode)),
      runShutdown(deps, silentOptions(exitCode)),
    ]);

    assert.equal(first, second, "both callers await the same shutdown");
    assert.deepEqual(order, ["http-server", "database", "redis"]);
    assert.equal(exitCode.code, 0);
  });

  it("exits non-zero when a dependency never settles", async () => {
    const exitCode: { code: number | null } = { code: null };
    const deps: ShutdownDependencies = {
      closeApp: () => new Promise<void>(() => {}),
      closeDatabase: async () => {},
      closeRedis: async () => {},
    };

    const result = await runShutdown(deps, { ...silentOptions(exitCode), timeoutMs: 25 });

    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.equal(exitCode.code, 1);
  });

  it("drains on SIGTERM and exits zero", async () => {
    const order: string[] = [];
    const exitCode: { code: number | null } = { code: null };
    const remove = installShutdownHandlers(
      {
        closeApp: recorder(order)("http-server"),
        closeDatabase: recorder(order)("database"),
        closeRedis: recorder(order)("redis"),
      },
      silentOptions(exitCode)
    );

    try {
      process.emit("SIGTERM");
      // The handler starts the sequence without blocking the emitter.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      remove();
    }

    assert.deepEqual(order, ["http-server", "database", "redis"]);
    assert.equal(exitCode.code, 0);
  });

  it("exits immediately on a second signal", async () => {
    const exitCode: { code: number | null } = { code: null };
    let release: (() => void) | undefined;
    const remove = installShutdownHandlers(
      {
        // Never settles until the test says so, so the second signal arrives while
        // the first shutdown is still draining.
        closeApp: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        closeDatabase: async () => {},
        closeRedis: async () => {},
      },
      silentOptions(exitCode)
    );

    try {
      process.emit("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.emit("SIGTERM");
      assert.equal(exitCode.code, 1, "the second signal must not wait for the drain");
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      remove();
    }
  });
});
