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

The decision is still open and the count is uncomfortable — 21 routes on an
authentication server. It is recorded in the registry as an open item rather than
closed here, because closing it properly means deciding which of the 21 are
actually abusable, which is a product judgement and not a mechanical one.

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

## SEC-058, medium — one secrets provider encrypts with unauthenticated CBC

Found while triaging `gcm-no-tag-length`, by asking the question the rule was
actually asking.

Four of the five locally-encrypting secrets providers use AES-256-**GCM**. The
fifth, `secrets/azureKeyVault.ts`, uses AES-256-**CBC**:

```ts
const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
```

CBC is malleable and unauthenticated. Someone with write access to the stored
ciphertext — a compromised database row, a tampered backup — can flip chosen
plaintext bits without the key. Encrypting secrets at rest exists to defend
against exactly that position, and this provider does not.

Exploitability is limited: a bit flip in a TOTP secret or an OAuth client secret
does not obviously yield the key or the secret, and the attacker must already hold
DB write. That is why this is medium and not high.

**Not fixed in this pass, deliberately.** Changing the cipher invalidates every
already-encrypted value, and a secrets provider has no safe default for a value
it cannot decrypt. The migration needs a read-both/write-new path — the repository
already has the shape of one in `db/reencryptOidcSecrets.ts` — and it needs to
happen as a planned operation, not as a patch. Recorded so it is not lost.

### A note on how nearly this was got wrong

The first check asked "does every GCM site call `setAuthTag` before `final()`?"
and reported `azureKeyVault.ts` as **missing** `setAuthTag`. It is not missing:
that provider uses CBC, so there is no auth tag to set. The check was asking a
GCM question of a non-GCM site and produced a confident, wrong, alarming answer.

It is recorded here because the error is the instructive part. A check that finds
a serious-looking result in code nobody has looked at is exactly when to slow
down and read the surrounding function, rather than to open a finding.
