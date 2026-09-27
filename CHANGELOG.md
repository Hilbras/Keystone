# Changelog

All notable changes to Hilbras Keystone are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-09-27

### Security

- **Two registry entries withdrawn, because they were not real.** `SEC-043` and
  `SEC-044` were added during the 2.9.0 release with fixes at
  `src/services/saml/validator.ts` and `src/routes/sso.ts` — a directory that does
  not exist and a file that does not exist — and with issue descriptions the tests
  do not cover. `saml-validator.test.ts` exercises the *valid* signed-response
  path; it does not test a missing audience or issuer requirement.
  `sso-endpoint.test.ts` tests `isPrivateAddress`, a guard on operator-supplied
  endpoint addresses; it does not test an unregistered host alias. Neither had an
  evidenced defect behind it, so neither was a finding. Both are now recorded
  under `withdrawn` with the reason, and their suites under a new `coverage`
  section — a suite that asserts a property is coverage, not a vulnerability.
- **The registry validator never checked the `fix` field**, which is how the two
  above passed. It verified that the named *test* existed and that the *test* had
  a test in it; nothing confirmed the entry's claim about where the fix lives. It
  now resolves the fix site against the repository. Four entries named paths that
  do not exist; two were the invented ones, and the other two named
  `src/services/saml/*` for SAML logic that lives in `src/routes/saml.ts`. All
  four corrected.
- **Contiguity was the wrong rule for ids.** Renumbering after a withdrawal would
  change every id other documents already cite, and a registry whose ids shift is
  one nobody can reference. Ids may now gap, and a gap must be explained by a
  withdrawal carrying a reason. Set-based, not positional, so withdrawing one id
  does not invalidate the rest of the tail.

### Added

- `docs/RE-AUDIT.md` — the v3.0.0 re-audit matrix, **generated and verified**
  rather than written. Every cell is checked against the repository when the file
  is produced: `Fixed` only if the fix site exists, `Regression Test` only if the
  named file exists *and contains a test*. Deleting a test turns the cell red on
  the next run instead of leaving a stale assurance in a release document.
- `scripts/render-reaudit-matrix.mjs`, wired into `npm run reaudit:check`, the
  test suite, and the release gate. `npm run reaudit:render` regenerates it.
- `coverage` and `withdrawn` sections in the registry, so a suite with no finding
  behind it is recorded honestly and a removed finding is explained.

### Verified

- **Multi-tenant isolation, re-audited.** Every organization-scoped admin route
  was checked for a membership guard in the requested organization rather than
  the caller's own. `requireOrganizationRole` resolves `orgId` from
  `request.params.id` and checks membership in *that* organization, so the pattern
  is sound. Routes using only `app.authenticate` were traced into the
  application layer: `GET /organizations/:id` calls `getOrganization`, which
  enforces `requireOrganizationPermission` before returning. SAML and OIDC
  connection routes use org-scoped repository methods (`listByOrgId`,
  `findByIdAndOrgId`) rather than bare id lookups. No cross-tenant path found.

### Gate results

| Gate | Result |
| --- | --- |
| `npm run lint` | 0 warnings, 0 errors |
| `npm run typecheck` | pass |
| `npm run registry:check` | 44 entries, 18 suites, 12 of 12 attack classes |
| `npm run reaudit:check` | 18 plan findings, every claim verified |
| `npm test` | 450 pass, 1 skipped, 0 fail |
| `npm run test:security` | 402/402 |

## [2.9.0] - 2026-09-27

### Security

- **The security regression registry is now machine-enforced.** All 46 findings
  from the hardening programme are recorded in `docs/security/registry.json` with
  the issue, the fix, the test that fails without it, the documentation and the
  release. `npm run registry:check` fails when an entry names a test that does not
  exist, when a security suite is claimed by no entry, or when a mandatory attack
  class is uncovered. The registry is generated into
  `docs/security/registry.md` so the prose cannot drift from the data.

  This matters because a registry that is allowed to become false is worse than no
  registry: it converts "I don't know whether this is covered" into "yes,
  covered". Four of the 44 entries exist because an event, a test or a rule was
  present but never actually exercised.

- **48 security tests were not running, and the run reported success.**
  `node --test` expands `**` as a single directory level rather than as globstar,
  so the discovery patterns stopped matching as soon as the security suites gained
  a directory level. The entire authorization suite dropped out; everything that
  remained passed, so the job went green. There is now one pattern per directory
  depth, spelled out, with no overlap between them.

- **A deleted security test would have kept running.** `tsc` does not remove
  output for sources that are renamed or deleted, so a moved suite ran twice under
  two paths and a deleted suite continued to pass in CI. The build now cleans
  `dist` first.

- **Secret scanning added over the full history.** Gitleaks, on push and pull
  request, scanning every commit rather than the tip. The repository history is
  clean — no npm token, no signing key, no private key. A deliberately planted
  private key under `src/tests/` is still caught, so the test-fixture allowlist
  does not become a hole.

- **CodeQL added** for JavaScript/TypeScript and Actions, on push, pull request
  and weekly, failing on `error` severity.

- **8 project-specific Semgrep rules**, each mapped to a registry entry. They
  encode defects this codebase actually shipped, including two that are ordering
  and completeness problems no general rule can see: `requireHumanPrincipal`
  placed before `app.authenticate` sees no service account and permits everything,
  and a secret-denylist where an allowlist is the only correct shape. Each rule
  was verified to fire on a deliberately vulnerable fixture and to stay silent on
  the real backend.

### Added

- `docs/security/registry.json` — 44 findings, machine-readable and enforced.
- `docs/security/registry.md` — generated from the above.
- `docs/security/registry-exceptions.md` — the only place a release gate may be
  waived, and an entry without an expiry does not count.
- `docs/security/{rate-limiting,scopes,configuration,audit,supply-chain}.md`.
- `scripts/verify-security-registry.mjs` and `scripts/render-security-registry.mjs`.
- `src/tests/helpers/paths.ts` — resolves paths from the nearest `package.json`,
  so a suite can be moved without its paths silently breaking.
- `src/tests/security/registry.test.ts` — the registry check runs as part of
  `npm test`, not only at release time.
- `src/tests/security/authentication/login-abuse.test.ts` — 7 tests for 2.8.0
  behaviour that shipped untested.
- `src/tests/security/audit-export.test.ts` — 5 tests for the CSV export.
- `src/tests/security/service-accounts/audit-attribution.test.ts` — 5 tests for
  audit attribution of a machine principal.
- `.github/workflows/{codeql,sast}.yml`, `.semgrep.yml`, `.gitleaks.toml`.
- 7 release-gate steps in `release.yml`, replacing a single audit call.

### Fixed

- `mfa.test.ts` now connects Redis, so it exercises the rate limiter rather than
  passing because the limiter failed open. (Shipped in 2.8.0; the connection is
  what makes the suite meaningful.)

### Testing

`npm test` and `npm run test:security` are unchanged in count where the change was
organisational, which is the point: 430 tests before the restructure, 430 after,
381 security tests before, 381 after. The 7 new authentication tests are on top.

### Fixed

- **The audit log export did not neutralise spreadsheet formula injection.** The
  CSV export quoted a value containing a delimiter or a quote, but a value whose
  first character is `=`, `+`, `-` or `@` is evaluated as a formula by Excel,
  LibreOffice and Google Sheets when the file is opened. Several exported columns
  are attacker-supplied — the user agent above all — and an audit export is
  precisely the file an operator opens in a spreadsheet, so that is the expected
  consumer rather than an edge case. A `User-Agent` of `=cmd|'/c calc'!A1`
  reached the export intact. A leading apostrophe is now applied before quoting,
  and a value with no formula prefix is left untouched. (SEC-045)

  It came out of triaging Semgrep's advisory findings. The rule that pointed at
  the code, `direct-response-write`, is a false positive — the content type is set
  explicitly and every field is escaped — but the code it flagged was not sound.
