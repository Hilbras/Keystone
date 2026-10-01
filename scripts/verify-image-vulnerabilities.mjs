#!/usr/bin/env node
/**
 * Gate on vulnerabilities in the **image that will actually be published**.
 *
 * ## Why this exists
 *
 * `release.yml` ran `npm audit --omit=dev --audit-level=high` and then built and
 * **pushed** the container image with no vulnerability check on it. `npm audit` sees
 * JavaScript advisories only. The OS packages in the runtime base — glibc, pcre2,
 * openssl, and the rest of Debian's security surface — were invisible to the
 * release gate entirely.
 *
 * A Trivy scan *did* exist, in `supply-chain.yml`. It was not enough, for two
 * reasons, and the second is the one that matters:
 *
 * 1. It is not a required check on `main` and not a dependency of the release
 *    workflow, so a release can proceed with it red.
 * 2. **It scans a locally-built image, not the published one.** It runs
 *    `docker build -t hilbras-keystone:scan .` in its own job. The image the
 *    release pushes is built separately, from a separately-resolved base. A scan
 *    of a different artifact than the one that ships is a control that reports
 *    success for something other than what it protects.
 *
 * That is the same defect class as the 3.5.12 Ingress blind spot and the 3.5.13
 * gate probe, and it is the reason a HIGH advisory in the runtime base could reach
 * a merged release with every existing gate green.
 *
 * ## What it checks
 *
 * The image, after build, before push. CRITICAL and HIGH only — a scanner that
 * reports everything gets ignored, and the project's own `.semgrep.yml` scopes say
 * the same thing about noise.
 *
 * `--ignore-unfixed` is honoured for the same reason: an advisory with no fix is
 * not actionable, and blocking a release on it teaches people to bypass the gate.
 * An exception is still possible, and must be recorded in
 * `docs/security/registry-exceptions.md` with an expiry.
 *
 * ## Exit codes
 *
 * | code | meaning |
 * | --- | --- |
 * | 0 | clean, or every finding is covered by a recorded exception |
 * | 1 | one or more unexcepted CRITICAL/HIGH findings |
 * | 2 | the scan could not be trusted — see the messages, which say which |
 *
 * The 2 is deliberate. A scan that failed to *run* is not a scan that passed, and
 * a gate that cannot distinguish the two reports success on an empty result. This
 * is the failure this whole project keeps finding, and the exit code is where it
 * gets caught.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXCEPTIONS = path.join(root, "docs", "security", "registry-exceptions.md");

/** Only these severities fail the gate. */
const BLOCKING = new Set(["CRITICAL", "HIGH"]);

const imageRef = process.argv[2];
if (!imageRef) {
  console.error("usage: verify-image-vulnerabilities.mjs <image-ref> [--json]");
  console.error("  The ref must be the image that will be published, not a locally built copy.");
  process.exit(2);
}
const asJson = process.argv.includes("--json");

/**
 * Trivy identifiers this gate has never seen.
 *
 * Recorded in the exceptions file so an unfixable or accepted advisory is a
 * documented, expiring decision rather than a permanent silent hole — the same
 * contract `npm audit` has in `release.yml`.
 */
