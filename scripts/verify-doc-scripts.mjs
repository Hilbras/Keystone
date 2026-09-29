#!/usr/bin/env node
/**
 * Every `npm run <script>` the documentation names must exist.
 *
 * Written after a comment in `secrets/azureKeyVault.ts` told a reader to run
 * `npm run db:reencrypt-oidc`. The real script is `db:reencrypt-oidc-secrets`.
 * Nothing noticed, because nothing checks, and a reader who follows the
 * instruction gets "Missing script" — which reads as *the script is broken*
 * rather than *the documentation named a script that never existed*.
 *
 * That is the same shape as the check `verify-security-registry.mjs` already does
 * for the `fix` and `test` fields: a plausible reference that does not resolve is
 * worse than no reference, because it sends someone looking for something that is
 * not there. Here the reference is prose, so nothing was checking it.
 *
 * Scoped to:
 *
 * - **Markdown under `docs/` and the repository root** — the documentation. A
 *   comment inside a source file is not checked, because a comment's audience is
 *   the next person editing that file, who is already looking at `package.json`.
 *   This boundary is the honest one: covering comments would mean parsing every
 *   file for backticked script names, and false positives on prose that merely
 *   mentions a script name would make it noisy.
 * - **Backticked `npm run <name>` and bare `npm run <name>`.** Not prose mentions
 *   of a script that is being *created* or *renamed*.
 *
 * It also checks the reverse direction, which is the one that actually bites: a
 * script nobody documents is not a defect, but a script whose name appears in the
 * documentation is. Reported as a note rather than a failure, because a hidden
 * script is a documentation gap, not a broken promise.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};

/**
 * Every `package.json` a documented script could live in.
 *
 * The first version of this check looked only at the root, and immediately
 * reported `docs/CONTRIBUTING.md:31` for naming `npm run test:e2e` — a script
 * that **does exist**, in `frontend/package.json`, in a line that says
 * "(from `frontend/`)". The documentation was right and the check was too narrow.
 *
 * The right fix is the check, not the documentation: a reference is resolvable if
 * the script exists in the manifest it is being run from, and a check that
 * demands the root manifest would have had the author rewrite a correct sentence
 * to satisfy a linter — which is how documentation stops being worth reading.
 */
const manifests = [{ label: "package.json", scripts }];
for (const rel of ["frontend", "packages/keystone-sdk", "packages/keystone-node", "packages/keystone-cli"]) {
  const file = path.join(root, rel, "package.json");
  if (!existsSync(file)) continue;
  const parsed = JSON.parse(await readFile(file, "utf8"));
  manifests.push({ label: `${rel}/package.json`, scripts: parsed.scripts ?? {} });
}
const knownScript = (name) => manifests.find((m) => Object.prototype.hasOwnProperty.call(m.scripts, name));

const problems = [];
const fail = (message) => problems.push(message);

/** Markdown files in docs/ and the repository root, plus one level of docs/. */
async function markdownFiles(dir, depth = 0) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth === 0) out.push(...(await markdownFiles(full, depth + 1)));
      continue;
    }
    if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * `CHANGELOG.md` is exempt, and the reason is specific.
 *
 * A changelog is a *historical record*, and the whole job of one is to be able to
 * say "this was wrong, and here is what it should have been". This file's own
 * 3.5.1 entry names `npm run db:reencrypt-oidc` precisely in order to record that
 * the real script is `db:reencrypt-oidc-secrets` — and the check flagged it.
 *
 * So the exemption is not "changelogs are prose" but: **a document whose purpose is
 * to record mistakes has to be able to name them.** Every other markdown file is
 * instruction, and an instruction that names a script which does not exist is wrong.
 */
const CHANGELOG = "CHANGELOG.md";

const files = [
  ...(await markdownFiles(path.join(root, "docs"))),
  ...(await readdir(root))
    .filter((name) => name.endsWith(".md") && name !== CHANGELOG)
    .map((name) => path.join(root, name)),
];

if (files.length === 0) {
  console.error("No markdown found, so there is nothing to check.");
  process.exit(1);
}

const named = new Map(); // script -> [where it is mentioned]

for (const file of files.sort()) {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  const where = path.relative(root, file);

  lines.forEach((line, index) => {
    for (const match of line.matchAll(/npm run ([\w:.-]+)/g)) {
      const name = match[1];
      const at = `${where}:${index + 1}`;

      const owner = knownScript(name);
      if (!owner) {
        fail(
          `${at} — names \`npm run ${name}\`, which is not a script in any package.json ` +
            `in this repository (checked ${manifests.map((m) => m.label).join(", ")}). A ` +
            `reader who follows it gets "Missing script", which reads as a broken script ` +
            `rather than a documentation error.`
        );
        continue;
      }
      if (!named.has(name)) named.set(name, []);
      named.get(name).push(at);
    }
  });
}

/* --- the reverse: a script the docs never mention -------------------------- */

const undocumented = Object.keys(scripts).filter(
  (name) =>
    !named.has(name) &&
    // Internal one-offs that have no business in user documentation.
    !/^(test|test:|build|lint|typecheck|start|dev|clean|prepublish)/.test(name) &&
    name !== "prepare"
);

if (problems.length > 0) {
  console.error("Documentation names scripts that do not exist:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log("Documentation script references OK.");
console.log(`  ${named.size} script(s) referenced across ${files.length} markdown file(s), all resolvable`);
console.log(`  ${CHANGELOG} exempt: a changelog records mistakes, so it must be able to name them`);
if (undocumented.length > 0) {
  console.log(`  ${undocumented.length} script(s) exist but are never mentioned:`);
  for (const name of undocumented) console.log(`    - ${name}`);
}
