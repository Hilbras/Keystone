#!/usr/bin/env node
/**
 * Typecheck every code sample in the documentation.
 *
 * §5.3: *"extract the code samples from `HOW-KEYSTONE-WORKS.md` and
 * `INTEGRATION.md` into runnable examples that are compiled in CI, so a sample
 * cannot rot into something that does not work."*
 *
 * A sample is documentation, and documentation is not executed. So a renamed
 * server endpoint, a changed option name, or a deleted SDK method leaves the
 * sample looking exactly as authoritative as the day it was written, and the first
 * person to find out is a user with a broken integration and no way to tell whether
 * the docs or their code are wrong. This is the documentation equivalent of a
 * regression test, and the only thing that stops example code decaying into
 * fiction.
 *
 * The samples are checked rather than merely *extracted*, because extraction alone
 * proves nothing — it copies text without testing it. Each fence is written to a
 * scratch file and compiled with the repository's own `tsc`, against the real
 * `packages/*` and the real ambient types, so a sample calling a method that does
 * not exist fails here rather than in somebody's browser.
 *
 * Two kinds of fence are handled differently, and the distinction is the whole
 * value of the check:
 *
 * - **Runnable** fences — those that import from a package in this repository, or
 *   that call a Keystone endpoint. These are compiled.
 * - **Illustrative** fences — fragments, shell transcripts, JSON, deliberately
 *   abbreviated listings. These are counted and reported but not compiled, because
 *   requiring a fragment to compile would mean padding the documentation to
 *   satisfy a linter, and documentation padded to satisfy a linter is worse
 *   documentation.
 *
 * Every skipped fence is listed by file and line, so "nothing was checked" is
 * visibly different from "everything was checked".
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The guides §5.3 names. */
const GUIDES = ["docs/HOW-KEYSTONE-WORKS.md", "docs/INTEGRATION.md"];

/** Fence languages we can meaningfully compile. */
const CODE = new Set(["ts", "typescript", "tsx"]);

/**
 * A fence is checked when it looks like real code against this product.
 *
 * The test is deliberately conservative about what counts: importing a package that
 * lives in this repository, or naming a Keystone client, or using `fetch` against
 * the API. A fragment that mentions none of those is not making a claim about our
 * API that could rot, so it is not our business whether it compiles.
 */
const REFERENCES_THE_PRODUCT =
  /from\s+["']@hilbras\/keystone|new\s+Keystone|KeystoneNodeClient|\/v1\/|\/auth\/|\/oauth2\//;

/**
 * A fence that declares itself a fragment.
 *
 * Some fences are prose-with-code: the surrounding paragraph says "generate a
 * verifier, then redirect", and the fence is the middle of that sentence. Those
 * reference identifiers defined outside themselves — `base64url`, `issuer`,
 * `sessionStorage` — so they cannot compile standalone, and padding them until
 * they do would turn the documentation into something written to satisfy a linter
 * rather than to be read.
 *
 * So a fragment says so, **in the documentation**, on its first line:
 *
 * ```ts
 * // fragment: continues the previous listing
 * ```
 *
 * The marker is checked rather than inferred, which is the point: a reader who
 * copies the fence learns from the fence that it is not standalone, and the gate
 * and the reader are looking at the same thing. Every skipped fence is listed by
 * file and line, so "nothing was checked" stays visibly different from
 * "everything was checked".
 */
const FRAGMENT_MARKER = /^\s*(?:\/\/|#)\s*fragment\s*[—:-]/m;

function extractFences(markdown) {
  const fences = [];
  const lines = markdown.split("\n");
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const start = /^\s*```([a-zA-Z0-9]+)\s*$/.exec(lines[i]);
    if (!open && start && CODE.has(start[1])) {
      open = { language: start[1], startLine: i + 1, body: [] };
      continue;
    }
    if (open && /^\s*```\s*$/.test(lines[i])) {
      open.endLine = i + 1;
      fences.push(open);
      open = null;
      continue;
    }
    if (open) open.body.push(lines[i]);
  }
  return fences;
}

const problems = [];
const checked = [];
const skipped = [];

