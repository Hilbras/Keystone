#!/usr/bin/env node
/**
 * Container build hygiene.
 *
 * The npm path has an explicit check that the published tarball contains no
 * credential material (`verify-release-metadata.mjs`). The container path had
 * none, and that asymmetry was the finding: `COPY . .` with no `.dockerignore`
 * sent a developer's `.env`, the 15 MB `.git/` and 240 MB of `node_modules/` to
 * the Docker daemon and wrote them into a builder layer that persists in the
 * build cache.
 *
 * Three things are checked, in increasing cost:
 *   1. `.dockerignore` exists and covers the paths that must never be in context
 *   2. the build context, as Docker would send it, excludes them
 *   3. the built image contains no credential material
 *
 * (1) and (2) are static and fast. (3) requires a build, so it runs only with
 * `--build`; CI and the release gate pass it.
 *
 * Usage: node scripts/verify-image-hygiene.mjs [--build]
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doBuild = process.argv.includes("--build");
const problems = [];
const notes = [];

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
};

/**
 * Paths that must never reach the Docker daemon.
 *
 * Literal globs, not patterns. An earlier version derived a probe string from a
 * regex and produced nonsense like "src./tests.", so it reported files that were
 * correctly excluded. For a fixed list of known paths, string comparison is both
 * simpler and correct.
 */
const MUST_EXCLUDE = [
  { glob: ".env", why: "developer credentials and signing keys" },
  { glob: ".env.*", why: "env variants (.env.local, .env.production)" },
  { glob: ".git", why: "repository history, including anything ever committed" },
  { glob: "node_modules", why: "240 MB, and it masks the real dependency set" },
  { glob: "dist", why: "rebuilt inside the image" },
  { glob: "src/tests", why: "test-only credentials" },
];

/** Credential-shaped files that must not be in the image. */
const CREDENTIAL_FILES = [/\.env$/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /\.keystore$/, /^\.git\//];

// --- 1. the ignore file ----------------------------------------------------
const ignorePath = path.join(root, ".dockerignore");
if (!fs.existsSync(ignorePath)) {
  problems.push(
    "No .dockerignore. `COPY . .` (Dockerfile:12) then sends the whole working tree — " +
      "including .env and .git/ — to the Docker daemon. Note that .gitignore does not " +
      "help: the two files are independent and Docker reads only .dockerignore."
  );
} else {
  const lines = read(".dockerignore")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  for (const { glob, why } of MUST_EXCLUDE) {
    if (!lines.some((line) => line.replace(/\/$/, "") === glob)) {
      problems.push(`.dockerignore does not exclude ${glob} — ${why}.`);
    }
  }
  notes.push(`.dockerignore: ${lines.length} patterns`);
}

// --- 2. the context, as Docker would build it -----------------------------
if (fs.existsSync(ignorePath)) {
  // Reproduce Docker's exclusion rather than trusting the file's wording.
  const excluded = new Set();
  for (const line of read(".dockerignore").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("!")) continue;
    excluded.add(t.replace(/^\//, "").replace(/\/$/, ""));
  }
  for (const { glob, why } of MUST_EXCLUDE) {
    if (!excluded.has(glob) && ![...excluded].some((e) => glob === e || glob.startsWith(e + "/"))) {
      problems.push(`build context would include ${glob} — ${why}.`);
    }
  }
}

// --- 3. the built image ----------------------------------------------------
if (doBuild) {
  const tag = "keystone-hygiene-probe";
  try {
    execFileSync("docker", ["build", "-t", tag, "."], { cwd: root, stdio: "pipe" });
    notes.push("built image for inspection");

    const list = execFileSync(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", tag, "-c", "find /app \\( -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \\) 2>/dev/null | head -20"],
      { encoding: "utf8", stdio: "pipe" }
    ).trim();

    if (list) {
      problems.push(`built image contains credential-shaped files:\n      ${list.split("\n").join("\n      ")}`);
    } else {
      notes.push("built image: no credential-shaped files");
    }

    // The tests must not be in the runtime image either.
    const tests = execFileSync(
      "docker",
      ["run", "--rm", "--entrypoint", "sh", tag, "-c", "test -d /app/dist/tests && echo yes || echo no"],
      { encoding: "utf8", stdio: "pipe" }
    ).trim();
    if (tests === "yes") {
      problems.push("built image ships /app/dist/tests — compiled tests carry test-only credentials.");
    } else {
      notes.push("built image: no compiled tests");
    }

    const size = execFileSync("docker", ["image", "inspect", tag, "--format", "{{.Size}}"], {
      encoding: "utf8",
    }).trim();
    notes.push(`image size: ${(Number(size) / 1024 / 1024).toFixed(0)} MB`);
  } catch (err) {
    problems.push(`image build failed: ${String(err.stderr || err.message).slice(0, 300)}`);
  } finally {
    try {
      execFileSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
} else {
  notes.push("image inspection skipped (pass --build to include it)");
}

for (const note of notes) console.log(`  note: ${note}`);

if (problems.length) {
  console.error("\nImage hygiene check FAILED:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  process.exit(1);
}
console.log("Image hygiene OK.");
