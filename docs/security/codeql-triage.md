# CodeQL triage

Every open CodeQL alert, grouped by rule, with a reason. The source of truth for
the *count* is the API, not this file:

```sh
gh api 'repos/:owner/:repo/code-scanning/alerts?state=open&per_page=100' \
  --jq '.[] | "\(.rule.id)|\(.rule.severity)|\(.most_recent_instance.location.path)"'
```

**63 open alerts across 14 rules**, not the 25 the roadmap recorded — the number
had drifted, which is itself a reason to record the grouping rather than the
count.

**After this triage: 24 dismissed with a reason, 39 open, and every one of the 39
is real.** Of those 39, 16 are fixed in this release and will clear when it is
pushed — 8 unpinned actions and 7 unused locals (6 here, 1 left deliberately in
`examples/`), plus the log injection. That leaves 21 unrated routes and 2
filesystem races, both recorded below as open decisions rather than defects.

**3.5.1 closed the 21, and the number was wrong in both directions.**

| verdict | count | what it was |
|---|---|---|
| fixed | 8 | a real gap — see SEC-061 |
| already limited | 9 | the rule cannot see a limiter in a `preHandler` array, or behind a named helper |
| deliberately not limited | 3 | written down, so the omission is a decision rather than an oversight |
| authenticated | 1 | needs a WebAuthn signature — a possession factor a session thief lacks |

**62 alerts triaged, 2 open, and both are real.** What is left is two
`js/file-system-race` in `src/services/setup/configWriter.ts`, recorded below as an
open decision.

A number that is wrong in the *safe* direction is worse than one that is wrong in
the dangerous direction, because it trains people to dismiss the tool. Nine of 21
alerts were routes that were already protected, and every one of them looked exactly
like a real gap to anyone reading the alert.

Three further groups were cleared while reading them, none of which needed a code
change:

- **`gcm-no-tag-length` (5).** 12 bytes is the GCM **IV** length, not the tag. The
  code uses a 16-byte IV and a 16-byte (128-bit) tag, and NIST SP 800-38D permits up
  to 128 bits. Obeying the rule would shorten the tag from 128 to 96 bits — the rule
  is a net loss, and it is also the rule that found SEC-059 by accident.
- **`js/http-to-file-access` (3, test helpers).** `OUTPUT_PATH` is `process.argv[2]`,
  the path the test runner passes when it spawns the probe. No request, header or body
  reaches the filename.
- **`detect-non-literal-regexp` (4, `bump-version.mjs`).** Fixed rather than
  dismissed: the keys came from a literal array in the same file, but a key
  containing `.` or `(` would have silently matched more than intended, and this file
  has already shipped that class of bug once.

The grouping matters more than the dispositions. 10 of the 14 rules are the same
false positive repeated, and 21 alerts are one already-enumerated decision. A list
of 63 individually-dismissed alerts teaches nothing; a list of 14 groups with a
reason each can be re-checked when a rule changes.

## Summary

| rule | n | verdict |
|---|---|---|
| `js/missing-rate-limiting` | 21 | **real, already enumerated** — see §3.3 |
| `js/insufficient-password-hash` | 10 | false positive — argon2id |
| `actions/unpinned-tag` | 8 | **real** — fixed, SHA-pinned |
| `js/unused-local-variable` | 7 | **real** — fixed, dead declarations removed |
| `gcm-no-tag-length` | 4 | false positive — confuses IV length with tag length |
| `raw-html-format` | 4 | false positive — escaping is present |
| `js/file-system-race` | 2 | real class, low impact, setup wizard only |
| `js/log-injection` | 1 | **real** — fixed, SEC-058 |
| `js/http-to-file-access` | 1 | false positive — taint across unrelated statements |
| `js/file-access-to-http` | 1 | false positive — as above |
| `js/trivial-conditional` | 1 | **real** — SEC-060, two dead branches |
| `js/remote-property-injection` | 1 | real class, no security boundary |
| SEC-060 `js/trivial-conditional` | 1 | **real** — two dead branches |
| `direct-response-write` | 1 | false positive — CSV is escaped and owner-only |
| `unsafe-formatstring` | 1 | false positive — internal debug string |

---

## The false positives, and why

### `gcm-no-tag-length` — 4 errors, `secrets/{database,environment,vault}.ts`, `totp.ts`

All four call `createCipheriv(algorithm, key, iv)` and then `getAuthTag()`, with no
`authTagLength` option. The rule wants a 12-byte tag.

**12 bytes is the IV length, not the tag length.** NIST SP 800-38D allows GCM tag
lengths of 32, 64, 96, 104, 112, 120 and 128 bits; 128 bits — 16 bytes — is the
strongest and is what Node defaults to and what the WebCrypto API mandates.
Following the rule would *weaken* every one of these to 96 bits.

