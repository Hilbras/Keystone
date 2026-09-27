#!/usr/bin/env node
/**
 * Check that documentation links resolve.
 *
 * Documentation rots quietly: a file is renamed, a section is reworded, and the
 * link keeps looking fine in the source while 404ing for the reader. There is no
 * test that catches this, and the readers who hit a dead link are usually the
 * people evaluating the project for the first time.
 *
 * Checks relative markdown links in README.md, SECURITY.md and everything under
 * docs/, and that every anchor a link points at exists in its target.
 *
 * Usage: node scripts/check-doc-links.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

/** GitHub's anchor rule: lowercase, strip punctuation, spaces to dashes. */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\w\s-]/g, "")
    // Each space becomes a dash; runs are NOT collapsed, which is why
    // "1. Web / SPA" yields "1-web--spa" and not "1-web-spa".
    .replace(/ /g, "-");
}

function anchorsIn(markdown) {
  const anchors = new Set();
  for (const line of markdown.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) anchors.add(slugify(m[1]));
  }
  return anchors;
}

const files = ["README.md", "SECURITY.md", "AGENTS.md"];
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel);
    else if (entry.name.endsWith(".md")) files.push(rel);
  }
})("docs");

let checked = 0;
for (const rel of files) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  const markdown = fs.readFileSync(abs, "utf8");
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const m of markdown.matchAll(linkRe)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    checked++;

    const [filePart, fragment] = target.split("#");
    const resolved = path.resolve(path.dirname(abs), filePart);

    if (filePart && !fs.existsSync(resolved)) {
      problems.push(`${rel}: link target does not exist — ${target}`);
      continue;
    }

    if (fragment) {
      // A bare #fragment points at the same file.
      const targetFile = filePart ? resolved : abs;
      if (!fs.existsSync(targetFile)) continue;
      if (!targetFile.endsWith(".md")) continue;
      const anchors = anchorsIn(fs.readFileSync(targetFile, "utf8"));
      if (!anchors.has(fragment)) {
        problems.push(
          `${rel}: anchor "#${fragment}" not found in ${path.relative(root, targetFile) || "this file"}`
        );
      }
    }
  }
}

if (problems.length) {
  console.error(`Documentation link check FAILED (${problems.length} of ${checked}):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Documentation links OK (${checked} relative links across ${files.length} files).`);