for (const guide of GUIDES) {
  const file = path.join(root, guide);
  if (!existsSync(file)) {
    problems.push(`${guide} does not exist`);
    continue;
  }
  const markdown = await readFile(file, "utf8");
  for (const fence of extractFences(markdown)) {
    const source = fence.body.join("\n").trim();
    if (source === "") {
      skipped.push({ guide, line: fence.startLine, why: "empty" });
      continue;
    }
    if (!REFERENCES_THE_PRODUCT.test(source)) {
      skipped.push({ guide, line: fence.startLine, why: "no claim about this product's API" });
      continue;
    }
    if (FRAGMENT_MARKER.test(source)) {
      skipped.push({ guide, line: fence.startLine, why: "marked as a fragment in the guide" });
      continue;
    }
    // A fence is a *fragment* of a file, so the identifiers it declares may
    // collide with another fence's. Each becomes its own module, which is both
    // realistic and the only way to compile them independently.
    checked.push({ guide, line: fence.startLine, language: fence.language, source });
  }
}

if (checked.length === 0) {
  console.error(
    "No documentation sample was checked. That is either because the guides have " +
      "no code any more, or because the product-reference pattern stopped matching — " +
      "and both mean this gate has quietly stopped gating."
  );
  process.exit(1);
}

const scratch = await mkdtemp(path.join(tmpdir(), "keystone-docsamples-"));
try {
  // Browser and Node globals the samples legitimately use. Declared rather than
  // pulled from a `@types` package so the list is visible here: it is part of what
  // we are claiming compiles.
  const ambient = `
declare const localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
declare const window: { location: { href: string } };
declare const crypto: {
  getRandomValues(array: Uint8Array): Uint8Array;
  randomUUID(): string;
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
};
declare function btoa(input: string): string;
`;
  await writeFile(path.join(scratch, "ambient.d.ts"), ambient, "utf8");

  checked.forEach((sample, index) => {
    const name = `sample-${String(index + 1).padStart(2, "0")}-${path.basename(sample.guide, ".md")}.ts`;
    // Compiled as a module, always. A fence is a fragment of a file, so a sample
    // using top-level `await` may have no `import` or `export` of its own, and
    // without this `tsc` reports TS1375 — "this file has no imports or exports" —
    // which says nothing about whether the sample is correct.
    const asModule = /^\s*(import|export)\b/m.test(sample.source) ? sample.source : `export {};\n${sample.source}`;
    void writeFile(path.join(scratch, name), `${asModule}\n`, "utf8");
    sample.file = name;
  });

  // Every package specifier a sample imports must be one the **published** layout
  // actually serves.
  //
  // This is a separate check from the compile, and it is the one that matters,
  // because `paths` is a stand-in. The first version of this script aliased
  // `@hilbras/keystone/sdk` to `src/sdk/index.ts` and so compiled a sample
  // importing a subpath **the package did not have**: `package.json` had no
  // `exports` map and no `sdk` directory, so `@hilbras/keystone/sdk` did not
  // resolve for anybody who installed it. The compile passed and the documentation
  // was still wrong.
  //
  // So the specifiers are resolved against `exports` the way Node would, and the
  // files the entries point at are checked to exist in the build output.
  const mainManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const serverPackage = "@hilbras/keystone";

  /** Node's algorithm, for the cases this repository uses: an `exports` map. */
  function resolvesFromExports(specifier) {
    const rest = specifier.slice(serverPackage.length);
    const key = rest === "" ? "." : rest.startsWith("/") ? `.${rest}` : null;
    if (key === null) return { ok: false, why: "not a subpath of the published package" };
    const table = mainManifest.exports;
    if (!table) {
      return { ok: true, target: null, why: "no exports map, resolved by file path" };
    }
    const entry = table[key];
    if (entry === undefined) {
      return {
        ok: false,
        why: `package.json "exports" has no entry for "${key}"`,
        siblings: Object.keys(table),
      };
    }
    const target = typeof entry === "string" ? entry : (entry.default ?? entry.import ?? entry.require);
    if (target?.includes("*")) {
      return { ok: true, target: null, why: "wildcard subpath" };
    }
    return { ok: true, target };
  }

  for (const sample of checked) {
    for (const specifier of new Set(
      [...sample.source.matchAll(/from\s+["'](@hilbras\/keystone[^"']*)["']/g)].map((m) => m[1])
    )) {
      const result = resolvesFromExports(specifier);
      if (!result.ok) {
        problems.push(
          `${sample.guide}:${sample.line} — imports ${specifier}, which the published ` +
            `package does not serve (${result.why}). ` +
            `Declared subpaths: ${result.siblings.join(", ") || "none"}`
        );
        continue;
      }
      if (result.target && !existsSync(path.join(root, result.target))) {
        problems.push(
          `${sample.guide}:${sample.line} — imports ${specifier}, whose exports entry points ` +
            `at ${result.target}, which is not in the build output. Run the build.`
        );
      }
    }
  }

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["ES2022", "DOM"],
      types: [],
      // No `baseUrl`: TypeScript 6 removed it, and it is not needed — `paths`
      // entries are resolved relative to this tsconfig, which lives in the scratch
      // directory. Absolute paths below, so nothing depends on that.
      paths: {
        // The server itself. A sample that mounts routes on `buildApp` is making a
        // claim about the published package, so the published package is what it is
        // compiled against — not a stand-in for it.
        "@hilbras/keystone": [path.join(root, "src/index.ts")],
        "@hilbras/keystone/sdk": [path.join(root, "src/sdk/index.ts")],
        "@hilbras/keystone-sdk": [path.join(root, "packages/keystone-sdk/src/index.ts")],
        "@hilbras/keystone-node": [path.join(root, "packages/keystone-node/src/index.ts")],
        "@hilbras/keystone-react": [path.join(root, "packages/keystone-react/src/index.ts")],
        "@hilbras/keystone-vue": [path.join(root, "packages/keystone-vue/src/index.ts")],
        "@hilbras/keystone-cli": [path.join(root, "packages/keystone-cli/src/index.ts")],
      },
    },
    include: ["ambient.d.ts", "sample-*.ts"],
  };
  const tsconfigPath = path.join(scratch, "tsconfig.json");
  await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), "utf8");

  let output = "";
  let failed = false;
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [path.join(root, "node_modules/typescript/bin/tsc"), "-p", tsconfigPath],
      { cwd: scratch, maxBuffer: 8 * 1024 * 1024 }
    );
    output = `${stdout}${stderr}`;
  } catch (err) {
    const e = /** @type {{ stdout?: string; stderr?: string }} */ (err);
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    failed = true;
  }

  if (failed) {
    // Attributed back to the guide and line, so a failure names a place a person
    // can edit. "sample-04-INTEGRATION.ts(12,3): error TS2304" does not.
    const byFile = new Map();
    for (const line of output.split("\n")) {
      const m = /^(sample-[^(:]+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line.trim());
      if (!m) continue;
      const [, file, row, , , code, message] = m;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(`${code} at line ${row}: ${message}`);
    }
    for (const sample of checked) {
      const errors = byFile.get(sample.file) ?? [];
      if (errors.length > 0) {
        problems.push(
          `${sample.guide}:${sample.line} — a documentation sample does not compile\n` +
            errors.map((e) => `      ${e}`).join("\n")
        );
      }
    }
    // Anything the parser could not attribute is still worth reporting: a sample
    // that failed in a way the regex did not match is not a sample we checked.
    if (problems.length === 0) {
      problems.push(`tsc reported failures that could not be attributed to a sample:\n${output.trim()}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

if (problems.length > 0) {
  console.error("Documentation samples failed to compile:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\n  ${checked.length} sample(s) checked, ${skipped.length} skipped as illustrative`);
  process.exit(1);
}

console.log("Documentation samples OK.");
console.log(`  ${checked.length} compiled against the real packages, ${skipped.length} skipped as illustrative fragments`);
for (const sample of checked) {
  console.log(`    ${sample.guide}:${sample.line}`);
}
if (skipped.length > 0) {
  console.log("  not compiled (no claim about this product's API):");
  for (const skip of skipped) console.log(`    ${skip.guide}:${skip.line} — ${skip.why}`);
}
