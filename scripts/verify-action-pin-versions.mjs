#!/usr/bin/env node
/**
 * Every action pin, checked against the version it claims — and the claim recorded.
 *
 * ## The gap this closes
 *
 * `verify-action-pins.mjs` checks the **form** of a pin: a 40-character SHA, not a
 * tag, with a version in a trailing comment. It does not check that the SHA is the
 * commit the version names. So `# v4.2.2` is *documentation* — a reader can see which
 * release a pin claims to be, and nothing confirms it is.
 *
 * That matters more than it looks, because the trailing comment is the entire reason
 * to pin to a SHA rather than a moving tag: a pin you cannot map back to a release is
 * not reviewable, it is just an opaque hash. A wrong annotation would sit there
 * indefinitely, and the next person comparing a pin against a release would be
 * comparing against a lie.
 *
 * ## Why the record is a file and not a live call
 *
 * Answering this needs the GitHub API: 17 distinct pins, and an **annotated** tag
 * resolves to a tag object rather than a commit, so `refs/tags/v3.0.3` can return a
 * SHA that is not the pinned commit. Both halves of that are the kind of thing a gate
 * gets subtly wrong and reports as clean — an un-dereferenced annotated tag reads as
 * a mismatch on every annotated release, and a mistake in which field is compared
 * reads as a match on all of them.
 *
 * So the answers are **recorded** in `scripts/action-pin-versions.json` by an explicit
 * `--refresh`, and the gate compares the record against the code. Offline, in
 * milliseconds, and deterministic — which is what makes it usable as a required check.
 * A record that is missing an entry, or older than `MAX_AGE_DAYS`, fails: a lockfile
 * nobody refreshes is the same failure as a check nobody runs.
 *
 * The shell one-liner this replaced got the repository name wrong in all 17 cases and
 * reported **17 mismatches on a tree where nothing was wrong** — because `read` split
 * `repo@sha` into one field and every lookup then hit a repository that does not
 * exist. A check that reports total failure from a parsing bug looks exactly like a
 * check that has caught something.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(root, ".github/workflows");
const RECORD = path.join(root, "scripts/action-pin-versions.json");

/**
 * How stale the record may be before the gate fails.
 *
 * Three months. Long enough that this is not a chore, short enough that a pinned
 * action which has been compromised and re-tagged is noticed while the pin is still
 * in use rather than after it has been rotated out.
 */
const MAX_AGE_DAYS = 90;

/**
 * A `uses:` line, captured with the pieces the record needs.
 *
 * `repo` is the repository to ask about and `tag` is what the comment claims. They are
 * not the same field, which is the subtlety: a subpath action is written
 * `github/codeql-action/analyze@SHA # v3`, so the `uses:` target is a directory inside
 * the repository and the comment is the repository's tag. Querying the subpath finds
 * nothing, and a `404` from that is indistinguishable from a real problem.
 */
const PIN = /uses:\s*([^\s@]+)@([0-9a-f]{40})\s*#\s*(\S+)/g;

/** `owner/name`, with any `/subpath` removed and the tag normalised back to `vX`. */
function repositoryAndTag(target, comment) {
  const parts = target.split("/");
  // A subpath is a third or later segment, or a second segment in the
  // `owner/name/subpath` shape. `owner/name` is always exactly two.
  const repo = parts.slice(0, 2).join("/");
  // The comment may or may not carry the subpath (`v3/analyze` or `v3`); the tag is
  // always the leading `vN.N.N` part.
  const tag = comment.split("/")[0];
  return { repo, tag };
}