The real question behind the rule is whether the tag is **verified on decrypt**,
which is what makes ciphertext authenticated. All four sites call `setAuthTag()`
before `final()`, so a tampered ciphertext is rejected. Checked rather than
assumed — and see the note below about how that check nearly produced the opposite
conclusion.

### `raw-html-format` — 4, `saml.ts:456`, `saml.ts:458`, `password.ts:75`, `rateLimit.ts:222`

An Express rule applied to Fastify. On the two SAML sites both interpolated values
pass through `escapeXml()` and the response is `application/xml`, not
`text/html`:

```ts
entityID="${escapeXml(connection.spEntityId)}"
Location="${escapeXml(connection.spAcsUrl)}"
```

AGENTS.md requires exactly this and the code does it. Dismissed.

### `js/http-to-file-access` / `js/file-access-to-http` — 2, `keystone-cli/src/index.ts`

CodeQL's taint analysis connects the `fetch()` in `request()` to the `writeFile()`
in `saveConfig()` because they are in the same file. They are unrelated: the config
written is assembled from CLI flags, and the destination is a fixed path.

```ts
const CONFIG_PATH = join(homedir(), ".keystonerc");
```

Not user-controlled, so a taint path into it would still be a false positive.

### `direct-response-write` — 1, `admin/platform.ts:109`

The audit CSV export. The XSS rule fires on `reply.send(<string>)`, but the
response is `text/csv` behind `requirePlatformRole("owner")`, and the cells are
already escaped for both delimiter and formula injection:

```ts
const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
```

The `^[=+\-@\t\r]` guard is the part that matters: an audit-log field containing
`=cmd|...` becomes inert text rather than a formula in whatever opens the file.
This is a case where the code is ahead of the alert.

### `js/insufficient-password-hash` — 10

The rule recognises bcrypt, scrypt and pbkdf2 by call shape. Keystone hashes
passwords with **argon2id**, through a separate `hashPassword` call, so every
site is flagged and none is wrong. One reason, 10 dismissals.

### `js/trivial-conditional` — 1, `workflows/engine.ts:165` — SEC-060, real

Originally written off as "CodeQL wants a `switch`". The alert's own message is
more specific than that, and reading it was the whole point:

> This use of variable 'isOutOfScope' always evaluates to false.

It is. `triggerWorkflowRun` builds `blockedReason` as a five-deep nested ternary
whose last two branches are `triggerMismatch` and `isOutOfScope` — and line 145
returns `undefined` when either is true, so control never reaches the expression
with either set. Two provably dead branches.

The security behaviour was never affected: the guard at 145 is what stops the
run, and it works. What was wrong was the *explanation*. A workflow that did not
run because the event was out of scope, or because the trigger did not match, left
no run record and no reason — so an operator asking "why didn't my workflow fire?"
got nothing at all. The dead branches read as an attempt to explain a decision the
code had already made and returned.

Fixed, with a comment recording why the other two reasons cannot be reached.

**The lesson is in the dismissal I nearly wrote.** "CodeQL wants a switch" was
true, complete, and would have closed a real finding. The alert text is part of
the alert; reading the rule's name and stopping there is how a correct detector
gets dismissed.

### `unsafe-formatstring` — 1, `connectors/google.ts:118`

```ts
console.debug(`[GoogleConnector] ${message}:`, err);
```

`message` is a connector-internal string built in that file, not user input, and
the call is behind `NODE_ENV !== "test"`. Dismissed.

### `js/remote-property-injection` — 1, `frontend/useHashRoute.ts:17`

`params[decodeURIComponent(key)] = value` from a URL hash. The shape is real
(remote-controlled property assignment), but `params` is a plain object in the
admin dashboard's own bundle, its keys are read back to build a query string, and
`params["__proto__"] = "x"` is a no-op on a plain object. There is no security
boundary being crossed — the value came from the user's own address bar and goes
back to their own page.

---

## The real ones

### `js/missing-rate-limiting` — 21

**Not a false positive, and not new.** These are the routes §3.3 enumerated as
having no rate limit, and the decision there was to *report* rather than gate: a
mechanical rule cannot tell a login from a discovery document, and a gate that
fires on both trains people to ignore it. CodeQL arriving at the same set
independently is corroboration, not news.

**Closed in 3.5.1 (SEC-061).** This was the one entry recorded as "a product
judgement and not a mechanical one", and it turned out to be a judgement in both
directions: **8 were real, 9 were already limited, 3 are deliberately not, and 1 is
authenticated.** The two worth naming are the magic-link verifier — the token is in
the **query string**, so it is the most brute-forceable route in the system — and the
SAML assertion consumer, which runs signature verification on an attacker-supplied
assertion.

