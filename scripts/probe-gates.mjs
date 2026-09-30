#!/usr/bin/env node
/**
 * Do the gates fail when they should?
 *
 * The session's recurring defect is a control that reports success for something
 * other than what it measures — a check that cannot fail. This probe answers the
 * cheapest version of that question for the 16 gate steps in ci.yml: break the
 * repository in a way each gate is *supposed* to notice, and record whether the
 * gate noticed.
 *
 * Every mutation is applied to a scratch copy of the tree and reverted. Nothing
 * touches the working directory, and no network, database or Redis is needed —
 * which is the same property the gates themselves are supposed to have.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Run a gate in `cwd` and report whether it exited non-zero. */
function runGate(script, cwd) {
  try {
    execFileSync(process.execPath, [path.join(cwd, "scripts", script)], {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { failed: false, output: "" };
  } catch (error) {
    const err = /** @type {{ stdout?: string, stderr?: string, status?: number }} */ (error);
    return { failed: true, output: `${err.stdout ?? ""}${err.stderr ?? ""}`, status: err.status };
  }
}

/** Files a scratch tree needs for the gates to run at all. */
const NEEDED = [
  "package.json",
  "tsconfig.json",
  "src",
  "scripts",
  "docs",
  "k8s",
  "frontend/package.json",
  ".semgrep.yml",
  ".gitleaks.toml",
  ".github",
  "packages",
  "Dockerfile",
  "README.md",
  "CHANGELOG.md",
];

/**
 * Each probe: a name, a gate that should notice, and a mutation.
 *
 * The mutation must be something the gate's own name promises to catch. A probe
 * that mutates something unrelated and then blames the gate teaches nothing, and
 * the point of this file is to be able to trust a green answer.
 */
const PROBES = [
  {
    gate: "verify-node-version.mjs",
    name: "Dockerfile drifts from .nvmrc",
    apply(dir) {
      const file = path.join(dir, "Dockerfile");
      writeFileSync(file, readFileSync(file, "utf8").replace(/^FROM node:.*$/m, "FROM node:22-alpine"));
    },
  },
  {
    gate: "verify-k8s-manifests.mjs",
    name: "readinessProbe points at /health instead of /ready",
    apply(dir) {
      const file = path.join(dir, "k8s", "base", "deployment.yaml");
      // The **field**, not the string. `path: /ready` and a comment reading
      // "`/ready`, not `/health`" both contain `/ready`, so a bare replace of
      // "/ready" hits whichever comes first — and the comment is eight lines
      // above the field, so the first version of this probe rewrote a
      // sentence, left the manifest exactly as it was, and the gate correctly
      // reported success. The probe was measuring the mutation, not the gate.
      //
      // Which is the same failure the probe exists to detect, one level up: a
      // check reporting success for something other than what it measures.
      const text = readFileSync(file, "utf8");
      const mutated = text.replace(/^(\s*path:\s*)\/ready\s*$/m, "$1/health");
      writeFileSync(file, mutated);
    },
  },
  {
    gate: "verify-k8s-manifests.mjs",
    name: "container loses its memory limit",
    apply(dir) {
      const file = path.join(dir, "k8s", "base", "deployment.yaml");
      const text = readFileSync(file, "utf8");
      writeFileSync(file, text.replace(/^\s*memory:.*$/m, "          memory: \"\""));
    },
  },
  {
    gate: "verify-k8s-manifests.mjs",
    name: "a base Ingress publishes /metrics (SEC-073 regression)",
    apply(dir) {
      writeFileSync(
        path.join(dir, "k8s", "base", "ingress.yaml"),
        [
          "apiVersion: networking.k8s.io/v1",
          "kind: Ingress",
          "metadata:",
          "  name: keystone",
          "spec:",
          "  rules:",
          "    - host: keystone.example.com",
          "      http:",
          "        paths:",
          "          - path: /",
          "            pathType: Prefix",
          "            backend:",
          "              service:",
          "                name: keystone",
          "                port:",
          "                  number: 80",
          "",
        ].join("\n")
      );
      const k = path.join(dir, "k8s", "base", "kustomization.yaml");
      writeFileSync(k, readFileSync(k, "utf8").replace("  - service.yaml", "  - service.yaml\n  - ingress.yaml"));
    },
  },
  {
    gate: "verify-changelog.mjs",
    name: "the changelog has no entry for package.json's version",
    apply(dir) {
      const file = path.join(dir, "CHANGELOG.md");
      writeFileSync(file, readFileSync(file, "utf8").replace(/^## \[3\.5\.12\].*$/m, "## [0.0.1] - 2020-01-01"));
    },
  },
  {
    gate: "verify-changelog.mjs",
    name: "a version has two changelog sections (the 3.5.11 defect)",
    apply(dir) {
      const file = path.join(dir, "CHANGELOG.md");
      const text = readFileSync(file, "utf8");
      writeFileSync(file, `${text}\n## [3.5.12] - 2026-09-30\n\nA second one.\n`);
    },
  },
  {
    gate: "verify-release-metadata.mjs",
    name: "engines.node disagrees with .nvmrc",
    apply(dir) {
      const file = path.join(dir, "package.json");
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      pkg.engines.node = ">=18";
      writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    },
  },
  {
    gate: "verify-security-registry.mjs",
    name: "a finding's test file is deleted",
    apply(dir) {
      const file = path.join(dir, "docs", "security", "registry.json");
      const registry = JSON.parse(readFileSync(file, "utf8"));
      const target = registry.entries.find((e) => e.id === "SEC-073");
      target.test = "src/tests/security/does-not-exist.test.ts";
      writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
    },
  },
  {
    gate: "verify-security-registry.mjs",
    name: "a withdrawn id has no reason",
    apply(dir) {
      const file = path.join(dir, "docs", "security", "registry.json");
      const registry = JSON.parse(readFileSync(file, "utf8"));
      registry.withdrawn = [{ id: "SEC-999" }];
      writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
    },
  },
  {
    gate: "verify-doc-scripts.mjs",
    name: "documentation names an npm script that does not exist",
    apply(dir) {
      const file = path.join(dir, "README.md");
      writeFileSync(
        file,
        `${readFileSync(file, "utf8")}\n\nRun \`npm run verify:this-does-not-exist\` first.\n`
      );
    },
  },
  {
    gate: "verify-sdk-packages.mjs",
    name: "an SDK package drifts from the server version",
    apply(dir) {
      const file = path.join(dir, "packages", "keystone-sdk", "package.json");
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      pkg.version = "0.0.1";
      writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    },
  },
  {
    gate: "verify-action-pins.mjs",
    name: "an action pin is a tag rather than a commit SHA",
    apply(dir) {
      const file = path.join(dir, ".github", "workflows", "ci.yml");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(/uses: (actions\/checkout)@[0-9a-f]{40}/, "uses: $1@v7.0.1")
      );
    },
  },
];

/** Gates that need more than a file copy — they read the compiled output. */
const NEEDS_BUILD = new Set(["generate-auth-dashboard.mjs", "verify-doc-samples.mjs"]);

/**
 * The four steps of the `gates` job this does not yet cover, named rather than
 * quietly omitted.
 *
 * `generate-auth-dashboard.mjs` and `verify-doc-samples.mjs` read `dist/`, so a
 * mutation probe for them has to run after a build — the probe copies the
 * existing `dist/` rather than spending eleven minutes compiling per probe.
 * `review-api-surface.mjs` is covered against its own rules by
 * `src/tests/security/reviewApiSurface.test.ts`, and lint is covered by
 * `--deny-warnings` failing CI. Both are known-good, so they are the lowest
 * priority to add here; the list exists so that "twelve" is not mistaken for
 * "all sixteen".
 */
const NOT_YET_PROBED = [
  "generate-auth-dashboard.mjs — needs dist/",
  "verify-doc-samples.mjs — needs dist/",
  "review-api-surface.mjs --strict — covered by reviewApiSurface.test.ts",
  "oxlint --deny-warnings — covered by the lint step itself",
];

const results = [];
for (const probe of PROBES) {
  const scratch = mkdtempSync(path.join(tmpdir(), "keystone-gate-"));
  try {
    for (const entry of NEEDED) {
      const from = path.join(root, entry);
      if (!existsSync(from)) continue;
      cpSync(from, path.join(scratch, entry), { recursive: true });
    }
    // A gate that reads dist/ needs one; borrow the real build rather than
    // spending eleven minutes per probe on a compile.
    if (NEEDS_BUILD.has(probe.gate) && existsSync(path.join(root, "dist"))) {
      cpSync(path.join(root, "dist"), path.join(scratch, "dist"), { recursive: true });
    }
    // A **symlink**, not a copy. The gates import nothing from node_modules at
    // all — they read files as text — but `verify-doc-samples.mjs` resolves
    // against the project, so a tree without it looks broken in a way that has
    // nothing to do with the mutation. Copying it twelve times is 2.8GB of I/O
    // for a link; the first version of this probe took long enough that it was
    // interrupted twice.
    symlinkSync(path.join(root, "node_modules"), path.join(scratch, "node_modules"), "dir");

    // A mutation that changes nothing is the failure this whole project keeps
    // finding, one level down: the probe would report "NOT CAUGHT", which reads
    // as a broken gate and sends the next person to fix a gate that was fine.
    // The first version of this file did exactly that — it rewrote a *comment*
    // in deployment.yaml instead of the `path:` field eight lines below it, and
    // the k8s gate went on passing.
    // `Dockerfile` is watched on its own rather than swept up by a directory —
    // it sits at the root, and a probe that mutates a file the guard cannot see
    // reports "mutation changed nothing" for a mutation that plainly happened.
    const watched = [];
    const WATCHED_FILES = [
      "Dockerfile",
      "package.json",
      "CHANGELOG.md",
      "README.md",
      ".nvmrc",
    ];
    for (const name of WATCHED_FILES) {
      const full = path.join(scratch, name);
      if (existsSync(full)) watched.push([full, readFileSync(full, "utf8")]);
    }
    const WATCHED_DIRS = ["k8s", "docs", "scripts", ".github", "packages"];
    for (const dir of WATCHED_DIRS) {
      const from = path.join(scratch, dir);
      if (!existsSync(from)) continue;
      const stack = [from];
      while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (/\.(ya?ml|json|md|mjs)$/.test(entry.name)) {
            watched.push([full, readFileSync(full, "utf8")]);
          }
        }
      }
    }

    probe.apply(scratch);

    // The probe is only meaningful if it changed *something*.
    const changed = watched
      .filter(([full, before]) => readFileSync(full, "utf8") !== before)
      .map(([full]) => path.relative(scratch, full));
    if (changed.length === 0) {
      results.push({
        ...probe,
        failed: false,
        errored: true,
        output: "mutation changed nothing — the probe is lying, not the gate",
      });
      continue;
    }

    const outcome = runGate(probe.gate, scratch);
    results.push({ ...probe, ...outcome });
  } catch (error) {
    results.push({ ...probe, failed: false, output: `probe error: ${error.message}`, errored: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const notCaught = results.filter((r) => !r.failed);
console.log(`Gate probes: ${results.length}\n`);
for (const r of results) {
  const verdict = r.errored ? "ERROR" : r.failed ? "caught" : "NOT CAUGHT";
  console.log(`  ${verdict.padEnd(10)} ${r.gate.padEnd(32)} ${r.name}`);
}
console.log(
  `\n${results.length - notCaught.length}/${results.length} mutations caught. ` +
    (notCaught.length
      ? `Not caught: ${notCaught.map((r) => r.gate).join(", ")}`
      : "Every gate noticed its own mutation.")
);
console.log(`\nNot probed (${NOT_YET_PROBED.length} of the 16 gate steps):`);
for (const line of NOT_YET_PROBED) console.log(`  - ${line}`);
process.exit(notCaught.length > 0 ? 1 : 0);
