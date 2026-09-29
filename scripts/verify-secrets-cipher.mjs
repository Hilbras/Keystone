#!/usr/bin/env node
/**
 * The secrets providers' ciphers, checked statically.
 *
 * Two things, and the second is the one that took the work.
 *
 * **1. No provider may write a non-AEAD cipher.** This is the general gate for
 * SEC-059, where `azureKeyVault.ts` used AES-256-CBC while its four siblings used
 * AES-256-GCM. Four siblings doing it right is evidence, not a control.
 *
 * `keystone-secrets-aead-only` in `.semgrep.yml` covers the same ground, and this
 * check exists because a rule that silently stops matching is indistinguishable
 * from a clean codebase — which is how that rule was broken three separate ways
 * before it worked, including a missing `languages` that made semgrep scan **zero
 * paths** and report zero findings. Two mechanisms for one property is not
 * redundancy when one of them has already lied; this one is a direct string
 * check, so it cannot.
 *
 * **2. The count of legacy unauthenticated *reads* is recorded.** After SEC-059
 * there is exactly one: the pre-3.5.1 CBC format in `cipher.ts`, which must stay
 * readable or every stored value becomes undecryptable.
 *
 * The intent was to require that read to live in a function whose name says it is
 * temporary. Semgrep cannot express that — there is no
 * `metavariable-pattern-not-regex`, and the `pattern-not-inside` workaround binds
 * its metavariable only inside the negative, so the conjunction never holds and
 * the rule matches nothing at all.
 *
 * Counting works, and counts do something the rule could not: **removing the last
 * legacy read is a visible, deliberate change** rather than something that happens
 * quietly and is only noticed when a customer cannot log in. The count lives in
 * this file, so changing it is a code review item.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = path.join(root, "src/services/secrets");
const TOTP = path.join(root, "src/services/totp.ts");

/**
 * The number of legacy unauthenticated decryption sites that may exist.
 *
 * **Two**, both reads of a format written before the authenticated one:
 *
 * - `services/secrets/cipher.ts` — the Azure Key Vault provider's pre-3.5.1
 *   format. SEC-059.
 * - `services/totp.ts` — the `v1` TOTP-seed format, superseded by `v2`. Found by
 *   this check, not by a review: it is the same defect in the same shape in a
 *   second place, which is what a general gate is for. SEC-064.
 *
 * Both exist for the same reason and the same reason is the only good one: a value
 * that cannot be decrypted is a value that cannot be recovered, and a secrets
 * provider has no safe default for that.
 *
 * Change this number and the change says why in the diff. Reaching 0 means every
 * stored value has been migrated and both branches can go.
 */
const ALLOWED_LEGACY_READS = 2;

const NON_AEAD =
  /\b(aes-\d+-(?:cbc|ecb)|des|des-ede3|rc4|rc2|blowfish|cast5|idea|seed)\b/i;
const AEAD = /\b(aes-\d+-(?:gcm|ccm|chacha20)|chacha20-poly1305)\b/i;

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = [...(await sourceFiles(SECRETS)), TOTP];

const problems = [];
const fail = (m) => problems.push(m);
const notes = [];

let legacyReads = 0;
let legacyReadSites = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  const where = path.relative(root, file);
  const lines = text.split("\n");

  // Resolve the module's own algorithm constants, so a call that names its
  // algorithm through a constant is classified the same as one that inlines the
  // string. `cipher.ts` does exactly that, and the first version of this check
  // reported zero legacy reads because of it — which is the "zero findings" shape
  // again, this time from a check that simply could not see the code.
  const constants = new Map();
  for (const m of text.matchAll(/^(?:export\s+)?const (\w*(?:ALGORITHM|CIPHER|MODE)\w*)\s*=\s*["']([^"']+)["']/gm)) {
    constants.set(m[1], m[2]);
  }

  lines.forEach((line, index) => {
    const at = `${where}:${index + 1}`;
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
    const call = /create(?:Cipher|Decipher)iv\(\s*([^,)]+)/.exec(code);
    if (!call) return;
    const raw = call[1].trim().replace(/^["'`]|["'`]$/g, "");
    const algorithm = constants.get(raw) ?? raw;

    const isWrite = code.includes("createCipheriv");
    const isLegacy = NON_AEAD.test(algorithm) && !AEAD.test(algorithm);

    if (isWrite && isLegacy) {
      fail(
        `${at} — writes with "${algorithm}", which is neither an AEAD nor authenticated. ` +
          `Anyone who can write to the stored ciphertext can change the plaintext without ` +
          `the key, which is the position encrypting secrets at rest exists to defend ` +
          `against. Use AES-256-GCM. (SEC-059)`
      );
      return;
    }
    if (!isWrite && isLegacy) {
      legacyReads++;
      legacyReadSites.push(`${at} (${algorithm})`);
    }
  });
}

if (legacyReads > ALLOWED_LEGACY_READS) {
  fail(
    `${legacyReads} legacy unauthenticated decryption sites, but only ` +
      `${ALLOWED_LEGACY_READS} is recorded in scripts/verify-secrets-cipher.mjs:\n` +
      legacyReadSites.map((s) => `        ${s}`).join("\n") +
      `\n      A new one means a new place where stored, unauthenticated ciphertext can ` +
      `still enter the system. If the migration is complete, the count should go to 0 ` +
      `and ALLOWED_LEGACY_READS with it — deliberately, in a diff that says why.`
  );
} else if (legacyReads < ALLOWED_LEGACY_READS) {
  notes.push(
    `the legacy read path is gone (${legacyReads} of ${ALLOWED_LEGACY_READS} recorded). ` +
      `If every stored value has been migrated, set ALLOWED_LEGACY_READS to 0 and ` +
      `delete the branch.`
  );
}

if (files.length === 0) {
  fail("no secrets provider sources were found, so nothing was checked");
}

if (problems.length > 0) {
  console.error("Secrets cipher check failed:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  process.exit(1);
}

console.log("Secrets cipher OK.");
console.log(`  ${files.length} file(s) checked, no provider writes a non-AEAD cipher`);
console.log(
  `  legacy unauthenticated reads: ${legacyReads} of ${ALLOWED_LEGACY_READS} recorded` +
    (legacyReadSites.length ? ` — ${legacyReadSites.join(", ")}` : "")
);
for (const n of notes) console.log(`  note: ${n}`);