The three that stay unlimited are written down in `docs/security/rate-limiting.md`,
because an omission nobody recorded looks exactly like an oversight and the next
person to read this alert has no way to tell they were decided.

### `actions/unpinned-tag` — 8

Real, and the cheapest fix in the list. Every `uses:` was pinned to a major version
(`actions/checkout@v4`), which is a moving target: `@v4` can be re-pointed at new
commits by whoever owns the action. Pinned to commit SHAs with the version in a
trailing comment, which is what makes the pin reviewable rather than mysterious.

### `js/unused-local-variable` — 7

Six were dead declarations in `scripts/` and `packages/`, found by extending the
linter to those trees (§5.0). The seventh is in
`examples/login-form-react/backend-example.ts`.

Two of them were worth having:

- `scripts/verify-image-hygiene.mjs` declared `CREDENTIAL_FILES` — "credential
  files that must not be in the image" — and never used it, while the built-image
  check hardcoded a *smaller* set in a shell `find` with no `.keystore` and no
  `.git/`. The declaration and the behaviour disagreed, and a reader comparing
  them would reasonably conclude `.keystore` files were being looked for. The
  `find` expression is now derived from the list, so a pattern that is not in the
  list is not checked and there is one place to add one.
- `packages/keystone-sdk/src/index.ts` built a `fields` array and never used it;
  the actual work was three hardcoded `querySelectorAll` calls. Dead code in a
  published package, and a sign someone started to generalise the field list and
  did not finish.

### `js/log-injection` — 1, `services/email.ts:27`

**Real.** The console email provider interpolates message content into log lines:

```ts
console.log(`To: ${message.to}`);
console.log(`Subject: ${message.subject}`);
console.log(message.text);
```

A subject or body containing a newline forges a log entry, which is how log
integrity gets quietly lost. Recorded as SEC-058 and fixed by emitting one
structured line.

### `js/file-system-race` — 2, `services/setup/configWriter.ts`

TOCTOU between checking and writing a config file. Real class. Impact is low: the
setup wizard runs once, by an operator, before the server accepts traffic, and the
window is a few milliseconds against an attacker who would need local filesystem
access at that moment. Recorded, not fixed — the honest fix is `open` with
`O_EXCL` and a retry, which is worth doing and is not a 3am change.

---

## Six alerts this work introduced, and what happened to each

CodeQL's PR check counts alerts **in the code the pull request changed**, so a
triage that dismisses other people's findings and writes its own still shows red.
These were all in new files in this release:

### `js/file-system-race` × 3 — fixed, not dismissed

`scripts/bump-version.mjs` and `scripts/sync-sdk-versions.mjs` read a file,
transform it, and write it back. An edit landing between the read and the write is
silently lost — and during a release bump that is the worst possible moment to
lose one, because the version moves, the manifest moves, and the change vanishes
with no error anywhere.

Both now do a **compare-and-swap**: re-read immediately before writing, and refuse
if the file differs from what was transformed. Verified by extracting the helper,
pointing it at a file whose contents had moved, and confirming it refuses and
leaves the file alone.

This is the same lesson as `scripts/lib/patch.mjs`, reached from a different
direction: a write that lands on something other than what you read should be loud
rather than quiet.

### `js/http-to-file-access` × 3 — suppressed in the source, with a reason

`src/tests/helpers/deadDatabaseProbe.ts` and `operationalProbe.ts` boot a server,
call it, and write the response body to a file the parent test reads.

That is a false positive: the destination is a path the parent created with
`mkdtemp`, and no untrusted path is involved. The alternative — printing to stdout —
is a parsing problem both files' headers already explain at length, having been
built after the first attempt at stdout extraction proved it.

**A `// codeql[js/http-to-file-access]` suppression was tried and does not work.**
The comment was placed on the line above the `writeFile` in each fixture, the push
was re-analysed, and all three alerts fired again at the shifted line numbers. The
CodeQL CLI image is not reachable from this environment, so the syntax could not be
checked locally, and the pull request's own analysis was the verification — which
is how a suppression that does nothing gets found rather than believed.

So the comments were **removed**. A comment claiming to suppress something that is
still reported is worse than no comment: it reads as a decision, and the alert that
follows it is the reader's confusion. Dismissed on the alert instead, with this
reason, once the alerts become dismissable after merge.

### `js/file-system-race` — the same fix, and the same code, behaving differently

`bump-version.mjs` cleared as soon as the compare-and-swap was extracted into a
function. `sync-sdk-versions.mjs` did **not**, with the comparison inlined in the
same shape: the alert stayed, and the first CI run still reported it while the
identical helper elsewhere was clean.

The rule reasons about a value read from the filesystem, used in a condition, and
then written — all in one body. A function boundary is where it stops looking. So
"the fix is the same" is not the same as "the fix works", and the only way to know
which was to push and read the next analysis.

---

