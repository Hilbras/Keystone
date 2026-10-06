import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");

/**
 * §2.5 — worker ownership.
 *
 * BullMQ already guarantees a job runs on one worker at a time. What it does not
 * expose is *which* one, so with two Keystone instances there was no way to answer
 * "is instance 3 still draining its queue, or did it die holding jobs?" — and that
 * question has to be answerable before a distributed lock (§2.4) can name an owner,
 * or a crashed owner (§6.4) can be identified so its work is recovered.
 *
 * The requirement is **uniqueness**, not presence. A worker id that was merely
 * populated would satisfy a `typeof job.workerId === "string"` assertion while
 * being useless: if two instances present the same id, "which one holds this job"
 * has no answer and a lease has no owner to name.
 *
 * That is why the uniqueness cases spawn real processes rather than calling a
 * function twice in one process — the pid and the random suffix both exist precisely
 * because two calls in one process are not two workers.
 */
describe("queue worker identity is unique per process (§2.5)", () => {
  let WORKER_ID: string;

  before(async () => {
    ({ WORKER_ID } = await import("../../../services/queue/workerIdentity.js"));
  });

  it("names the host, so an operator can tell instances apart in a log", () => {
    assert.match(
      WORKER_ID,
      new RegExp(`^${hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#`),
      "the id must start with the hostname, or it is useless in a multi-pod log"
    );
  });

  it("includes the pid, so two processes on one host differ", () => {
    assert.match(WORKER_ID, new RegExp(`#${process.pid}#`), "the pid must be part of the id");
  });

  it("differs across separate processes", async () => {
    // The property that matters. Two instances on one host — a developer's machine,
    // a `docker compose up` — is the case where a hostname-only id collides.
    const scratch = mkdtempSync(path.join(tmpdir(), "keystone-worker-"));
    try {
      const script = path.join(scratch, "id.mjs");
      writeFileSync(
        script,
        `const { WORKER_ID } = await import(${JSON.stringify(
          path.join(projectRoot, "dist", "services", "queue", "workerIdentity.js")
        )});\nconsole.log(WORKER_ID);\n`
      );

      const read = () =>
        execFileSync(process.execPath, [script], { encoding: "utf8" }).trim();

      const ids = new Set<string>();
      for (let i = 0; i < 5; i += 1) ids.add(read());

      assert.equal(ids.size, 5, `5 processes must produce 5 ids, produced ${ids.size}`);
      // And this process is not one of them.
      assert.ok(!ids.has(WORKER_ID), "a child process must not present as this worker");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("a recycled pid does not make a restarted process look like the same worker", async () => {
    // A restarted process reuses a pid on a long-lived host. Without the random
    // suffix it would present as the dead worker that held the same pid — and a
    // lease held under that id would look live.
    const scratch = mkdtempSync(path.join(tmpdir(), "keystone-worker-"));
    try {
      const script = path.join(scratch, "id.mjs");
      writeFileSync(
        script,
        `const { WORKER_ID } = await import(${JSON.stringify(
          path.join(projectRoot, "dist", "services", "queue", "workerIdentity.js")
        )});\nconsole.log(WORKER_ID);\n`
      );
      const first = execFileSync(process.execPath, [script], { encoding: "utf8" }).trim();
      const second = execFileSync(process.execPath, [script], { encoding: "utf8" }).trim();
      assert.notEqual(first, second, "two runs must not share an id");

      // The shape is what carries the guarantee. Arranging an actual pid recycle
      // from a test is not possible, so the claim is asserted structurally: the
      // third component is neither the hostname nor the pid, which is exactly why a
      // restarted process that reuses a dead pid still presents differently.
      const parts = first.split("#");
      assert.ok(parts.length >= 3, `expected host#pid#token, got ${first}`);
      assert.equal(parts[0], hostname(), "the first component is the host");
      assert.match(parts[1], /^\d+$/, `the second component is a pid, got ${parts[1]}`);
      assert.match(parts[2], /^[0-9a-f]{8}$/, `the third component is a random token, got ${parts[2]}`);
      assert.notEqual(
        parts[2],
        parts[1],
        "the random component must not be the pid — that is the whole point"
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("is not configurable, because a constant defeats it", () => {
    // An operator setting one value across instances reintroduces exactly the
    // ambiguity this exists to remove, and that misconfiguration is worse than no
    // identity at all. Asserted against the source so the decision is visible.
    const source = readFileSync(
      path.join(projectRoot, "dist", "services", "queue", "workerIdentity.js"),
      "utf8"
    );
    assert.doesNotMatch(source, /getEnv|process\.env\[/, "WORKER_ID must not read configuration");
  });
});