- **Every service-account request produced no audit record at all.** A machine
  principal carries a sentinel id of `sa:<uuid>` so that routes expecting
  `request.user` keep working without a matching user row. The audit subscriber
  passed that sentinel into `audit_log.user_id`, which is a uuid column. Postgres
  rejected the insert, the subscriber's `catch` logged `failed to write event`, and
  the record was lost. The request succeeded, so nothing failed visibly, and a
  missing audit record is indistinguishable from a request that never happened.

  So every request authenticated by an API key or an mTLS service account left no
  audit trail. The privileged, non-human path was the one that was invisible,
  which is the wrong direction for that gap to point. The sentinel is now stripped,
  `user_id` is left null, and the service account is recorded in
  `metadata.serviceAccountId`. (SEC-046)

  It surfaced in CI and not locally: a new test's fixture passed on this machine
  and failed in CI, and the reason was visible in the log above the failure.

### Fixed

- **The published package could not be imported.** `dist/index.js` and
  `dist/index.d.ts` shipped with no `main` and no `types`, so
  `import "@hilbras/keystone"` did not resolve. The `bin` worked, so the CLI was
  usable and the library surface was not — and nothing failed, which is why it
  went unnoticed. `main` and `types` are now declared. Deliberately *not* `exports`:
  that would be the more complete fix but is a breaking change for anyone
  deep-importing `dist/` paths, and 2.6.0 is already published.
- **The migration guides did not ship.** `docs/` was never in `files`, so the
  instructions for the breaking changes in 2.4.0, 2.6.0 and 2.7.0 were reachable
  only on GitHub. Someone upgrading via npm received the changelog but not the
  document it referred to.
- **`npm run verify:release` had a gap that allowed both.** It checked version,
  license and repository, and a package with no entry point and no documentation
  passed. It now also requires `main`/`types` to exist on disk, requires the
  migration docs in `files`, requires `dist/tests` to stay excluded, and refuses
  to publish credential material. Verified by reverting: each of the three
  defects is caught with a message naming the problem.

### Known limitations

- The Semgrep scan covers the backend. Semgrep's TypeScript support fails on a
  `.tsx` file in the frontend dashboard (TSX generics versus JSX ambiguity) and
  aborts the whole scan rather than skipping one file, so the frontend is not
  scanned. This is a tool limitation, recorded rather than papered over.
- The `keystone-cookie-without-secure` rule stays silent when a cookie's options
  are spread from another variable, because the rule cannot substantiate a finding
  there. `auth.ts` builds its options in a helper and spreads them.
- The Semgrep community rulesets (`p/default`, `p/security-audit`,
  `p/owasp-top-ten`) run **advisory**, not blocking. Their 15 findings against
  `src/` have been triaged: four are `escapeXml` output the rule cannot see
  through, six are `console.*` log-forging at worst, four are AES-GCM where Node
  enforces the tag length through `setAuthTag`, and one was the `direct-response-write`
  false positive that led to SEC-045. Gating on a community ruleset nobody has
  worked through means either a permanently red build or a gate that gets switched
  off, so they report and the triage is recorded here instead. The project ruleset
  in `.semgrep.yml` is the blocking gate.
- Two suites span two domains rather than being split: `proxy/trust-boundary.test.ts`
  also covers mTLS certificate binding, and `oauth/oauth2-hardening.test.ts` also
  covers OIDC ID token verification. Splitting them is mechanical but every split
  copies the whole import header into each partition, and the resulting churn
  risks removing a live import. The registry records the mapping instead.

## [2.8.0] - 2026-09-27

### Security

- **A Redis outage removed rate limiting entirely.** Every limiter checked
  `isRedisReady()` and returned `true` when Redis was down. During an outage
  `login`, `mfa/verify`, `sms-otp/verify` and the OAuth token exchange had no limit
  at all — and an outage is exactly when unlimited attempts are worth having,
  because it is the moment an attacker cannot be traced to a single event stream.
  Sensitive endpoints now fall back to a bounded in-process budget. The fallback
  is strictly weaker: a client gets one budget per instance. That is a
  degradation worth having; unbounded is not. The store is capped, because an
  unbounded map keyed by client address is itself a denial-of-service vector.
- **MFA verification shared one budget across all users behind an address.** The
  key was `mfa-verify:<address>:<body.email>`, and that endpoint does not carry
  an email, so every second-factor verification from one address drew on the same
  budget of 20. An attacker got 20 guesses; so did an office behind a single NAT,
  where one busy office could lock out every legitimate second-factor login. The
  key now includes the challenge, which identifies one login attempt, giving an
  attacker 20 guesses at the code they are actually attacking without spending
  anyone else's budget.
- **Second-factor management shared one budget per address.** The TOTP routes
  allowed 10 attempts keyed on the address alone, with the same consequence.
  Brute-forcing a TOTP code is per-account, since the code is checked against one
  user's secret, so the budget is now keyed on the user.
- **Credential spraying was unbounded.** The login budget was keyed on address
  *and* submitted address, so it stopped repeated guesses at one account and did
  nothing about an attacker who varied the address on every request and guessed
  across a thousand accounts from one host. A second, address-keyed budget bounds
  that independently.
- **A refused request left no record.** A rate-limit trip produced a `429` and
  nothing else, so sustained guessing at `login` or `mfa/verify` was invisible
  except in aggregate. `rate_limit_triggered` now records the endpoint, the client
  address, and **which limiter decided** — a degraded in-process control is a
  different operational situation from a healthy distributed one, and conflating
  them would hide it.
- **Failed logins were never audited.** `user_login_failed` existed in the event
  vocabulary and was never emitted, on either `/login` or `/token-login`.
- **A replayed refresh token was indistinguishable from an unknown one.** It is now
  detected, emits `refresh_token_replayed`, and revokes the account's remaining
  credentials — a replay means the token is known to somebody else, so answering
  only that one request leaves the rest of what it could mint intact.
- **API key creation had no rate limit.** Minting a credential is an
  authentication event and is now bounded.

### Already sound, verified rather than assumed

`X-Forwarded-For` handling, the trusted-proxy model, and the address-based rate
limit keys were delivered in v2.0.0. Item 3 of this phase is therefore
verification rather than new work: a spoofed header from an untrusted peer, a
multi-entry header, `x-real-ip`, `Forwarded`, IPv4, IPv6, and both spellings of
IPv4-mapped IPv6 are now covered by tests.

### Added

- `src/services/localRateLimit.ts` — the in-process fallback, bounded and swept.
- `refresh_token_state` inspection, distinguishing a spent token from an unknown
  one.
- 16 tests: the emergency limiter's accounting, bounding and eviction behaviour;
  proxy spoofing across IPv4, IPv6, mapped IPv6, and multi-entry headers; an
  enumeration check that every sensitive limiter carries the emergency flag,
  including the ones built by a factory; and the abuse event payloads.

### A test suite that was not testing what it appeared to

`mfa.test.ts` never connected Redis. The shared client is created with
`lazyConnect`, so every rate limit in that suite was evaluated against a limiter
that was not running, and the suite passed **only because the limiter failed
open** — the behaviour this phase removes. It now connects Redis explicitly, and
surfaced two real keying defects that had been hidden by fail-open. Fixing those
took the suite from 12 failures to 55/55.

## [2.7.0] - 2026-09-27

### Security

