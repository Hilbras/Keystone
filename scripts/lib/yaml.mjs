/**
 * A small YAML reader for the Kubernetes manifests.
 *
 * Hand-written rather than pulled from npm for one reason: this is a **gate**,
 * and a gate that depends on another package is a gate with a second failure mode
 * — a bad release of the parser, or a manifest using YAML this does not
 * implement, stops the build for a reason that has nothing to do with the code.
 *
 * The subset is the one `k8s/` uses: nested maps, lists of maps, scalars, flow
 * sequences, and `|` / `|-` block scalars for the inline patches. Anything
 * outside it is skipped rather than guessed at, and
 * `scripts/verify-k8s-manifests.mjs` fails on a kustomization that uses a key its
 * renderer does not implement — so the gap is loud rather than silent.
 *
 * **The list handling normalises the input up front.** A list item that begins a
 * map —
 *
 * ```yaml
 * envFrom:
 *   - configMapRef:
 *       name: keystone-config
 *   - secretRef:
 *       name: keystone-secrets
 * ```
 *
 * — is rewritten to
 *
 * ```yaml
 * envFrom:
 *   -
 *     configMapRef:
 *       name: keystone-config
 * ```
 *
 * so the parser has one code path rather than one for "a list item with an inline
 * key" and one for "a list item with a value". The first version spliced the two
 * forms together and **dropped the second `envFrom` entry**, so the manifest check
 * reported `DATABASE_URL` unreachable while the manifest plainly provided it. The
 * symptom was in a Kubernetes gate; the cause was here.
 */

/** Expand `key: |` and `key: |-` block scalars into a single quoted scalar. */
function expandBlockScalars(rawLines) {
  const out = [];
  for (let i = 0; i < rawLines.length; i++) {
    const block = /^(\s*)([^:]+):\s*\|[-+]?\s*$/.exec(rawLines[i]);
    if (!block) {
      out.push(rawLines[i]);
      continue;
    }
    const [, indent, key] = block;
    const body = [];
    let j = i + 1;
    while (j < rawLines.length) {
      const candidate = rawLines[j];
      if (candidate.trim() === "") {
        body.push("");
        j++;
        continue;
      }
      if (candidate.length - candidate.trimStart().length <= indent.length) break;
      body.push(candidate);
      j++;
    }
    out.push(`${indent}${key}: ${JSON.stringify(body.join("\n"))}`);
    i = j - 1;
  }
  return out;
}

/**
 * Rewrite every `- …` into a bare `-` with the item's content on the next line.
 *
 * All of these become the same shape, so the parser has one code path:
 *
 * ```yaml
 * - namespace.yaml            ->  -        namespace.yaml
 * - configMapRef:             ->  -        configMapRef:
 *   name: keystone-config         name: keystone-config
 * - name: keystone            ->  -        name: keystone
 * ```
 *
 * The first version only rewrote the second form, so a list of plain strings was
 * read as no list at all (`kustomization.resources` came back as an object, and
 * the gate threw), and a list item with an inline key *and* a value —
 * `- name: keystone` — was read as a map with a key literally called `- name`, so
 * `containers` came back empty.
 */
function expandListHeaders(lines) {
  const out = [];
  for (const line of lines) {
    const item = /^(\s*)- (?!$)(\S.*)$/.exec(line);
    if (item) {
      const [, indent, rest] = item;
      out.push(`${indent}-`);
      out.push(`${indent}  ${rest}`);
      continue;
    }
    out.push(line);
  }
  return out;
}

function stripComments(lines) {
  return lines
    .map((line) => {
      // A `#` inside a quoted scalar is not a comment. The only quoted scalars
      // this parser produces are block-scalar bodies, which are JSON strings.
      if (/:\s*".*"$/.test(line)) return line;
      const at = line.indexOf(" #");
      return at === -1 ? line : line.slice(0, at);
    })
    .filter((line) => line.trim() !== "" && !/^\s*#/.test(line));
}

export function parseScalar(raw) {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((s) => parseScalar(s))
      .filter((v) => v !== null);
  }
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseYaml(source) {
  const cleaned = stripComments(expandListHeaders(expandBlockScalars(source.split("\n"))));

  let cursor = 0;
  const indentOf = (line) => line.length - line.trimStart().length;

  function parseBlock(minIndent) {
    if (cursor >= cleaned.length) return null;
    const firstIndent = indentOf(cleaned[cursor]);
    if (firstIndent < minIndent) return null;

    if (cleaned[cursor].trim() === "-") return parseList(firstIndent);

    // A block whose only content is one colonless line is a scalar — the
    // `namespace.yaml` in a `resources:` list. Without this it was skipped, so a
    // list of strings parsed as an empty object.
    const firstLine = cleaned[cursor].trim();
    if (!firstLine.includes(":")) {
      const next = cleaned[cursor + 1];
      const nextIsDeeper = next !== undefined && indentOf(next) > firstIndent;
      if (!nextIsDeeper) {
        cursor++;
        return parseScalar(firstLine);
      }
    }

    const map = {};
    while (cursor < cleaned.length) {
      const line = cleaned[cursor];
      const lineIndent = indentOf(line);
      if (lineIndent < firstIndent) break;
      if (lineIndent > firstIndent) {
        // Stray deeper indent where a key was expected. Skip it rather than
        // mis-read the rest of the document, and let the manifest check complain
        // about whatever the missing key turned out to matter for.
        cursor++;
        continue;
      }
      if (line.trim() === "-") break;
      const match = /^([^:]+):\s*(.*)$/.exec(line.trim());
      if (!match) {
        cursor++;
        continue;
      }
      const [, key, rest] = match;
      cursor++;
      map[key.trim()] = rest.trim() === "" ? parseBlock(firstIndent + 1) : parseScalar(rest);
    }
    return map;
  }

  function parseList(listIndent) {
    const list = [];
    while (cursor < cleaned.length) {
      const line = cleaned[cursor];
      if (indentOf(line) !== listIndent || line.trim() !== "-") break;
      cursor++;
      // The item's content, if any, is indented past the dash.
      if (cursor < cleaned.length && indentOf(cleaned[cursor]) > listIndent) {
        list.push(parseBlock(listIndent + 1));
      } else {
        list.push(null);
      }
    }
    return list;
  }

  return parseBlock(0) ?? {};
}

export async function loadYamlFile(file) {
  const { readFile } = await import("node:fs/promises");
  return parseYaml(await readFile(file, "utf8"));
}
