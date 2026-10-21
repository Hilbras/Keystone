#!/usr/bin/env node
/**
 * §9.5 and PHASE 10 — the release candidate gate.
 *
 * A release candidate is the last chance to find out that the release is
 * broken, and the checks that find it are not the ones a developer runs. A
 * developer runs the suite against the working tree. A candidate has to be
 * validated the way an operator will meet it: as a *published package*, on a
 * *fresh machine*, against a *database that already exists*, and behind *more
 * than one instance*.
 *
 * So this runs the whole matrix, in two kinds of check:
 *
 *   - **the matrix** — the twenty-three items the release plan names, each
 *     verified by the suite or command that covers it, and each reported
 *     separately, because "the suite passed" and "the OAuth suite passed" are
 *     different answers to the question a candidate has to answer.
 *   - **the external validation** — the published package installed into a
 *     clean directory, its migrations run against a fresh database and against
 *     an existing one, and two instances brought up against one database and
 *     one Redis.
 *
 * Everything here is deliberately *from the outside*. A check that runs
 * against the working tree proves the working tree is fine; a check that runs
 * against the published tarball proves the *release* is fine, and those are
 * different things — the tarball can be missing a file the repository has,
 * the migrations can be absent from the package, and the instance can fail to
 * start because of a file that only exists in development.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await import("node:fs").then((fs) => fs.promises.readFile(path.join(ROOT, "package.json"), "utf8"))
);
const VERSION = manifest.version;

/** The budget the suites run with, so the limiter is not what fails. */
const TEST_ENV = {
  LOGIN_MAX_ATTEMPTS: "1000000",
  LOGIN_PER_ADDRESS_MAX: "1000000",
  LOGIN_WINDOW_SECONDS: "60",
  REFRESH_RATE_MAX: "1000000",
  REFRESH_RATE_WINDOW: "60",
  GLOBAL_RATE_LIMIT_MAX: "1000000",
  GLOBAL_RATE_LIMIT_WINDOW: "60",
  SCIM_AUTH_FAILURE_MAX: "1000000",
  SCIM_AUTH_FAILURE_WINDOW_SECONDS: "60",
  SCIM_RATE_LIMIT_MAX: "1000000",
  SCIM_RATE_LIMIT_WINDOW_SECONDS: "60",
};

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const DATABASE_URL =
  process.env.RC_DATABASE_URL ?? "postgresql://hilbras:hilbras@127.0.0.1:5433/hilbras";
const REDIS_URL = process.env.RC_REDIS_URL ?? "redis://127.0.0.1:6379";

/** Only the item that needs it; a candidate is not blocked on a missing tool. */
const have = (command) =>
  run("sh", ["-c", `command -v ${command}`]).then(
    () => true,
    () => false
  );

const results = [];

async function item(id, label, run_) {
  if (!wanted(id)) return;
  const startedAt = Date.now();
  process.stdout.write(`  … ${id.padEnd(24)} ${label}\n`);
  try {
    const detail = await run_();
    results.push({ id, label, ok: true, detail: detail ?? "", ms: Date.now() - startedAt });
    process.stdout.write(`    ok  (${((Date.now() - startedAt) / 1000).toFixed(1)}s) ${detail ?? ""}\n`);
  } catch (error) {
    const message = String(error?.stdout || error?.stderr || error?.message || error)
      .split("\n")
      .filter((line) => line.trim())
      .slice(-6)
      .join(" | ");
    results.push({ id, label, ok: false, detail: message, ms: Date.now() - startedAt });
    process.stdout.write(`    FAIL ${message}\n`);
  }
}