async function collectPins() {
  const pins = new Map();
  for (const name of (await readdir(WORKFLOWS)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
    const text = await readFile(path.join(WORKFLOWS, name), "utf8");
    for (const match of text.matchAll(PIN)) {
      const [, target, sha, comment] = match;
      // Local and container references are not third-party pins.
      if (target.startsWith("./") || target.startsWith("docker://")) continue;
      const { repo, tag } = repositoryAndTag(target, comment);
      const key = `${repo}@${sha}`;
      if (!pins.has(key)) pins.set(key, { repo, sha, tag, target, comment, files: [] });
      pins.get(key).files.push(name);
    }
  }
  return [...pins.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.tag.localeCompare(b.tag));
}

async function gh(args) {
  // `gh` rather than a raw HTTPS call: it carries the token, and it is what the rest
  // of this repository's tooling already shells out to. Its exit code is the signal —
  // a missing tag is a `null`, not an exception, so one bad lookup does not abort a
  // refresh that has 16 good ones.
  return new Promise((resolve) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

/** Resolve a tag to the commit it names, dereferencing an annotated tag. */
async function commitFor(repo, tag) {
  const ref = await gh(["api", `repos/${repo}/git/refs/tags/${tag}`]);
  if (!ref) return { error: `no such tag ${tag}` };
  let parsed;
  try {
    parsed = JSON.parse(ref);
  } catch {
    return { error: `unparseable ref response for ${tag}` };
  }
  const type = parsed?.object?.type;
  const sha = parsed?.object?.sha;
  if (!sha) return { error: `ref ${tag} has no object` };
  if (type !== "tag") return { sha, annotated: false };
  // An annotated tag points at a *tag object*; the commit is one hop further. This
  // is the step whose omission reports every annotated release as a mismatch.
  const inner = await gh(["api", `repos/${repo}/git/tags/${sha}`]);
  if (!inner) return { error: `annotated tag ${tag} could not be dereferenced` };
  try {
    return { sha: JSON.parse(inner)?.object?.sha, annotated: true };
  } catch {
    return { error: `unparseable tag object for ${tag}` };
  }
}

/**
 * The highest release tag in `repo` that names `sha`, or null.
 *
 * A bare major tag — `v4` — is a **moving reference**, not a release. Pinning the
 * commit while annotating `v4` gives a reader the one thing the annotation exists to
 * provide and then takes it away: "v4" is whatever `v4` points at today, so the
 * question "which release is this?" has no answer. Nine of this repository's fourteen
 * distinct pins were annotated that way.
 *
 * `repos/{repo}/tags` carries `commit.sha` for each tag, resolved through annotated
 * tags by GitHub, so one call per repository replaces one call per candidate release.
 */
async function releaseFor(repo, sha) {
  const body = await gh(["api", `repos/${repo}/tags?per_page=100`]);
  if (!body) return null;
  let tags;
  try {
    tags = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(tags)) return null;
  const hits = tags
    .filter((t) => t?.commit?.sha === sha && /^v\d+\.\d+/.test(t.name))
    .map((t) => t.name);
  if (hits.length === 0) return null;
  // Highest by version, not by string order — `v4.10.0` sorts below `v4.9.0`.
  hits.sort((a, b) => {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return hits[hits.length - 1];
}

/** Whether a tag is a bare major, which is a moving reference rather than a release. */
const isBareMajor = (tag) => /^v\d+$/.test(tag);

const pins = await collectPins();

if (process.argv.includes("--fix-annotations")) {
  // Replace a bare-major annotation with the release the pin actually names, reading
  // the SHA from the file rather than from a list typed by hand.
  //
  // The first attempt at this passed a hand-transcribed map of action to SHA, and one
  // of the nine SHAs was 39 characters instead of 40. The substitution matched
  // nothing, reported success, and the check that asked the question said one pin was
  // still wrong. A `replace` that changes nothing is indistinguishable from one that
  // worked, so this reads the SHAs it needs out of the workflow files and fails if a
  // substitution reports zero replacements.
  let fixed = 0;
  for (const pin of pins) {
    if (!isBareMajor(pin.tag)) continue;
    const release = await releaseFor(pin.repo, pin.sha);
    if (!release) continue;
    for (const file of pin.files) {
      const full = path.join(WORKFLOWS, file);
      const text = await readFile(full, "utf8");
      const pattern = new RegExp(
        `(uses:\\s*${pin.repo.replace(/[/.]/g, "\\$&")}(?:/[^\\s@]+)?)@${pin.sha}\\s*#\\s*${pin.tag}(/[^\\s]*)?`,
        "g"
      );
      const next = text.replace(pattern, (_m, head, subpath) => `${head}@${pin.sha} # ${release}${subpath ?? ""}`);
      if (next === text) {
        console.error(`  ${file}: ${pin.repo} pattern matched nothing — refusing to report a fix that did not happen`);
        process.exit(1);
      }
      await writeFile(full, next);
      fixed++;
    }
    console.log(`  ${pin.repo.padEnd(38)} ${pin.tag} -> ${release}`);
  }
  console.log(`\n  ${fixed} workflow file(s) rewritten.`);
}

if (process.argv.includes("--explain")) {
  // What each pin actually is, and whether the annotation says so.
  let loose = 0;
  let unknown = 0;
  for (const pin of pins) {
    const release = await releaseFor(pin.repo, pin.sha);
    if (!release) {
      unknown++;
      console.log(`  ?  ${pin.repo.padEnd(38)} ${pin.sha.slice(0, 10)}  annotated ${pin.comment}  (no tag names it)`);
      continue;
    }
    const exact = release === pin.tag;
    if (exact) {
      console.log(`  =  ${pin.repo.padEnd(38)} ${pin.sha.slice(0, 10)}  ${release}  (annotation is exact)`);
      continue;
    }
    loose++;
    const why = isBareMajor(pin.tag)
      ? `\`${pin.tag}\` is a MOVING reference, not a release`
      : `annotated ${pin.tag}`;
    console.log(`  !  ${pin.repo.padEnd(38)} ${pin.sha.slice(0, 10)}  really ${release}  — ${why}`);
  }
  console.log(
    `\n  ${pins.length} pins: ${loose} annotated imprecisely, ${unknown} with no release tag.`
  );
  process.exit(loose > 0 || unknown > 0 ? 1 : 0);
}

if (process.argv.includes("--refresh")) {
  const entries = [];
  const problems = [];
  for (const pin of pins) {
    const result = await commitFor(pin.repo, pin.tag);
    if (result.error) {
      problems.push(`${pin.repo}@${pin.sha} claims ${pin.tag}: ${result.error}`);
      entries.push({ repo: pin.repo, sha: pin.sha, tag: pin.tag, matches: null, error: result.error });
      continue;
    }
    const matches = result.sha === pin.sha;
    if (!matches) {
      problems.push(
        `${pin.repo} is pinned to ${pin.sha.slice(0, 10)} but annotated ${pin.tag}, ` +
          `which is ${String(result.sha).slice(0, 10)}${result.annotated ? " (annotated tag)" : ""}`
      );
    }
    entries.push({ repo: pin.repo, sha: pin.sha, tag: pin.tag, matches, annotated: result.annotated });
  }
  const record = {
    $comment:
      "Generated by scripts/verify-action-pin-versions.mjs --refresh. Each entry is the commit a " +
      "pinned action's annotated version actually names, so verify-action-pins.mjs can check the " +
      "annotation offline. Refresh after changing a pin; the gate fails if this is stale or incomplete.",
    verifiedAt: new Date().toISOString().slice(0, 10),
    maxAgeDays: MAX_AGE_DAYS,
    entries: entries.sort((a, b) => a.repo.localeCompare(b.repo) || a.tag.localeCompare(b.tag)),
  };
  await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote ${entries.length} entries to scripts/action-pin-versions.json (${record.verifiedAt}).`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} pin(s) do not match the version they annotate:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("Every pin matches the version it annotates.");
} else {
  /* --- the gate: offline, comparing the record against the code --------------- */

  let record;
  try {
    record = JSON.parse(await readFile(RECORD, "utf8"));
  } catch {
    console.error(
      "scripts/action-pin-versions.json is missing or unreadable.\n" +
        "Run: npm run verify:action-pin-versions -- --refresh"
    );
    process.exit(1);
  }

  const problems = [];
  const byKey = new Map(record.entries.map((e) => [`${e.repo}@${e.sha}`, e]));

  for (const pin of pins) {
    const entry = byKey.get(`${pin.repo}@${pin.sha}`);
    if (!entry) {
      problems.push(
        `${pin.repo}@${pin.sha.slice(0, 10)} in ${pin.files.join(", ")} is annotated ${pin.tag} ` +
          `but has no record. The annotation is unverified — run --refresh.`
      );
      continue;
    }
    if (entry.tag !== pin.tag) {
      problems.push(
        `${pin.repo}@${pin.sha.slice(0, 10)} is annotated ${pin.tag} in the workflow but ` +
          `${entry.tag} in the record. One of them was edited without the other.`
      );
    }
    if (entry.matches === false) {
      problems.push(
        `${pin.repo} is pinned to ${pin.sha.slice(0, 10)} but annotated ${pin.tag}, which is a ` +
          `different commit. The annotation is wrong, so a reviewer comparing this pin against ` +
          `the ${pin.tag} release is comparing against a lie.`
      );
    }
  }

  // A pin removed from the workflows but still in the record is not a failure — it is
  // how a record stays useful across a removal. It is reported, though, because a
  // record that only ever grows is not a record of anything.
  const live = new Set(pins.map((p) => `${p.repo}@${p.sha}`));
  const stale = record.entries.filter((e) => !live.has(`${e.repo}@${e.sha}`));

  const ageDays = Math.floor((Date.now() - Date.parse(record.verifiedAt)) / 86_400_000);
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    problems.push(`the record's verifiedAt (${record.verifiedAt}) is not a date.`);
  } else if (ageDays > (record.maxAgeDays ?? MAX_AGE_DAYS)) {
    problems.push(
      `the record is ${ageDays} days old and its limit is ${record.maxAgeDays ?? MAX_AGE_DAYS}. ` +
        `A record nobody refreshes is the same failure as a check nobody runs. Run --refresh.`
    );
  }

  if (problems.length > 0) {
    console.error("Action pin version annotations are not trustworthy:\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("");
    process.exit(1);
  }

  console.log("Action pin version annotations OK.");
  console.log(`  ${pins.length} distinct pin(s) across ${new Set(pins.flatMap((p) => p.files)).size} workflow file(s)`);
  console.log(`  every SHA is the commit its annotated version names, verified ${record.verifiedAt}`);
  if (stale.length > 0) {
    console.log(`  ${stale.length} recorded pin(s) are no longer in any workflow:`);
    for (const e of stale) console.log(`    ${e.repo}@${e.sha.slice(0, 10)} (${e.tag})`);
    console.log("  Run --refresh to drop them.");
  }
}