- **The admin configuration endpoint leaked secrets it did not recognise.**
  Redaction was a denylist: a set of known-sensitive names plus a regex. Run
  against 24 secret-looking key names it missed 12, among them `SIGNING_KEY`,
  `JWT_SIGNING_KEY`, `SENDGRID_KEY`, `PROVIDER_APIKEY`, `SAML_CERT`, `TLS_KEY`,
  `CERT_PRIVATE`, `HMAC_KEY`, `KMS_KEY` and `DB_URL`. The endpoint returned their
  values in the clear to an owner-authenticated caller. A denylist is a losing
  game here: the next person to add a secret-bearing variable leaks it and
  nothing fails. Redaction is now an **allowlist**, so a key is private until
  someone deliberately decides otherwise.
- **CORS allowed every origin when `ALLOWED_ORIGINS` was empty.** The origin
  callback returned true for an empty allowlist, so an unset variable was
  equivalent to "permit every origin" on a server that sends credentialed
  cookies. It now fails closed and logs a warning at boot, so a misconfiguration
  is visible before a browser is turned away rather than after.
- **The setup server reflected any origin with credentials.** It creates the owner
  account and writes configuration, and was registered with `origin: true`. Any
  page a browser visited could attempt a credentialed request against the
  bootstrap surface. Origins must now be listed, defaulting to its own loopback
  addresses.
- **The setup token was written to stdout in cleartext.** It appeared in
  container logs, in journald, and in whatever ships logs off the host, where it
  remains readable long after the bootstrap it was for. It is a full
  account-initialisation credential. It is now printed only on an explicit
  `KEYSTONE_PRINT_SETUP_TOKEN=true`, and never in production. The rejection path
  also no longer logs the presented and expected token lengths, which disclosed
  the length of the expected token.
- **Webhook signing secrets were stored in plaintext.** A database dump yielded a
  working signing key for every endpoint, letting an attacker forge deliveries
  that the receiving service would accept as genuine. They are now encrypted with
  AES-256-GCM under the existing key. **Encrypted rather than hashed**, because
  Keystone signs outbound payloads with the secret and therefore has to be able
  to recover it; hashing would make signing impossible. Rows written before this
  change are read unchanged, and re-saving or rotating an endpoint upgrades them.
- **Session cookies were not `Secure` by default in production.** The default was
  `false`, so an operator who did not set `COOKIE_SECURE` received cookies that
  would be sent over plain HTTP. Production now defaults to `true`; development
  still defaults to `false` and either can be set explicitly.
- **The setup server bound to all interfaces.** It inherited `HOST`, which
  defaults to `0.0.0.0` — correct for the main server and wrong for the one that
  creates the owner account. It now defaults to loopback, honours a private
  interface, and warns if explicitly told to bind to everything.

### Changed

- CORS policy extracted to `isOriginAllowed` in `src/services/trustedProxies.ts`,
  shared by the main and setup servers.
- `EXPOSABLE_CONFIG_KEYS` is the allowlist. `isSensitiveConfigurationKey` is
  retained for the write path, where a client may legitimately send a value that
  must be recognised as "preserve this, do not overwrite it".

### Added

- 27 tests: configuration redaction against the 12 previously-leaked names, the
  setup token's logging behaviour in all three modes, webhook secret encryption
  including the legacy plaintext read path and signature stability, the CORS
  policy, and the production deployment defaults.

## [2.6.0] - 2026-09-27

### Security

- **The API key scope guard had a bypass by construction.** It read
  `scopes.includes(scope) || scopes.includes("service_account")`, so a key whose
  scope list contained the literal string `"service_account"` satisfied *every*
  scope requirement. That string was client-suppliable: `POST /api-keys` stored
  whatever `scopes` it was given, with no validation against any list.
- **The same guard also failed open.** It returned early whenever
  `apiKeyScopes` was absent, which is indistinguishable from "this is a session".
  A key that resolved without a scope list therefore skipped the check entirely.
- **The guard was never referenced.** `requireScopes` was defined and decorated
  onto the Fastify instance, but no route in the repository used it. Scopes were
  stored, returned to callers, and enforced nowhere.

### How exploitable this actually was

Stated precisely, because it matters for prioritising: `app.authenticate` is
JWT-only and returns 401 for anything that is not a valid access token.
`authenticateOrApiKey` is the handler with the API key path, and before this
release exactly one route used it — `GET /auth/validate`. A leaked API key
therefore reached one endpoint, which returns the caller's own public profile.

So the exposure was a credential whose stated limits were fiction, on a
credential that could be used almost nowhere. That is a real defect and worth
fixing, but it is not an authentication bypass, and describing it as one would
mislead anyone deciding what to do first.

### Changed

- `src/services/scopes.ts` — a scope registry: the canonical names, their
  descriptions, per-principal defaults, validation, and the allow-list grant
  check. A scope that is not defined cannot be granted.
- Unknown or forbidden scopes are refused at key creation with a `400` naming
  what was rejected and what is allowed, instead of being stored verbatim.
- `requireScopes` now fails closed, keyed off a new `request.apiKeyId` that is
  set only when a machine credential authenticated the request. A session is
  still exempt, since it carries a person's authority and is governed by the
  permission system.
- Applied to the routes where a credential's limits matter most: API key
  creation, listing and revocation, session listing and revocation, and profile
  read and write.
- `profile:read`, `profile:write`, and `mfa:manage` are human-only. A service
  account's profile is a synthesized object with an id of `sa:<uuid>` that
  matches no user row, so the scope is meaningless for a machine and misleading
  in an audit log.
- A service account's default grant is now `organizations:read` only. A personal
  key's default is read-only on the caller's own resources; the previous
  `api:read` default was not in any registry, which is a fair indication that
  nothing was checking it.

### Added

- `src/plugins/machinePrincipal.ts` — `requireHumanPrincipal`, refusing a service
  account on TOTP, WebAuthn, SMS OTP, identity linking, OAuth consent, and
  userinfo routes with an explicit `403` and an audit record. This is a backstop
  rather than a fix for a live hole: those routes are JWT-only today, so a
  machine credential is refused with a 401 before the guard is reached. It exists
  so that switching a route to `authenticateOrApiKey` does not silently make a
  machine principal acceptable somewhere a person was assumed.
- 25 tests covering the registry, validation, intersection, the grant check, the
  fail-closed behaviour, HTTP enforcement on the one key-reachable route, and
  the machine-principal boundary.

### Fixed

- Scope enforcement is keyed on `apiKeyId` rather than the presence of a scope
  list, closing the fail-open path.
- The `service_account` wildcard no longer grants anything.
- Scope ordering is normalised, so two equivalent requests produce identical
  rows.

## [2.5.0] - 2026-09-27

### Security

- **The OIDC nonce never reached the Google connector.**
  `GoogleConnector.exchangeCode` overrode the base method and called
  `super.exchangeCode(code, redirectUri)` without forwarding its options, so the
  nonce added in 2.4.0 was discarded. Every other OIDC provider validated the
  nonce; Google — the default, and therefore the most likely to be deployed — did
  not. An ID token minted for a different user or session would have been
  accepted on that path.
- **The unsigned SAML `Issuer` was never validated.** The response-level
  `<saml:Issuer>` sits outside both signed regions, so rewriting it does not
  invalidate the signature, and neither samlify nor Keystone compared it to the
  registered IdP. SAML 2.0 §2.5.1.5 requires a relying party to verify an
  unsigned issuer against trusted metadata. An assertion could claim to have been
  issued by a different identity provider. The assertion's own issuer is inside
  the signed region and was always covered; this closes the element the signature
  cannot.

### Fixed