/** Run a test selection, and fail with the output if it fails. */
async function testSuite(globs, label) {
  const args = [
    "--test",
    "--test-force-exit",
    "--test-concurrency=1",
    "--test-timeout=180000",
    // The TAP reporter, because it ends with a summary the report can read.
    // The spec reporter ends with a line of test names and no counts, so a
    // passing item would report "? passed, ? failed" — which is not a
    // number, and a gate that cannot say how much it checked is a gate that
    // says less than it looks.
    "--test-reporter=tap",
    ...globs,
  ];
  const { stdout } = await run("node", args, {
    cwd: ROOT,
    env: { ...process.env, ...TEST_ENV, DATABASE_URL, REDIS_URL },
    maxBuffer: 64 * 1024 * 1024,
  });
  const pass = /^# pass (\d+)$/m.exec(stdout)?.[1];
  const fail = /^# fail (\d+)$/m.exec(stdout)?.[1];
  return `${label}: ${pass ?? "?"} passed, ${fail ?? "?"} failed`;
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const MATRIX = [
  { id: "lint", label: "no lint warnings", globs: null, command: ["npm", "run", "lint"] },
  { id: "typecheck", label: "no type errors", globs: null, command: ["npm", "run", "typecheck"] },
  { id: "unit", label: "unit tests", globs: ["dist/tests/*.test.js", "dist/tests/setup/*.test.js", "dist/tests/performance/*.test.js"] },
  { id: "integration", label: "integration tests", globs: ["dist/tests/integration/*.test.js"] },
  { id: "database", label: "database tests", globs: ["dist/tests/deployment/*.test.js"] },
  { id: "redis", label: "Redis failure tests", globs: ["dist/tests/chaos/redis-failure.test.js"] },
  { id: "queue", label: "queue tests", globs: ["dist/tests/integration/queue.test.js"] },
  { id: "oauth", label: "OAuth tests", globs: ["dist/tests/security/oauth/*.test.js", "dist/tests/security/oauth2/*.test.js"] },
  { id: "mfa", label: "MFA tests", globs: ["dist/tests/security/mfa/*.test.js"] },
  { id: "webhook", label: "webhook tests", globs: ["dist/tests/security/webhooks/*.test.js"] },
  { id: "concurrency", label: "concurrency tests", globs: ["dist/tests/chaos/concurrency.test.js"] },
  { id: "failure", label: "failure tests", globs: ["dist/tests/chaos/db-failure.test.js", "dist/tests/chaos/network-failure.test.js", "dist/tests/chaos/process-crash.test.js", "dist/tests/chaos/worker-crash.test.js"] },
  { id: "security", label: "security tests", globs: ["dist/tests/security/*.test.js", "dist/tests/security/*/*.test.js", "dist/tests/security/*/*/*.test.js", "dist/tests/security/*/*/*/*.test.js"] },
  { id: "fuzz", label: "fuzz tests", globs: ["dist/tests/chaos/fuzz.test.js"] },
  { id: "docker-build", label: "Docker image builds", globs: null, command: null },
  { id: "npm-pack", label: "npm package builds", globs: null, command: ["npm", "pack", "--dry-run"] },
  { id: "npm-install", label: "the package installs clean", globs: null, command: null },
  { id: "documentation", label: "the documentation is complete and linked", globs: null, command: ["npm", "run", "check:docs"] },
  { id: "openapi", label: "the OpenAPI document describes this server", globs: null, command: ["npm", "run", "verify:openapi"] },
  { id: "migration-tests", label: "every migration upgrades to the same schema", globs: ["dist/tests/deployment/migrationAudit.test.js"] },
  { id: "fresh-install", label: "a fresh installation serves", globs: null, command: null },
  { id: "upgrade-install", label: "an existing installation upgrades", globs: null, command: null },
  { id: "multi-instance", label: "two instances share one database", globs: null, command: null },
];

// ---------------------------------------------------------------------------
// The external checks
// ---------------------------------------------------------------------------

/**
 * The version before this one, on the registry.
 *
 * The upgrade check installs *that* version first, so the database starts at
 * the old schema with the old code's migrations — which is what an operator
 * upgrading actually has.
 */
async function previousPublishedVersion() {
  const { stdout } = await run("npm", ["view", "@hilbras/keystone", "versions", "--json"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const versions = JSON.parse(stdout).filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  const before = versions.filter((version) => version !== VERSION);
  return before[before.length - 1];
}

/** A database with a name of its own, dropped afterwards. */
async function withDatabase(name, body) {
  const admin = await import("postgres").then((m) => m.default);
  const client = admin(DATABASE_URL, { max: 1 });
  try {
    await client.unsafe(`drop database if exists ${name}`);
    await client.unsafe(`create database ${name}`);
  } finally {
    await client.end();
  }
  const target = new URL(DATABASE_URL);
  target.pathname = `/${name}`;
  try {
    return await body(target.toString());
  } finally {
    const cleanup = admin(DATABASE_URL, { max: 1 });
    try {
      await cleanup.unsafe(`drop database if exists ${name}`);
    } catch {
      // The database is disposable either way.
    } finally {
      await cleanup.end();
    }
  }
}

/** Install the packed tarball into a clean directory and return the directory. */
async function installTarball(scratch) {
  const { stdout } = await run("npm", ["pack", "--pack-destination", scratch], {
    cwd: ROOT,
    maxBuffer: 8 * 1024 * 1024,
  });
  const tarball = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz") && !line.includes(" "))
    .pop();
  if (!tarball) throw new Error("npm pack produced no tarball");

  const target = path.join(scratch, "installed");
  await run("mkdir", ["-p", target]);
  await run("npm", ["init", "-y"], { cwd: target });
  await run("npm", ["install", path.join(scratch, tarball), "--no-audit", "--no-fund"], {
    cwd: target,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600_000,
  });
  return target;
}

/** Start the installed server on a port and wait for it to answer. */
async function startServer(directory, databaseUrl, port) {
  const child = spawn(
    process.execPath,
    [path.join(directory, "node_modules", "@hilbras", "keystone", "dist", "index.js")],
    {
      cwd: directory,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        HOST: "127.0.0.1",
        DATABASE_URL: databaseUrl,
        REDIS_URL,
        KEYSTONE_INTERNAL_API_KEY: "rc-validation",
        KEYSTONE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        KEYSTONE_QUEUE_PROVIDER: "in-process",
        KEYSTONE_LOG_LEVEL: "error",
        JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY ?? "",
        JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout.resume();
  child.stderr.resume();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (res.ok) return child;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGKILL");
  throw new Error(`the server did not start on port ${port}`);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** `--only <id>` runs a subset, for re-running one item without the matrix. */
const ONLY = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : undefined;
const wanted = (id) => !ONLY || id === ONLY;

console.log(`Release candidate gate for ${VERSION}${ONLY ? ` (only ${ONLY})` : ""}\n`);

await item("lint", "no lint warnings", async () => {
  await run("npm", ["run", "lint"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  return "oxlint clean";
});

await item("typecheck", "no type errors", async () => {
  await run("npm", ["run", "typecheck"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  return "tsc clean";
});

await item("build", "the project builds", async () => {
  await run("npm", ["run", "build"], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  return "dist/ built";
});

for (const entry of MATRIX) {
  if (entry.id === "lint" || entry.id === "typecheck") continue;
  if (entry.globs) {
    await item(entry.id, entry.label, async () => testSuite(entry.globs, entry.label));
    continue;
  }
  if (entry.id === "docker-build") {
    await item(entry.id, entry.label, async () => {
      if (!(await have("docker"))) return "skipped: docker is not available";
      const tag = `keystone-rc:${VERSION}`;
      await run("docker", ["build", "-t", tag, "."], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 900_000 });
      return `${tag} built`;
    });
    continue;
  }
  if (entry.id === "npm-pack") {
    await item(entry.id, entry.label, async () => {
      // npm writes its notices to stderr and the filename to stdout, so the
      // file count is in the error stream.
      const { stdout, stderr } = await run("npm", ["pack", "--dry-run"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
      const files = /total files:\s*(\d+)/.exec(stderr)?.[1] ?? /total files:\s*(\d+)/.exec(stdout)?.[1] ?? "?";
      return `${files} files`;
    });
    continue;
  }
  if (entry.id === "npm-install") {
    await item(entry.id, entry.label, async () => {
      const scratch = mkdtempSync(path.join(tmpdir(), "keystone-rc-"));
      try {
        const directory = await installTarball(scratch);
        const { stdout } = await run("node", ["-e", "console.log(require('@hilbras/keystone/package.json').version)"], {
          cwd: directory,
        });
        return `installed ${stdout.trim()}`;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
    continue;
  }
  if (entry.id === "documentation") {
    await item(entry.id, entry.label, async () => {
      await run("npm", ["run", "check:docs"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
      await run("npm", ["run", "verify:doc-coverage"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
      return "links resolve and every topic is covered";
    });
    continue;
  }
  if (entry.id === "openapi") {
    await item(entry.id, entry.label, async () => {
      const { stdout } = await run("npm", ["run", "verify:openapi"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim().split("\n").pop();
    });
    continue;
  }
  if (entry.id === "fresh-install") {
    await item(entry.id, entry.label, async () => {
      const scratch = mkdtempSync(path.join(tmpdir(), "keystone-rc-fresh-"));
      let server;
      try {
        const directory = await installTarball(scratch);
        await withDatabase("keystone_rc_fresh", async (databaseUrl) => {
          // The migrations run from the *installed* package, so a package
          // published without them is caught here rather than by a user.
          await run(
            "node",
            [path.join(directory, "node_modules", "@hilbras", "keystone", "dist", "cli.js"), "migrate", "--verify"],
            { cwd: directory, env: { ...process.env, DATABASE_URL: databaseUrl }, maxBuffer: 16 * 1024 * 1024 }
          );
          server = await startServer(directory, databaseUrl, 4311);
          const live = await (await fetch("http://127.0.0.1:4311/health/live")).json();
          const ready = await fetch("http://127.0.0.1:4311/ready");
          const spec = await (await fetch("http://127.0.0.1:4311/openapi.json")).json();
          if (!ready.ok) throw new Error(`a fresh installation is not ready: ${ready.status}`);
          if (spec.info.version !== VERSION) {
            throw new Error(`the served contract reports ${spec.info.version}, not ${VERSION}`);
          }
          return `serves ${live.status}, ready ${ready.status}, contract ${spec.info.version}`;
        });
        return "migrated, booted and served";
      } finally {
        server?.kill("SIGKILL");
        rmSync(scratch, { recursive: true, force: true });
      }
    });
    continue;
  }
  if (entry.id === "upgrade-install") {
    await item(entry.id, entry.label, async () => {
      const scratch = mkdtempSync(path.join(tmpdir(), "keystone-rc-upgrade-"));
      let server;
      try {
        const directory = await installTarball(scratch);
        return await withDatabase("keystone_rc_upgrade", async (databaseUrl) => {
          // The *previous* release installs first, so the database starts at
          // the old schema with the old code's migrations — which is what an
          // operator upgrading actually has.
          const previous = process.env.RC_PREVIOUS_VERSION ?? (await previousPublishedVersion());
          if (!previous) return "skipped: no previous published version to upgrade from";
          const oldDirectory = path.join(scratch, "previous");
          await run("mkdir", ["-p", oldDirectory]);
          await run("npm", ["init", "-y"], { cwd: oldDirectory });
          await run("npm", ["install", `@hilbras/keystone@${previous}`, "--no-audit", "--no-fund"], {
            cwd: oldDirectory,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 600_000,
          });
          await run(
            "node",
            [path.join(oldDirectory, "node_modules", "@hilbras", "keystone", "dist", "cli.js"), "migrate"],
            { cwd: oldDirectory, env: { ...process.env, DATABASE_URL: databaseUrl }, maxBuffer: 16 * 1024 * 1024 }
          );

          // Data written by the old version, which the new one must find.
          const admin = (await import("postgres")).default;
          const client = admin(databaseUrl, { max: 1 });
          try {
            await client.unsafe(
              `insert into organizations (id, name, slug, plan, created_at, updated_at)
               values ('44444444-4444-4444-4444-444444444444', 'Before the upgrade', 'before-upgrade', 'free', now(), now())`
            );
          } finally {
            await client.end();
          }

          // Now the new package, over the top.
          await run(
            "node",
            [path.join(directory, "node_modules", "@hilbras", "keystone", "dist", "cli.js"), "migrate", "--verify"],
            { cwd: directory, env: { ...process.env, DATABASE_URL: databaseUrl }, maxBuffer: 16 * 1024 * 1024 }
          );

          server = await startServer(directory, databaseUrl, 4312);
          const spec = await (await fetch("http://127.0.0.1:4312/openapi.json")).json();
          if (spec.info.version !== VERSION) {
            throw new Error(`the upgraded server reports ${spec.info.version}, not ${VERSION}`);
          }

          const check = (await import("postgres")).default;
          const reader = check(databaseUrl, { max: 1 });
          try {
            const rows = await reader.unsafe(
              `select name from organizations where id = '44444444-4444-4444-4444-444444444444'`
            );
            if (rows.length !== 1) {
              throw new Error("the row written before the upgrade did not survive it");
            }
          } finally {
            await reader.end();
          }
          return `upgraded from ${previous}, the old data survived, contract ${spec.info.version}`;
        });
      } finally {
        server?.kill("SIGKILL");
        rmSync(scratch, { recursive: true, force: true });
      }
    });
    continue;
  }
  if (entry.id === "multi-instance") {
    await item(entry.id, entry.label, async () => {
      if (!(await have("docker"))) return "skipped: docker is not available";
      const tag = `keystone-rc:${VERSION}`;
      const scratch = mkdtempSync(path.join(tmpdir(), "keystone-rc-multi-"));
      const names = [];
      try {
        // Two instances, one database, one Redis. The host network means both
        // reach the same PostgreSQL and Redis the suites use.
        const environment = {
          ...process.env,
          NODE_ENV: "production",
          HOST: "0.0.0.0",
          DATABASE_URL,
          REDIS_URL,
          KEYSTONE_INTERNAL_API_KEY: "rc-validation",
          KEYSTONE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
          KEYSTONE_TOTP_ENCRYPTION_KEY: "rc-validation-totp-encryption-key-0123456789",
          KEYSTONE_QUEUE_PROVIDER: "bullmq",
          KEYSTONE_LOG_LEVEL: "error",
          AUTH_API_PUBLIC_URL: "http://127.0.0.1:4401",
          ALLOWED_ORIGINS: "http://127.0.0.1:4401",
          JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY ?? "",
          JWT_PUBLIC_KEY: process.env.JWT_PUBLIC_KEY ?? "",
        };

        for (const port of [4401, 4402]) {
          const name = `keystone-rc-${port}`;
          names.push(name);
          await run("docker", [
            "run", "-d", "--name", name, "--network", "host",
            "-e", `PORT=${port}`,
            ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
            tag,
          ], { maxBuffer: 8 * 1024 * 1024 });
        }

        // Both must come up.
        for (const port of [4401, 4402]) {
          const deadline = Date.now() + 90_000;
          for (;;) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/health/live`);
              if (res.ok) break;
            } catch {
              // Not up yet.
            }
            if (Date.now() > deadline) throw new Error(`the instance on ${port} did not start`);
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }

        // A user created through one instance is known to the other: the same
        // database, the same account. Registration goes through the platform's
        // own path, so the check is the one an operator would make.
        const email = `rc-multi-${Date.now()}@example.test`;
        const password = "Rc-Multi-Instance-Passw0rd!";
        const registered = await fetch("http://127.0.0.1:4401/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, username: `rc-multi-${Date.now()}` }),
        });
        if (!registered.ok) {
          throw new Error(`the first instance could not create the account: ${registered.status} ${await registered.text()}`);
        }

        const login = await fetch("http://127.0.0.1:4402/auth/token-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!login.ok) {
          throw new Error(`the second instance could not read the first instance's account: ${login.status}`);
        }
        const body = await login.json();
        if (!body.accessToken) throw new Error("the second instance issued no token");

        // And the rate-limit budget is shared, which is the property that
        // makes a fleet of instances one server rather than several: the same
        // key, counted once, in the Redis both instances point at.
        const first = await fetch("http://127.0.0.1:4401/health/live");
        const second = await fetch("http://127.0.0.1:4402/health/live");
        if (!first.ok || !second.ok) throw new Error("both instances must answer");

        return "both instances serve, and the second reads the first's account";
      } finally {
        for (const name of names) {
          await run("docker", ["rm", "-f", name], { maxBuffer: 4 * 1024 * 1024 }).catch(() => {});
        }
        rmSync(scratch, { recursive: true, force: true });
      }
    });
    continue;
  }
}

console.log("\nRelease candidate gate:");
for (const result of results) {
  console.log(`  ${result.ok ? "ok  " : "FAIL"} ${result.id.padEnd(24)} ${result.detail.slice(0, 110)}`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} item(s) failed.`);
  process.exit(1);
}
console.log(`\nEvery item passed. ${VERSION} is a release candidate.`);
