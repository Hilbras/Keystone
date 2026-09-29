/**
 * Apply a set of literal replacements, and **fail if any of them does not apply**.
 *
 * Written because of a specific mistake: a migration step reported "manifests
 * pinned to 3.4.0" for a `str.replace` that matched nothing, because the pattern
 * was indented two spaces deeper than the file. The message was a lie, it was
 * believed, and the next step failed confusingly. A `replace` that changes
 * nothing is a silent no-op that looks exactly like a success.
 *
 * Usage:
 *
 * ```js
 * const applied = replaceAll(file, [
 *   ["old text", "new text"],
 *   ["more old text", "more new text"],
 * ]);
 * applied.assert();   // throws listing whatever did not match
 * ```
 */
import { readFile, writeFile } from "node:fs/promises";

export function replaceAll(file, edits) {
  return new PendingPatch(file, edits);
}

class PendingPatch {
  constructor(file, edits) {
    this.file = file;
    this.edits = edits;
    this.missed = [];
    this.hits = 0;
  }

  async apply() {
    let text = await readFile(this.file, "utf8");
    for (const [from, to] of this.edits) {
      if (!text.includes(from)) {
        this.missed.push(from.split("\n")[0].slice(0, 60));
        continue;
      }
      // Every occurrence, not just the first: a patch that half-applies is worse
      // than one that does not apply.
      const parts = text.split(from);
      this.hits += parts.length - 1;
      text = parts.join(to);
    }
    if (this.hits > 0) await writeFile(this.file, text, "utf8");
    this.assert();
    return this;
  }

  assert() {
    if (this.missed.length > 0) {
      throw new Error(
        `patching ${this.file}: ${this.missed.length} pattern(s) matched nothing, so the ` +
          `change was not made and saying otherwise would be worse than failing:\n` +
          this.missed.map((m) => `  - ${m}`).join("\n")
      );
    }
    return this;
  }
}