- `verifyRelayState` returned by throwing on a missing or non-string signature,
  turning a malformed RelayState — a bad request an attacker fully controls —
  into a 500 rather than a 400. It now returns false for anything malformed.
- A missing `userinfoEndpoint` was passed to the fetcher behind a non-null
  assertion, producing `userinfoEndpoint must be a valid URL` for a URL that was
  never configured. It is now reported as unconfigured so enrichment is skipped.

### Added

- 24 adversarial SAML tests covering tampered signatures, untrusted signing keys,
  rotated-out certificates, unsigned assertions, XML signature wrapping, issuer
  and audience substitution, destination and recipient prefix / superstring / case
  variants, expired assertions, `NotBefore` violations, `InResponseTo` mismatch,
  transaction replay, and five RelayState tampering scenarios.
- 10 tests for OIDC userinfo endpoint resolution, Google nonce forwarding, and
  organization-scoped membership.
- `docs/security/enterprise-sso.md` — SAML and OIDC setup, every check applied to
  an assertion or ID token, certificate rotation, endpoint SSRF policy,
  organization scoping, and recommendations.

### Already sound, verified rather than assumed

Membership is keyed on `(orgId, userId)` throughout, with a unique constraint on
that pair and provisioning via `ON CONFLICT DO NOTHING` — so two simultaneous
logins cannot create duplicate memberships. SAML connections are resolved by
`(connectionId, orgId)`, the transaction is consumed atomically for replay
protection, RelayState is HMAC-signed and bound to a browser nonce compared in
constant time, and assertions and messages are both required to be signed. A test
now pins the membership behaviour rather than leaving it to inspection.

## [2.4.0] - 2026-09-27

### Security

- **The `authorization_code` grant did not authenticate the client.** It looked
  the application up by `client_id` and went straight to redeeming the code,
  never calling `verifyClientSecret`. RFC 6749 §3.2.1 requires a confidential
  client to authenticate at the token endpoint. The code and its PKCE verifier
  were the only factors, so an intercepted code was redeemable by whoever
  intercepted it. Confidential clients must now present `client_secret`; public
  clients are exempt because they have none, and PKCE is what authenticates them.
- **Redirect URIs accepted script-bearing schemes.** Registration validated with
  `z.string().url()`, which accepts anything the URL parser accepts — verified to
  include `javascript:alert(1)` and
  `data:text/html,<script>alert(1)</script>`. A redirect URI becomes a `Location`
  header that the identity provider itself emits, so an organization admin could
  register one and hand any user who authorized their application a redirect
  toward script execution on the auth domain. Browser policy against top-level
  `javascript:` navigation limits the practical impact, but on an identity
  provider this is not an acceptable input. Registration now also rejects
  wildcards, fragments, embedded credentials, and plaintext HTTP to non-loopback
  hosts. A test records that `z.string().url()` accepted each of these.
- **OIDC federation sent no nonce and verified none.** `state` proved the callback
  belonged to a login this browser started, but nothing bound the returned ID
  token to that login. Any ID token the provider considered valid was accepted,
  including one minted for a different user or session. A nonce is now generated
  per authorization request, kept in an httpOnly cookie, sent to the provider, and
  required to match.
- **ID token verification inferred rather than required.** Algorithms are now
  pinned to RS256/ES256/PS256 instead of being derived from the key material, and
  `exp`, `iat`, `iss`, `aud`, `sub` are required rather than validated only when
  present — a token with no expiry was previously accepted indefinitely.

### Changed

- **Effective scopes are intersected, not trusted.** The client's `scope`
  parameter was stored verbatim, with consent as the only filter. The effective
  set is now registered ∩ requested ∩ consented, and a scope outside the
  registration is refused with `invalid_scope` rather than silently dropped, so a
  client asking for authority it was never granted is visible instead of quietly
  downgraded. An empty `allowed_scopes` preserves existing behaviour.
- **Public clients.** A `client_type` column distinguishes `confidential` from
  `public`; a public client is issued no secret rather than a secret it is
  expected to ignore, and a check constraint keeps the two halves consistent.
  `client_secret_hash` is now nullable. PKCE is mandatory for a secretless client
  at both `/authorize` and `/token`; the `verifyPKCE` branch that returned true
  when no challenge was registered is gone.
- **Redirect URIs are compared with one shared helper** at registration and at
  use, so the two cannot drift. Exact string comparison throughout — no prefix
  matching, no normalization, no case folding. The token endpoint's dead
  `redirect_uri IS NULL` tolerance was removed: `redirect_uri` is required at
  `/authorize`, so the branch was unreachable, and it would have accepted any
  redirect URI had the field ever become optional.
- **Refresh tokens carry the granted scope set** in a new `scopes` column, so the
  authorization context survives rotation instead of being dropped at the first
  refresh. A refresh may narrow the grant but never widen it.
- **PKCE comparison is constant-time**, so a verifier cannot be recovered byte by
  byte.

### Already sound, verified rather than assumed

Authorization code consumption was already atomic — a conditional `UPDATE` with
`used_at IS NULL` and a required returned row — and is now covered by a
concurrency test (20 parallel redemptions, exactly one winner). PKCE was already
required at `/authorize` by the request schema, so the dead branch in
`verifyPKCE` was a latent weakness rather than a live bypass. The refresh grant
already validated client binding, MFA context, and organization membership.

### Added

- 42 tests: redirect URI registration and exact matching, PKCE verification,
  scope intersection, client authentication at the token endpoint, public client
  invariants, atomic code consumption, ID token verification against a locally
  signed key (missing / wrong / replayed / expired nonce, no-expiry, wrong issuer,
  wrong audience, foreign signing key), and scope preservation across rotation.

## [2.3.0] - 2026-09-27

### Security

**Completing a password reset did not remove existing access.** It changed the
password and left every session, every refresh token, and every other
outstanding reset token working. A password reset is the standard response to a
suspected compromise, so the previous behaviour defeated its own purpose: an
attacker who triggered the reset kept their session and kept their access, while
the victim believed they had locked the intruder out.

- A successful reset now invalidates all sessions, all refresh tokens, and all
  outstanding recovery credentials for the account.
- Reset tokens issued alongside the one used are now spent, so a reset email
  captured earlier cannot be completed after the user has already recovered.
- Revocation is centralized in `src/services/sessionRevocation.ts`
  (`revokeUserSessions`, `revokeRefreshTokens`,
  `revokeAuthenticationSessions`, `revokeRecoveryCredentials`). It was
  previously open-coded at each call site, which is how the most important site
  came to omit it. The MFA-enablement path now routes through the same function,
  so the rule cannot drift between the two.
- Revocation is scoped to one user, is idempotent, and honours an exclusion for
  a change the user makes to their own account.

API keys are deliberately **not** revoked by a password reset. They are
separately issued, long-lived credentials belonging to integrations rather than
to the person, and killing them silently breaks deployments. The residual gap is
real — a key minted by an attacker who already held the password survives — and
key expiry and rotation is the right answer rather than coupling key lifetime to
a human's password.

### Already sound, verified rather than assumed

- Recovery credentials are 384-bit `crypto.randomBytes`, stored only as a SHA-256
  digest, single-use (since 2.2.0), valid for one hour, rate-limited to 5 per 15
  minutes, and audited.
- `POST /auth/forgot-password` returns `{ success: true }` on both the found and
  not-found paths, so the response does not disclose whether an account exists.
  (A residual timing difference remains, since the found path sends mail.)

### Added

- 9 tests, including that an attacker's session and refresh token do not survive
  a reset, that an intercepted earlier reset token is dead, that a bystander's
  credentials are untouched, and that the recovered user can still log in.

## [2.2.0] - 2026-09-26

### Security