function acceptedIdentifiers() {
  if (!existsSync(EXCEPTIONS)) return new Map();
  const text = readFileSync(EXCEPTIONS, "utf8");
  const accepted = new Map();
  // Only the "Currently accepted" section, so the advisory history below it — which
  // is kept deliberately, for the record — cannot silently authorise a live
  // finding. That distinction is the whole point of keeping a history.
  const current = text.split(/^##\s/m).find((s) => /Currently accepted/i.test(s)) ?? "";
  for (const line of current.split("\n")) {
    const row = line.trim();
    if (!row.startsWith("|")) continue;
    const cells = row.split("|").map((c) => c.trim());
    // Header and separator rows, and the single-cell "None." statement.
    if (cells.length < 3) continue;
    /**
     * Columns are read **by position from the documented schema**, and the schema
     * is a seven-column table: a leading empty cell from the leading `|` plus
     * Advisory, Dependency, Severity, Reason, Mitigation, Expires, Owner, and a
     * trailing empty cell.
     *
     * The first version destructured `[advisory, , severity, , , expires]`, which
     * assumed six columns and therefore read **Owner** as the expiry. Every
     * exception then failed the `expires` check and was rejected — so a recorded,
     * reasoned, dated exception was silently treated as no exception at all. The
     * gate still failed, so the failure mode was safe; the mistake was in the
     * thing that was supposed to *unblock* a release, and it would have been found
     * by the first person who tried to use one.
     *
     * `lastIndexOf` for the owner rather than a fixed index, so a reason containing
     * a pipe cannot shift the columns. The severity is checked against the
     * blocking set before the expiry is trusted, so a malformed row cannot accept
     * a LOW finding as a HIGH one.
     */
    const body = cells.slice(1, -1);
    if (body.length < 6) continue;
    const advisory = body[0];
    const severity = body[2];
    const expires = body[body.length - 2];
    if (!advisory || /^(advisory|---)/i.test(advisory)) continue;
    if (advisory === "None" || advisory === "None.") continue;
    if (!BLOCKING.has(severity.toUpperCase())) continue;
    if (!expires || expires.toLowerCase() === "—" || expires.trim() === "") continue;
    if (Number.isNaN(new Date(expires).getTime())) continue; // unparseable is not a date
    if (new Date(expires) <= new Date()) continue; // expired
    accepted.set(advisory, { severity, expires });
  }
  return accepted;
}

let raw;
try {
  raw = execFileSync(
    "trivy",
    [
      "image",
      "--format", "json",
      "--severity", "CRITICAL,HIGH",
      "--ignore-unfixed",
      "--quiet",
      imageRef,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
} catch (err) {
  // Plain JS, not TypeScript: this is a `.mjs` script, and a cast here is a
  // syntax error rather than a type hint. The first version of this file used
  // `err as {...}` and did not run at all.
  const e = /** @type {{ code?: string | number, message?: string, stdout?: string, stderr?: string }} */ (err);
  // A missing binary and a failed scan both land here, and neither is a pass.
  console.error("Image vulnerability scan could not be run.");
  if (e.code === "ENOENT" || /not found/i.test(e.message ?? "")) {
    console.error("  `trivy` is not installed or not on PATH.");
  } else {
    console.error(`  ${String(e.stderr ?? e.message ?? "unknown error").slice(0, 500)}`);
  }
  console.error("");
  console.error("This is deliberately a failure and not a pass: a gate that cannot");
  console.error("distinguish 'the scan found nothing' from 'the scan did not run'");
  console.error("reports success on an empty result.");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error("Image vulnerability scan returned output this gate could not parse.");
  console.error("A scan whose result cannot be read is not a passing scan.");
  if (!asJson) console.error(raw.slice(0, 500));
  process.exit(2);
}

const accepted = acceptedIdentifiers();
const blocking = [];
const excepted = [];

for (const result of report.Results ?? []) {
  for (const vuln of result.Vulnerabilities ?? []) {
    const id = String(vuln.VulnerabilityID ?? "");
    const severity = String(vuln.Severity ?? "").toUpperCase();
    if (!BLOCKING.has(severity)) continue;
    const entry = {
      id,
      severity,
      pkg: String(vuln.PkgName ?? ""),
      installed: String(vuln.InstalledVersion ?? ""),
      fixed: vuln.FixedVersion ? String(vuln.FixedVersion) : null,
      target: String(result.Target ?? ""),
    };
    if (accepted.has(id)) {
      excepted.push({ id, severity, expires: accepted.get(id).expires });
    } else {
      blocking.push(entry);
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ blocking, excepted }, null, 2));
} else {
  for (const v of excepted) {
    console.log(`  excepted: ${v.id} (${v.severity}) until ${v.expires}`);
  }
  for (const v of blocking) {
    const fix = v.fixed ? `fix in ${v.fixed}` : "no fix available";
    console.log(`  ${v.severity.padEnd(8)} ${v.id}  ${v.pkg} ${v.installed} — ${fix}`);
  }
}

if (blocking.length > 0) {
  console.error("");
  console.error(`Image vulnerability gate FAILED: ${blocking.length} unexcepted finding(s).`);
  console.error("");
  for (const v of blocking) {
    console.error(
      `  ${v.severity} ${v.id} in ${v.pkg} ${v.installed} (${v.target})` +
        (v.fixed ? ` — fixed in ${v.fixed}` : " — no fix available")
    );
  }
  console.error("");
  console.error("To accept one, record it in docs/security/registry-exceptions.md under");
  console.error("'Currently accepted', with a reason, a mitigation and an expiry date.");
  console.error("An entry without an expiry is treated as no entry.");
  process.exit(1);
}

console.log(
  blocking.length === 0
    ? `Image vulnerability gate OK for ${imageRef}` +
        (excepted.length > 0 ? ` (${excepted.length} excepted).` : ".")
    : ""
);