## SEC-059, medium — one secrets provider encrypts with unauthenticated CBC — FIXED

Four of the five locally-encrypting providers used AES-256-GCM. The fifth,
`secrets/azureKeyVault.ts`, used AES-256-**CBC**, which is malleable and
unauthenticated: someone with write access to the stored ciphertext can flip
chosen plaintext bits without the key, which is the position encrypting secrets at
rest exists to defend against. Exploitability is limited — a bit flip in a TOTP
secret or an OAuth client secret does not obviously yield either — which is why
this is medium and not high.

**Fixed in 3.5.1.** See below for what that took, which is the interesting part.

### Reading `errors` alongside `results`, or a broken scan looks like a clean one

Writing the semgrep rule that keeps this fixed took the longest of anything in this
release, and the reason is worth more than the rule.

The rule is straightforward: forbid `createCipheriv` with a non-AEAD algorithm
under `src/services/secrets/`. It returned **zero findings** — and zero findings is
what a rule that does not fire returns, so there was no way to tell the two apart
from the field I was reading. The rule was broken three separate ways:

1. **A string literal's metavariable value carries its quotes.** `^aes-\d+-cbc$`
   matches nothing; `^"aes-\d+-cbc"$` matches the literal. Established by
   bisection against a scratch file:

   ```
   ^.*$     -> 2 matches        ^aes.*$    -> 0
   ^".*"$   -> 1 match         ^"aes.*"$ -> 1
   ```

2. **YAML quoting.** The pattern contains double quotes, so it needs YAML single
   quotes. The unquoted form parsed but did not match; the double-quoted form
   needed escapes and matched nothing either.

3. **One of the two rules was missing `languages`.** That made the *whole config*
   invalid, so semgrep scanned **zero paths** and reported zero findings.

Every one of those is the same failure as `containersOf` reading `spec.containers`
and `rangeAdmits` accepting every range it did not recognise: **a control that
reports success for the thing it exists to catch.** What changed the outcome was
not reading `results` more carefully — it was printing `results`, `errors` and
`paths.scanned` together, at which point `errors: 2` and `paths scanned: 0` said
what was wrong immediately.

The scratch harness had the same bug. A minimal rule without `message` or
`severity` is an *invalid config*, and semgrep reports that as zero findings too,
so four successive "the pattern does not match" conclusions were actually "the
config did not load".

`--error` does exit non-zero on a config error, so CI would have failed the job.
Only the local runs were misleading, and only because they printed one number.

### The test that tested a copy

The first SEC-059 suite duplicated the encrypt and decrypt functions into the test
file. Reverting the provider to CBC left all nine tests green, because the tests
were not running the provider. A test of a copy cannot fail.

So the cipher is now `src/services/secrets/cipher.ts`, imported by the provider and
by the test. Reverting `cipher.ts` to unauthenticated CBC fails 2 of 10 — the
format assertion and the round trip — and restoring it passes 10 of 10.

The extraction also removes four near-duplicates: the other four providers each
carried their own idea of the layout, and they happen to agree today, which is a
fact about today.

### The migration, and why it is not a read path

Changing the cipher invalidates every stored value, and a secrets provider has no
safe default for a value it cannot read. So:

- `encryptAtRest` writes only GCM, in the format the other three already use.
- `decryptAtRest` reads GCM **and** the pre-3.5.1 CBC form, and throws on anything
  else rather than guessing.
- Migration is the **existing explicit operation**,
  `npm run db:reencrypt-oidc-secrets`, which walks `oidcConnections.clientSecret`
  and re-encrypts anything not in the current format. It had to be taught to
  recognise the CBC format: it deliberately *skips* values that already look
  encrypted, which is right for a value in an older layout and wrong for one in an
  unauthenticated cipher.
- Each legacy read logs `legacy_ciphertext_decrypted`, so a deployment can see the
  remaining set without running the migration.

The first version of the code comment claimed "every read writes back", which is
not what happens and cannot: `decryptSecret` returns plaintext and has nowhere to
persist a re-encrypted value, and a read that silently rewrites storage is a
surprise nobody asked for. Corrected in the source.

### The general gate, so it cannot recur

`keystone-secrets-aead-only` forbids a non-AEAD `createCipheriv` anywhere under
`src/services/secrets/` or in `totp.ts`, and
`keystone-secrets-legacy-cbc-is-named` requires the one remaining
`createDecipheriv` to sit in a function whose **name** says it is a migration.

Crude, and deliberately: a reviewer reading `decryptLegacyCbc` learns something a
reviewer reading `decrypt` does not. What the name buys is that the legacy path is
*findable*, and "have we finished migrating" becomes a property of the source
rather than a thing to remember.

Both rules were verified by reverting the provider to CBC and confirming the
first one fires, and by the bisection table above.