Three single-use credentials were validated with a conditional `SELECT` and then
marked used with an **unconditional** `UPDATE`:

```text
SELECT ... WHERE used_at IS NULL      <- conditional
if (!row) return
UPDATE ... SET used_at = now()        <- UNCONDITIONAL: the race
```

Between those two statements, any number of concurrent requests pass the same
check. Every one of them then succeeds.

- **Magic links** could be redeemed by any number of parallel requests, each
  producing a full login. A link that was meant to be usable once was usable
  indefinitely under concurrency.
- **Password reset tokens** could be spent by parallel requests, each writing a
  different password, last writer winning. This was the most consequential of
  the three: whoever won the race held the account, and an attacker racing the
  legitimate user could take it over.
- **SMS OTP codes** could be verified more than once concurrently, so a
  six-digit code was not single-use.

The fix is to make the write the gate rather than a follow-up:

```text
UPDATE ... SET used_at = now()
WHERE token_hash = ? AND expires_at > now() AND used_at IS NULL
RETURNING ...
```

PostgreSQL evaluates that predicate while holding a row lock, so exactly one
transaction updates the row and observes a returned row. The claim and the
validation become one statement with no window between them.

The four other single-use credentials in scope were already atomic and were
verified rather than assumed: refresh token rotation, MFA challenges, OAuth2
authorization codes, and TOTP backup codes all perform a conditional update and
require a returned row.

### Added

- `src/services/singleUse.ts` — one atomic claim and refusal-classification
  primitive, used by all three credentials. Consumption now lives in one place,
  so a credential cannot drift back into a hand-rolled read-then-write.
- Replay detection. A credential presented after it was already spent now emits
  `magic_link_replayed`, `sms_otp_replayed`, or
  `password_reset_token_replayed`, all of which reach the audit log through the
  event bus. Previously a replay was indistinguishable from a typo, so a leaked
  token returning was invisible to an operator. An **expired** credential is
  deliberately not reported as a replay, because that is not a leak.
- 25 tests, including the plan's 10 / 50 / 100 concurrent-request levels against
  every affected credential, and the same levels through the service entry points
  a route actually calls.

### Changed

- `resetPasswordWithToken` now spends the token before doing any work, and
  reports an expired link distinctly from an invalid one. Spending other live
  reset tokens for the same user after a successful reset, since any were issued
  alongside the one just used.

## [2.1.0] - 2026-09-26

### Security

Four moderate advisories in the development tree, from `drizzle-kit` pulling
`@esbuild-kit/esm-loader`, which pinned its own copy of `esbuild@0.18.20`
(`GHSA-67mh-4wv8-2f99`, fixed in 0.25.0).

The advisory allows a website to send requests to an esbuild **dev server** and
read the response. Keystone never calls esbuild's `serve()` API, the packages
are `devDependencies`, and `npm audit --omit=dev` was already clean, so this was
not exploitable here. It was still a real advisory in the tree that builds and
publishes the artifact, and `npm audit fix --force` offered only a downgrade of
`drizzle-kit` to 0.18.1, which is a breaking change.

Resolved with an `overrides` entry forcing `esbuild >= 0.25.0`, which collapses
all three copies to 0.28.2 and clears the audit for production and development
trees alike. Verified that `db:generate`, `db:migrate`, and `db:seed` all still
work against the forced version, and that no non-dev package resolves esbuild.

### Fixed

- The published container image shipped 8 HIGH-severity advisories that no
  JavaScript scanner can detect. `npm audit` and OSV both read
  `package-lock.json` and correctly reported zero, because the vulnerable
  packages are not in Keystone's dependency tree: they are the ones bundled
  inside the base image's `npm@10.9.9` (`brace-expansion@2.0.2`,
  `ip-address@10.1.0`, `pacote@19.0.2`, `picomatch@4.0.3`, `sigstore@3.1.0`).
  The runtime image never invokes npm — `CMD` is `node dist/index.js`, and the
  development compose override builds the `builder` target, which keeps its own
  npm — so it is now removed from the production stage. This clears all 8 and
  reduces the image from 600 MB to 550 MB.

  Only container scanning finds this class of problem, which is why the gate
  exists. Keystones own `brace-expansion@5.0.12` is already above the fixed
  version and was never affected.

### Added

- `.github/dependabot.yml` — weekly updates for npm (root and frontend), GitHub
  Actions, and Docker. Routine patches are grouped; security updates are not, so
  a compromised package lands alone and identifiable.
