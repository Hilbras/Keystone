#!/usr/bin/env node
/**
 * §9.4 — the documentation freeze.
 *
 * Fifteen topics a reader needs, and a check that each is covered by a
 * document that actually covers it.
 *
 * The check is deliberately narrow. It does not read the prose and judge it —
 * no gate can, and a gate that tries is a gate that gets tuned until it
 * passes. It checks two things that can be decided mechanically:
 *
 *   - the file exists;
 *   - the file has a heading that names the topic.
 *
 * The heading is matched as a substring, so a document may rename its section
 * — "Running more than one instance" becomes "Scaling out" — without the
 * coverage silently disappearing. What cannot happen is a topic with no
 * document, which is the failure this is for: a reader who needs to know how
 * to run two instances finds nothing, and finds it at three in the morning.
 *
 * The topic table is [`docs/doc-coverage.json`](../docs/doc-coverage.json),
 * so the set of topics is reviewable on its own rather than buried in the
 * code that checks it.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TABLE_PATH = path.join(ROOT, "docs", "doc-coverage.json");

if (!existsSync(TABLE_PATH)) {
  console.error(`No topic table at ${path.relative(ROOT, TABLE_PATH)}.`);
  process.exit(1);
}

const table = JSON.parse(readFileSync(TABLE_PATH, "utf8"));
const topics = table.topics ?? [];

/** The headings a markdown file has. */
function headingsIn(markdown) {
  const headings = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(/^#{1,6}\s+(.*)$/);
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

const problems = [];

if (topics.length === 0) {
  problems.push("The topic table is empty. A documentation freeze with no topics freezes nothing.");
}

const seen = new Set();
for (const topic of topics) {
  if (seen.has(topic.id)) {
    problems.push(`The topic "${topic.id}" is listed twice.`);
  }
  seen.add(topic.id);

  const filePath = path.join(ROOT, topic.file);
  if (!existsSync(filePath)) {
    problems.push(`${topic.id}: ${topic.file} does not exist.`);
    continue;
  }

  const headings = headingsIn(readFileSync(filePath, "utf8"));
  const covered = headings.some((heading) => heading.toLowerCase().includes(topic.heading.toLowerCase()));
  if (!covered) {
    problems.push(
      `${topic.id}: ${topic.file} has no heading naming "${topic.heading}". ` +
        `Its headings are: ${headings.map((h) => `"${h}"`).join(", ") || "none"}.`
    );
  }
}

if (problems.length > 0) {
  console.error("Documentation coverage FAILED:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  console.error("A topic is covered when a document has a heading that names it.");
  console.error("See docs/CONTRACTS.md and the topic table in docs/doc-coverage.json.");
  process.exit(1);
}

console.log(`Documentation coverage OK: ${topics.length} topics.`);
for (const topic of topics) {
  console.log(`  ${topic.id.padEnd(20)} ${topic.file}`);
}