- `.github/workflows/supply-chain.yml` — OSV scanning (independent advisory
  source from npm's), enforced `npm audit` over both trees, dependency review on
  pull requests, SBOM generation, container scanning, and a license gate.
- `npm run verify:release` — fails on a version that disagrees between
  `package.json` and the lockfile, a dependency in one and not the other, a
  missing or malformed license, or a missing `repository` field. Wired into both
  CI and the release workflow so a bad artifact cannot be published.

### Fixed

- `package.json` declared no `license` field, despite shipping an MIT `LICENSE`
  file. The published package carried no machine-readable terms.

### Changed

- Fastify is at 5.12.5 and `fast-uri` resolves to 3.1.8, both already above the
  5.12.2 / 3.1.7 targets. No upgrade was required.
- The license allowlist permits only permissive terms, with an explicit
  exception for the pre-SPDX `MIT*` identifier that older packages emit.

## [2.0.0] - 2026-09-26

### Security

The mTLS trust boundary trusted whatever the request said about itself. Any
client that could reach Keystone could name a service account in a header and
become it, and could set its own IP address to escape every rate limit. This
release makes identity come only from values a client cannot forge.

- **`x-service-account-id` no longer authenticates.** It previously resolved a
  service account on its own, with no certificate and no credential, so anyone
  who knew or guessed an account ID became that account. It is now read only as a
  hint alongside a valid certificate, and only when the account it names is the
  one that certificate is bound to. A mismatch is refused, not fallen back from.
- **Client identity is bound to a certificate fingerprint.** A new unique
  `service_accounts.cert_fingerprint` column pins a SHA-256 fingerprint to
  exactly one account. Fingerprints are stored canonicalized, so the hex and
  colon-separated spellings of one certificate cannot become two bindings, and
  malformed values are rejected before reaching the database. Service accounts
  are resolved by fingerprint rather than by their operator-chosen name.
- **Identity headers are stripped from untrusted peers.** An `onRequest` hook
  registered before every plugin and route removes
  `x-forwarded-client-cert`, `x-client-cert-fingerprint`,
  `x-forwarded-client-cert-chain`, `x-service-account-id`, `x-forwarded-for`,
  `x-real-ip`, and `forwarded` unless the peer is a configured trusted proxy.
  Stripping rather than ignoring means a route added later cannot read a
  spoofed identity by accident.
- **Rate limits can no longer be escaped.** The server was created with
  `trustProxy: true` and the limiter read `x-forwarded-for` unconditionally, so
  any client could present a fresh address per request and never be limited —
  including against login, password reset, MFA verification, and SCIM. Limit keys
  now come from the peer address unless a trusted proxy forwarded one.
- **Trust decisions do not use `request.ip`.** With `trustProxy` enabled that
  value is derived from the attacker-controlled header, so the trusted-proxy
  check uses the socket peer address, the only value a client cannot set.
- **Forwarded values are validated before use.** Certificate headers are
  length-capped, and a fingerprint must be a well-formed SHA-256 digest, so
  garbage cannot be used as a lookup key.
- **Inactive and revoked service accounts cannot authenticate by certificate.**

### Added

- `KEYSTONE_TRUSTED_PROXIES` — comma-separated proxy IPs, IPv4 CIDRs, or IPv6
  prefixes permitted to set client-identity headers. Unset by default, which
  trusts nothing. IPv4-mapped IPv6 peers are normalized before matching, and
  unrecognized input fails closed.
- `PUT /v1/admin/organizations/:id/service-accounts/:accountId/certificate` —
  bind or clear a client-certificate fingerprint, auditing
  `service_account_certificate_bound` / `service_account_certificate_unbound`.
  A certificate already held by another account returns `409`.
- `POST /v1/admin/organizations/:id/service-accounts/:accountId/revoke` —
  permanently stop an account authenticating, auditing
  `service_account_revoked`. Revoking an already-revoked account returns `409`
  rather than a silent success.
- `docs/security/trust-boundaries.md`, `docs/security/proxy-security.md`, and
  `docs/security/mtls.md` — the trust model, proxy requirements with working
  nginx and ALB configuration, and the mTLS identity rules.
- `docs/MIGRATION-2.0.md` — migration instructions, including the failure mode
  that presents as unrelated clients sharing a rate-limit budget.

### Fixed

- The SCIM token-hash unique indexes introduced in 1.9.0 were declared in the
  Drizzle schema but never emitted as a migration, so they did not exist in any
  deployed database. They are created by migration `0015`.
- The documented nginx configuration used `$proxy_add_x_forwarded_for`, which
  appends to a client-supplied value and lets a client prepend a forged address.
  Corrected to `$remote_addr`, with inbound identity headers stripped.

### Changed

- `trustProxy` is derived from `KEYSTONE_TRUSTED_PROXIES` instead of being
  unconditionally `true`.
- `requireMTLS` distinguishes an untrusted peer (`401 MTLS_UNTRUSTED_PEER`) from
  a missing certificate (`401 MTLS_CERTIFICATE_MISSING`), so a misconfiguration
  is distinguishable from an attack.

### Breaking

- mTLS clients that authenticated with `x-service-account-id` alone must bind a
  certificate fingerprint instead.
- Deployments behind a reverse proxy must set `KEYSTONE_TRUSTED_PROXIES`.
  Without it, forwarded headers are stripped and every client shares one
  rate-limit budget, so unrelated users can rate-limit each other.

## [1.9.0] - 2026-09-25

### Security

SCIM was a single global credential. In 1.8.x a deployment could provision
exactly one organization, the bearer token was stored and compared in plaintext,
and mutations reached global user records.

- SCIM credentials are per-organization. Every connection belongs to exactly one
  organization, at most one is live per organization, and every user and group
  read and write is filtered by it. A cross-tenant target returns `404`, so the
  endpoint is not a tenant oracle.
- Bearer tokens are stored only as a SHA-256 digest and resolved by that digest,
  so a database dump yields no usable token and the comparison carries no timing
  signal. Connections can expire, be rotated, and be revoked.
- Issuing, rotating, and revoking a SCIM credential is owner-only. A SCIM token
  provisions and deactivates tenant users, so a mere admin or member cannot mint
  one.
- Deprovisioning removes the organization's membership and deactivates the
  account only when no membership remains. Previously it deactivated a shared
  account in every organization that user belonged to, without those
  organizations' authorization.
- SCIM refuses to change the global attributes of a shared user, to reactivate a
  shared account, and to remove the last owner of an organization.
- SCIM can no longer attach a user who already belongs to another organization,
  and the conflict message no longer names the organization that holds them.
- Unauthenticated SCIM traffic is budgeted before the authentication hook emits
  audit and webhook events, closing an unauthenticated write-amplification path.
- SCIM request budgets are keyed per credential, so one noisy identity provider
  cannot exhaust every other tenant's allowance.

### Changed

- `SCIM_BEARER_TOKEN` and `SCIM_ORG_ID` are deprecated. They are adopted once
  into a connection at startup and then ignored, so an upgrade does not break an
  existing identity provider. Adoption is one-time in any state, so a restart
  cannot resurrect a revoked credential.
- Deprovisioning a single-tenant user now removes the membership as well as
  deactivating the account. Deprovisioning a shared user removes only the
  membership, and a follow-up `DELETE` returns `404`.
- `POST /scim/v2/Users` is create-or-update; profile fields for an existing
  member are applied rather than dropped.
- A user removed from an organization can be re-provisioned. Previously the
  global email lookup found the inactive row and returned `409` forever.
- Rotating a credential revokes the previous token immediately
  (`SCIM_ROTATION_GRACE_SECONDS` defaults to `0`). A grace window is now an
  explicit opt-in and is not a revocation mechanism.
- Groups are real organization-scoped records. The synthetic role-bucket
  projection (`<orgId>:<role>` ids) is removed.
- Malformed path ids return a SCIM `404` instead of surfacing a driver error, and
  validation and internal failures return SCIM `Error` objects.

### Added

- `scim_connections` with rotation, revocation, expiry, and a token hint.
- `scim_groups` and `scim_group_members`, organization-scoped throughout.
- `PATCH /scim/v2/Users/:userId` and `POST /scim/v2/Users/.search`.
- Group create, replace, patch, delete, and member management endpoints.
- `filter`, `startIndex`, and `count` on list endpoints; unsupported filters are
  rejected rather than silently ignored.
- `GET /scim/v2/ServiceProviderConfig` and `GET /scim/v2/ResourceTypes`.
- Owner-only admin API for creating, listing, rotating, and revoking SCIM
  connections, with a dashboard UI for the same.
- `findByIdInOrg`, `updateInOrg`, `listOrgIdsForUser`, and `removeFromOrg`
  repository methods for organization-scoped user access.
- Audit events `scim_connection_created`, `scim_connection_rotated`,
  `scim_connection_revoked`, `scim_access_denied`, `scim_authentication_failed`,
  and the `scim_group_*` group events.
- `docs/MIGRATION-1.9.md`.

## [1.8.0] - 2026-09-25

### Security

MFA was advisory in 1.7.x. A user with TOTP enabled could sign in with only a
password, and when a code was supplied it was verified *after* the access token,
refresh token, and session had already been created. 1.8.0 makes the second
factor mandatory.

- Password authentication now stops at `requires_mfa` for MFA-enabled accounts.
  No access token, refresh token, or session row is created at that stage.
- New `POST /auth/mfa/verify` completes the transition. The challenge is opaque,
  stored only as a hash, short-lived, single-use, and bounded by an attempt
  budget enforced in the database.
- Token issuance is guarded at a single chokepoint. A token cannot be minted for
  an MFA-enabled user without a recorded factor, so no login path bypasses MFA by
  omission.
- TOTP verification uses the user's own decrypted secret. Each time-step is
  accepted exactly once, so a captured code is rejected even against a freshly
  issued challenge.
- Enabling MFA revokes every existing refresh token and session for the account.
  Sessions record how MFA was satisfied, and refresh rotation refuses sessions
  with no recorded factor.
- Backup codes carry 80 bits of entropy, are stored as a keyed (peppered) hash,
  expire after 90 days, and are consumed by a conditional update so concurrent
  use has exactly one winner.
- TOTP secrets are written with AES-256-GCM. Values written by earlier versions
  used AES-256-CBC and remain readable.

### Changed

- `POST /auth/login` and `POST /auth/token-login` return `401` with
  `code: "MFA_REQUIRED"` and a challenge when MFA is required. See
  [MIGRATION-1.8.md](docs/MIGRATION-1.8.md).
- The undocumented `totp_code` field on the login endpoints is removed and
  ignored.
- `POST /auth/totp/backup` now regenerates backup codes and requires a current
  TOTP code. `POST /auth/totp/backup/verify` consumes a backup code.
- `POST /auth/totp/verify` additionally reports `sessionsRevoked`.
- WebAuthn assertions satisfy MFA on their own. Magic links refuse to downgrade a
  TOTP-protected account, and SAML, enterprise OIDC, federation, and OAuth2
  report a typed `mfa_required` error.
- OAuth2 authorization codes carry the MFA factor of the session that approved
  them, so the token exchange cannot launder an unverified login.
- Access tokens for MFA sessions carry `mfa_verified`, `mfa_factor`, and `amr`.
- Factor management requires step-up: `/auth/totp/enroll`, `/auth/totp/verify`,
  `/auth/totp/backup`, `/auth/totp/disable`, and passkey registration for a
  TOTP-protected account all require the account password in addition to the
  session.
- A passkey registered after TOTP was enabled is treated as a single factor and
  cannot be used to sign in on its own.
- Disabling TOTP deletes its backup codes.
- Failed MFA factor attempts count toward the account lockout.
- `SDK.authentication.login()` returns a discriminated union; `completeMfa()` is
  new.

### Fixed

- `/auth/mfa/verify` wrote session cookies under a name derived from the login
  flow instead of the client id, so MFA-completed sessions were not readable by
  the auth plugin and every application on the cookie domain shared one name.
- The MFA step no longer accepted accounts that are deactivated, under review,
  or locked out, which the password step already refused.
- Repeated password steps no longer cancel an MFA challenge created moments
  earlier.
- `MFA_CHALLENGE_TTL_SECONDS`, `MFA_MAX_ATTEMPTS`, and
  `TOTP_BACKUP_CODE_TTL_SECONDS` are validated at startup and fall back to their
  defaults instead of silently breaking every login.
- The MFA factor copied out of a verified token into the authorization-code
  table is validated against the column's check constraint.
- SAML now reports `mfa_required` for MFA-protected accounts instead of
  collapsing the failure into a generic validation error.

### Added

- `mfa_challenges` table, `MfaChallengeRepository`, and `MfaService`.
- `MFA_CHALLENGE_TTL_SECONDS`, `MFA_MAX_ATTEMPTS`, and
  `TOTP_BACKUP_CODE_TTL_SECONDS` configuration.
- Audit events `mfa_challenge_created`, `mfa_challenge_failed`,
  `mfa_challenge_expired`, `mfa_challenge_rejected`, `mfa_verified`,
  `mfa_bypass_blocked`, and `mfa_backup_code_regenerated`.
- Dedicated rate limits for MFA verification and every TOTP management endpoint.
- MFA challenge step in the admin dashboard login form.
- `docs/MIGRATION-1.8.md`.
- MFA security regression suite (`src/tests/security/mfa.test.ts`).

## [1.7.0] - 2026-09-24

### Added

- Dedicated owner-only platform-role endpoint at `PATCH /v1/admin/platform/users/:userId/role`.
- Centralized platform and organization authorization guards with explicit organization context.
- Versioned audit events for platform-role, membership, permission, and denied-authorization transitions.
- Dedicated authorization regression suite covering privilege escalation, tenant isolation, workflow safety, secret disclosure, and audit metadata.
- RBAC and authorization-boundary documentation.

### Changed

- Platform roles are explicitly limited to `owner` and `user`.
- Organization roles are explicitly limited to `owner`, `admin`, and `member`.
- Authorization checks now require an explicit `organizationId`.
- Frontend administration clients use the dedicated platform-role endpoint and safe workflow definitions.
- SAML metadata lookups require both connection and organization identifiers.

### Fixed

- Organization user routes can no longer mutate global users or deactivate shared accounts.
- Generic profile and in-process identity contracts can no longer carry a platform role.
- Organization admins cannot promote themselves or other members to organization owner.
- The sole organization owner cannot be demoted or removed.
- Tenant workflows now use a closed safe-step allowlist; plugin aliases, arbitrary webhooks, organization creation, and authorization-mutating steps fail closed.
- Global workflows require platform-owner access, and workflow execution rechecks organization membership.
- Organization creation always assigns an owner; actorless global deactivation APIs were removed from the organization domain.
- Last-owner transitions use database row locks to prevent concurrent demotion/removal.
- Platform-user deactivation now disables login, invalidates existing sessions, revokes refresh tokens and user API keys, and preserves the last active owner invariant.
- User-management responses redact application secret hashes, OIDC/API-key credentials, configuration values, password hashes, TOTP secrets, and metadata.
- SAML/OIDC public lookups require an organization context; new OIDC client secrets are encrypted at rest, and legacy plaintext values are re-encrypted on first callback use.
- OAuth/OIDC client context no longer places an organization claim in a user token unless the user is a member of that application's organization.
- Failed authorization attempts and role transitions now produce structured audit evidence.
- SAML schema validation now has a signed-response regression test and audience/destination/recipient checks, alongside one-time transaction claiming and OIDC ID-token/JWKS verification.
- Enterprise SSO requires an explicit connection/subject identity link and rejects platform-owner tenant login; generic OAuth no longer auto-links by email.
- SCIM is scoped to `SCIM_ORG_ID`, cannot re-enable quarantined or platform-owner accounts, attributes audits to the SCIM credential, and deactivates rather than deleting users.
- OIDC endpoint checks cover private, carrier-grade, benchmarking, dotted/hex IPv4-mapped, DNS-pinned, and redirecting targets.
- Legacy account migration quarantines ambiguous unverified rows instead of activating them.
- SAML semantic validation and OIDC/JWKS checks are covered by signed-response tests; OAuth2 refresh success and failure emit audit events.
- Refresh-token rotation and OAuth authorization-code consumption are atomic and client-bound.
- Legacy unverified accounts are quarantined for explicit review during the deactivation migration.
- OIDC endpoint configuration blocks private/redirected targets by default; SCIM reflects account deactivation.
- Added a blocking `oxlint` gate with warnings denied; CI now runs lint separately from typecheck.
- Pinned safe transitive versions for `@xmldom/xmldom`, `fast-uri`, and `find-my-way`; the High-severity production audit gate now passes.
- API-key validation uses public user projections and emits `api_key_used` audit events; the compiled OIDC re-encryption helper closes its database pool before exit.

### Security

- Critical organization-admin-to-platform-owner escalation paths are closed at HTTP, application, domain, SDK, and repository boundaries.
- Cross-tenant authorization context is resolved from authenticated database membership rather than client-controlled application context.
- Workflow definitions that are malformed or contain blocked authorization steps fail closed.

### Breaking Changes

- Organization user PATCH/DELETE endpoints no longer mutate global accounts; they return a migration response. Use platform user administration or organization member endpoints.
- `/v1/authz/check` requests must include `organizationId`.
- Custom organization role names are no longer accepted; only `owner`, `admin`, and `member` are supported.
- Public SAML/OIDC initiation and metadata URLs require `organizationId`.
- Direct authorization SDK calls now require both actor and organization IDs.
- OIDC connections require a JWKS URI; OAuth2 application-bound refresh requests must provide the bound `client_id` and `client_secret`.
- SCIM requires both `SCIM_BEARER_TOKEN` and `SCIM_ORG_ID`, and operates only within that organization.
- Legacy unverified accounts may be marked `account_review_required` and require explicit review.
- Tenant workflow definitions containing authorization-mutating, plugin, organization-creation, or arbitrary webhook steps are rejected or blocked.

### Migration

- Move platform role changes to `PATCH /v1/admin/platform/users/:userId/role`.
- Use `/v1/admin/organizations/:id/members/:userId` for organization role changes.
- Remove unsafe workflow steps before deployment.
- Update SAML/OIDC URLs to include the organization ID.
- Update authorization-check clients to send the organization ID explicitly.

### Dependencies

- No dependency changes in this release. Existing dependency audit findings remain tracked for the planned supply-chain phase.

### Testing

- Backend typecheck and build pass.
- Backend test suite passes with the security regression suite enabled.
- Frontend production build passes.

## [1.1.0] - 2026-09-19

Security hardening, architecture improvements, and enterprise SSO enhancements.

### Added

- **SCIM provisioning** — User and group provisioning endpoints (`/scim/v2/Users`, `/scim/v2/Groups`) for identity provider integration.
- **Enterprise SSO** — SAML 2.0 and OIDC enterprise connectors with SCIM user provisioning.
- **mTLS support** — Service account resolution via client certificate headers.
- **Comprehensive audit logging** — All authentication events (register, login, logout, refresh) and state-changing operations now emit audit events.
- **Rate limiting** — Added to 8 sensitive endpoints: password reset, magic links, email verification, SMS OTP send/verify, and organization creation.
- **Owner-only access** — Configuration and permission management endpoints restricted to platform owner.
- **Organization membership checks** — Workflow operations now verify org membership.
- **XML injection prevention** — SAML metadata generation now escapes dynamic values.
- **Cryptographic nonces** — Rate limiter uses `crypto.randomBytes()` instead of `Math.random()`.
- **Shared helpers** — `sendResultError` and `escapeXml` utilities for consistent error handling and XML safety.

### Changed

- **Admin routes split** — Monolithic `admin.ts` (1071 lines) refactored into 7 focused modules under `src/routes/admin/` (platform, organizations, permissions, sso, billing, webhooks, helpers).
- **Repository pattern enforced** — 9 route files updated to use DI container repositories instead of direct database access.
- **Dynamic imports eliminated** — 15+ `await import()` workarounds converted to static imports across 10 files.
- **Permission endpoints** — Now require owner-only access (was any authenticated user).
- **Workflow endpoints** — Now require organization membership (was any authenticated user).
- **Config endpoints** — Now require owner-only access (was any authenticated user).

### Fixed

- **Critical runtime crash** — Missing `cache` import in `src/index.ts` causing shutdown failures.
- **Import ordering bug** — `sessions.ts` using `config` and `hashToken` before import declaration.
- **Missing dependency** — Added `fastify-plugin` as explicit dependency.
- **Redundant dynamic imports** — Removed 2 unnecessary `await import("jose")` calls in `tokens.ts`.
- **Duplicate code** — Consolidated 3 duplicate `sendResultError` functions to shared helper.
- **Unused imports** — Cleaned up across 8+ files.

### Security

- **Rate limiting** — 8 endpoints protected against abuse (password reset, magic links, email verification, SMS OTP, org creation).
- **Authorization hardening** — 16 endpoints updated with proper owner/role/org membership checks.
- **XML injection prevention** — SAML metadata generation escaped in 2 files.
- **Cryptographic security** — Rate limiter nonce generation uses secure random bytes.
- **Information leak removal** — Queue class name no longer exposed in API response.
- **Input validation** — All route inputs validated with Zod schemas.

## [1.2.0] - 2026-09-20

Dependency updates — safe patches and minor versions.

### Changed

- **fastify** 5.10.0 → latest 5.x
- **@fastify/swagger** 9.8.0 → latest 9.x
- **argon2** 0.44.0 → latest 0.x
- **otpauth** 9.5.1 → latest 9.x
- **@opentelemetry/sdk-node** 0.220.0 → latest 0.x
- **@opentelemetry/auto-instrumentations-node** 0.78.0 → latest 0.x
- **autoprefixer** 10.5.2 → latest 10.x (frontend)
- **postcss** 8.5.19 → latest 8.x (frontend)
- **lucide-react** 1.24.0 → latest 1.x (frontend)
- **@playwright/test** 1.61.1 → latest 1.x (frontend)

## [1.3.0] - 2026-09-20

Core tooling upgrades — TypeScript 7, Zod 4, Drizzle latest, Commander 15, Dotenv 18.

### Changed

- **TypeScript** 5.9.3 → 7.0.2 — new major version with stricter type checking.
- **Zod** 3.25.76 → 4.6.5 — API redesign: `z.record()` now requires explicit key type. Updated 7 call sites across 6 route files.
- **Drizzle ORM** 0.31.4 → 0.45.2
- **Drizzle Kit** 0.22.8 → 0.31.10
- **Commander** 12.1.0 → 15.0.0
- **Dotenv** 16.6.1 → 18.0.1

### Fixed

- **Zod 4 migration** — Updated all `z.record()` calls to include explicit `z.string()` key type parameter (sso.ts, auth.ts, config.ts, profile.ts, setup.ts, webauthn.ts, workflows.ts).

## [1.4.0] - 2026-09-20

Fastify ecosystem upgrades — all plugins updated to latest major versions.

### Changed

- **fastify-plugin** 5.1.0 → 6.0.0
- **@fastify/cookie** 10.0.1 → 11.1.2
- **@fastify/cors** 10.1.0 → 11.3.0
- **@fastify/static** 8.3.0 → 10.1.4
- **@fastify/swagger-ui** 5.2.6 → 6.1.1

## [1.5.0] - 2026-09-20

Auth & infrastructure upgrades — jose 6, ioredis 6, bullmq 6, simplewebauthn 14, nodemailer 10.

### Changed

- **jose** 5.10.0 → 6.2.12 — `KeyLike` type removed, replaced with `CryptoKey`.
- **ioredis** 5.11.1 → 6.0.0
- **bullmq** 5.80.2 → 6.3.8
- **@simplewebauthn/server** 13.3.2 → 14.0.2 — `AuthenticatorTransportFuture` renamed to `AuthenticatorTransport`.
- **nodemailer** 9.0.3 → 10.0.10

### Fixed

- **jose 6 migration** — Replaced `KeyLike` with `CryptoKey` in secrets provider, tokens service, and database/environment secrets providers.
- **simplewebauthn 14 migration** — Renamed `AuthenticatorTransportFuture` to `AuthenticatorTransport` in webauthn service.

## [1.6.0] - 2026-09-20

Frontend upgrades — React 19, Vite 8, Tailwind 4, TypeScript 7.

### Changed

- **React** 18.3.1 → 19.3.0
- **React DOM** 18.3.1 → 19.3.0
- **Vite** 5.4.21 → 8.3.0
- **@vitejs/plugin-react** 4.7.0 → 6.1.1
- **Tailwind CSS** 3.4.19 → 4.3.3 — complete rewrite: config moved from JS to CSS `@theme` directive, PostCSS plugin replaced with `@tailwindcss/vite`.
- **@simplewebauthn/browser** 13.3.0 → 14.0.0
- **TypeScript** 5.9.3 → 7.0.2 (frontend)
- **@types/react** 18.3.31 → 19.0.0
- **@types/react-dom** 18.3.7 → 19.0.0

### Removed

- **autoprefixer** — not needed with Tailwind 4.
- **postcss** — not needed with Tailwind 4.
- **tailwindcss-animate** — animations built into Tailwind 4.

### Added

- **@tailwindcss/vite** — replaces PostCSS plugin approach.

### Migration notes

- `tailwind.config.js` deleted — config now lives in `src/tailwind.css` using `@theme` directive.
- `postcss.config.js` deleted — Tailwind 4 uses Vite plugin directly.
- `src/index.css` updated to use `@import "./tailwind.css"` instead of `@tailwind base/components/utilities`.

[1.7.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.7.0
[1.6.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.6.0
[1.5.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.5.0
[1.4.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.4.0
[1.3.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.3.0
[1.2.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.2.0
[1.1.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.1.0
[1.0.0]: https://github.com/Hilbras/Keystone/releases/tag/v1.0.0
