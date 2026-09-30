#!/usr/bin/env node
/**
 * Review every registered route against the properties the plan requires.
 *
 * The plan asks for an API security review covering authentication,
 * authorization, tenant isolation, input validation, output filtering, rate
 * limiting, audit logging, error handling and sensitive data exposure. Written
 * as prose, such a review is an opinion. Enumerated from the source, each route
 * either has a guard or does not, and a route added without one shows up as a
 * diff rather than as an oversight nobody noticed.
 *
 * This **reports**; it does not fail. A public route legitimately has no
 * authentication and a read legitimately has no rate limit, so the judgement
 * about which combinations are correct belongs to whoever reads the output. What
 * the script removes is the risk of a review that quietly misses a route.
 *
 * Usage: node scripts/review-api-surface.mjs [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");
const strict = process.argv.includes("--strict");

/**
 * Guard names that may appear in a route's `preHandler`.
 *
 * The point of the list is the typo. A guard is a call — `app.authenticate`,
 * `requirePlatformRole("owner")`, `scimRateLimit` — and a misspelling of one is
 * not a compile error: Fastify evaluates `preHandler: [app.authentcate]` to
 * `undefined` and skips it, so the route ships with no authentication and every
 * test that does not happen to call it still passes. That is the failure mode
 * this list exists to make impossible, and it is why the check below is on the
 * *name* rather than on whether the route happens to be authenticated — a
 * misspelled guard still shows up as "authenticated" if something else in the
 * file also guards it.
 *
 * Split into two kinds because they fail differently: a decorated name is looked
 * up on `app` at request time, and a helper is imported at module load, so only
 * the first can be checked by reading the source alone.
 */
const APP_GUARDS = new Set([
  "authenticate",
  "authenticateOrApiKey",
  "requireScopes",
  "requirePermission",
  "requireMTLS",
  "requireHumanPrincipal",
]);

const HELPER_GUARDS = new Set([
  "requirePlatformRole",
  "requireOrganizationRole",
  "requireAuthAndRole",
  "requireOwner",
  "rateLimit",
  "scimRateLimit",
  "globalRateLimit",
  "appContext",
]);

/** Identifiers that appear in a `preHandler` list but are not guards. */
const NOT_GUARDS = new Set([
  "app", "request", "reply", "owner", "admin", "member", "user", "service_account",
  "read", "write", "create", "update", "delete", "manage", "revoke", "preHandler",
  "options", "config", "true", "false",
]);
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
};

/**
 * The prefix each route module is mounted at, derived by walking the register graph.
 *
 * Without this, `/login` in `auth.ts` is indistinguishable from a genuinely
 * unauthenticated `/login` and every such route reads as a finding. A review tool with
 * fifty false positives gets ignored, which makes it worse than none.
 *
 * Derived rather than tabulated so a route added under a new prefix is covered without
 * editing this file — a hand-kept list is one more thing to forget.
 *
 * ## Why this walks rather than greps (SEC-064)
 *
 * The first version read `src/index.ts` once and matched `import <name> from
 * "./routes/<file>.js"` against `register(<name>, { prefix })`. That resolves one hop,
 * and **eight of twenty-five route files have more than one hop** — so a quarter of the
 * API surface was not analysed at all, and the report said "79 routes across 22 files"
 * without saying which eight it had skipped.
 *
 * Two shapes defeated it, and both are ordinary:
 *
 * 1. **Composition.** `admin/platform.ts`, `organizations.ts`, `permissions.ts`,
 *    `sso.ts`, `webhooks.ts` and `billing.ts` are imported by `routes/admin/index.ts`,
 *    which `src/index.ts` imports as one module and registers once at `/v1/admin`. The
 *    sub-files appear in no `register(` call in `src/index.ts` at all.
 * 2. **A register with no options object.** `health.ts` is registered as
 *    `app.register(healthRoutes)` — no second argument. The pattern required
 *    `{ prefix: … }`, so a plugin mounted at the root matched nothing and was recorded
 *    as unresolved rather than as prefix `""`.
 *
 * Neither is exotic, and both produced the same outcome: a file silently outside the
 * review. So this walks. Each module's effective prefix is its parent's plus its own,
 * and a module that registers sub-plugins passes that prefix down — which is exactly
 * how Fastify composes them, so the walk and the runtime agree by construction rather
 * than by coincidence.
 *
 * {@link MOUNTED_VIA} records the chain for each file, because "unresolved" and
 * "resolved to the wrong thing" should be distinguishable, and a prefix with no
 * recorded derivation is a claim with nothing behind it.
 */
function mountPrefixByFile() {
  const map = new Map();
  const via = new Map();
  const seen = new Set();

  const join = (parent, own) => {
    if (!own) return parent;
    if (!parent) return own;
    return `${parent}/${own}`.replace(/\/+/g, "/");
  };

  const visit = (file, parentPrefix, chain) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = read(file);

    // `register(name, { prefix: "…" })` and `register(name)` — the second form mounts
    // at the parent's prefix, which is the root for a top-level plugin.
    //
    // The options object is matched as a whole (`\{[^}]*\}`) rather than as
    // `prefix: …` followed by `)`, because a register call may carry other options
    // and the closing brace is not the next character after the prefix. The first
    // version of this walk required that, and it matched **10 of 31** files instead of
    // 25: every plugin with a real options object failed to match, so the tool
    // reported most of the API surface as unplaceable while appearing to work.
    const own = new Map();
    for (const m of source.matchAll(
      /register\(\s*(\w+)\s*(?:,\s*\{([^}]*)\})?\s*\)/g
    )) {
      const options = m[2] ?? "";
      const declared = /prefix:\s*"([^"]*)"/.exec(options)?.[1] ?? "";
      own.set(m[1], declared === "" ? "" : declared.replace(/\/$/, ""));
    }
    // Imports in this module, so a registered name can be traced to its file.
    const imports = new Map();
    for (const m of source.matchAll(/import\s+(\w+)\s+from\s+"(\.[^"]+)\.js"/g)) {
      imports.set(m[1], resolveSpecifier(file, m[2]));
    }
    // **Re-export barrels.** `src/routes/admin.ts` is one line —
    // `export { default } from "./admin/index.js";` — with no `register(` and no named
    // import, so a walk that only follows imports stops there and the seven admin
    // files stay invisible. The barrel is not a dead end: it forwards its default
    // export, so the module registered under the parent's name *is* the module the
    // barrel forwards to. Following that is the difference between analysing the
    // platform and organization administration routes and analysing neither.
    //
    // Named re-exports are not followed, because which name would carry the mount
    // point is a question with no general answer — and a guess here would put routes
    // at a prefix the runtime does not serve, which is worse than reporting the file
    // as unplaceable.
    const barrels = [...source.matchAll(/export\s*\{\s*default\s*\}\s*from\s+"(\.[^"]+)\.js"/g)].map(
      (m) => resolveSpecifier(file, m[1])
    );

    for (const [name, declared] of own) {
      const target = imports.get(name);
      if (!target) continue;
      const effective = join(parentPrefix, declared);
      map.set(target, effective);
      via.set(target, [...chain, `${file} → ${name}${declared ? ` @ "${declared}"` : " (no prefix)"}`]);
      // Recurse: a composed module registers plugins that inherit this prefix.
      visit(target, effective, [...chain, target]);
    }

    // A barrel inherits the prefix it was reached at, and forwards to the module whose
    // default export it re-exports.
    for (const target of barrels) {
      map.set(target, parentPrefix);
      via.set(target, [...chain, `${file} → re-exports default from ${target}`]);
      visit(target, parentPrefix, [...chain, target]);
    }
  };

  visit("src/index.ts", "", []);
  return { map, via };
}
const { map: MOUNT, via: MOUNTED_VIA } = mountPrefixByFile();

function resolveSpecifier(fromFile, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (fs.existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

// `requirePlatformRole` and `requireOwner` authenticate *and* then check a role,
// so they satisfy both columns. Leaving them out of AUTH reported owner-only
// configuration routes as having no authentication guard at all — the tool
// accusing the most strongly guarded routes in the codebase of being open.
const AUTH = [
  /app\.authenticate/,
  /authenticateOrApiKey/,
  /requireAuthAndRole/,
  /requirePlatformRole/,
  /requireOwner/,
  /requireOrganizationRole/,
  // `assertSetupToken(request, reply)` guards every /setup route except /status. It is
  // called in the handler body rather than in a preHandler, which is the right shape
  // for a guard that has to answer with a body — and which is why the tool reported
  // eleven unauthenticated setup routes, including `/setup/init`, the one that
  // creates the first owner.
  //
  // Recorded as a guard rather than as eleven PUBLIC_BY_DESIGN entries: the entries
  // would each restate a fact the guard already carries, and eleven copies of a fact
  // is eleven things to forget.
  /assertSetupToken/,
  // `app.requirePermission(resource, action)` authenticates and then checks a
  // scoped permission, so it satisfies both columns.
  /app\.requirePermission/,
];
const AUTHORIZATION = [
  /requireOrganizationRole/,
  /requirePlatformRole/,
  /requireOwner/,
  /app\.requirePermission/,
  /requireScopes/,
  /requireHumanPrincipal/,
  /requireSso(Reader|Manager|Owner)/,
];
// `factorRateLimit("totp-enroll")` builds a limiter through a local factory, so
// matching the bare `rateLimit(` would report five TOTP routes as unlimited when
// every one of them is limited.
const RATE_LIMIT = [/rateLimit\(/, /globalRateLimit/, /factorRateLimit\(/];
const AUDIT = [/request\.audit\(/, /await audit\(/];

/**
 * Routes that are public by design, with the reason.
 *
 * "It was already like that" is how an endpoint ends up unauthenticated by
 * accident, so each entry states why. Adding a path here is a claim, and the
 * claim is what gets reviewed.
 */
const PUBLIC_BY_DESIGN = new Map([
  ["/auth/register", "self-service signup"],
  ["/auth/login", "self-service login"],
  ["/auth/token-login", "self-service login"],
  ["/auth/mfa/verify", "authenticated by the opaque challenge alone; no token exists yet"],
  ["/auth/refresh", "authenticated by the refresh token it presents"],
  ["/auth/forgot-password", "must be reachable without an account"],
  ["/auth/reset-password", "authenticated by the reset token"],
  ["/auth/magic-link/send", "must be reachable without an account"],
  ["/auth/magic-link/verify", "authenticated by the emailed token"],
  ["/auth/email-verification/request", "takes an address and mails a link; rate limited to 3/15min and answers 200 for unknown or already-verified addresses, so it neither enumerates users nor mails"],
  ["/auth/email-verification/verify", "authenticated by the emailed token"],
  ["/auth/sms-otp/send", "must be reachable without an account"],
  ["/auth/sms-otp/verify", "authenticated by the SMS code"],
  ["/auth/oauth/:provider", "federation initiation"],
  ["/oauth2/token", "the client authenticates in the request"],
  // **These three keys named paths the server does not serve**, so the reasons
  // were inert — `PUBLIC_BY_DESIGN.get(url)` returned undefined for the routes they
  // were written about, and `--strict` reported those routes as unguarded. Caught
  // only because adding a `preHandler` array made the routes visible to the
  // parser at all; before that they were not flagged and nobody knew the entries
  // were doing nothing.
  //
  //   "/sso/saml/login"                      -> no such route; the real one is below
  //   "/sso/saml/metadata/:connectionId"     -> the real path is /sso/saml/:connectionId/metadata
  //   "/sso/oidc/callback"                   -> the real path is /sso/sso/oidc/:connectionId/callback
  //                                             (a plugin at /sso whose routes also begin /sso — SEC-062)
  ["/sso/saml/:connectionId", "IdP-initiated SSO start; the user has no session yet, which is the point of it"],
  ["/sso/saml/acs", "SAML assertion consumer, authenticated by the signed assertion"],
  ["/sso/saml/:connectionId/metadata", "IdP metadata fetch; a document, and it leaks nothing that is not already in the SAML metadata"],
  ["/sso/sso/oidc/:connectionId/callback", "OIDC callback, authenticated by the state cookie and the code the IdP returns"],
  ["/federation/:provider/callback", "federation callback; the provider token and the state cookie are the authentication"],
  ["/auth/callback/:provider", "as above, the other federation callback"],
  ["/auth/webauthn/authenticate/options", "mints a challenge for a user who is not yet authenticated — that is what makes a WebAuthn login work"],
  ["/auth/webauthn/authenticate/verify", "completes a WebAuthn login, authenticated by the single-use challenge this route issued"],
  // There is deliberately **no** `/setup` entry. The setup plugin is mounted at
  // `/setup` and serves `/setup/status`, `/setup/init` and the validators — there is
  // no `/setup` route, so an entry naming it was inert. The routes that do exist are
  // authenticated by `assertSetupToken`, which the tool recognises separately.
  // **Added in 3.5.6, when the tool began seeing these routes at all.** Before that
  // the parser never reached `src/routes/admin/**`, and these eight were not in the
  // report in either direction — they were simply absent, so nothing recorded why they
  // are public. Each reason below was read out of the route, not assumed.
  ["/auth/logout", "revocation by possession: the caller proves themselves by presenting the token being revoked, and revoking a token they do not hold is a no-op"],
  ["/federation/:provider/start", "federation initiation; the user has no session yet, which is the point of it"],
  ["/federation/providers", "returns the NAMES of configured providers, so a login page can render its buttons; no client ids, no credentials"],
  ["/sso/sso/oidc/:connectionId", "IdP-initiated OIDC start; unauthenticated by necessity, and rate limited"],
  ["/sdk/keystone-dropin.js", "a static file a browser and a CDN fetch; limiting it breaks caching and protects nothing"],
  ["/sdk/keystone-dropin.js.sri", "the integrity hash of that static file, same reasoning"],
  ["/sdk/branding/:clientId", "logo and colour scheme for the login page, Cache-Control public for 5 minutes; an application that does not exist answers 404"],
  ["/setup/status", "returns two booleans — whether setup is needed, and whether a setup token is configured. It does not return the token"],
  ["/health", "liveness probe"],
  ["/ready", "readiness probe"],
]);

/** SCIM authenticates with a bearer token of its own; see the route's preHandler. */
const SCIM = /^\/scim\//;

/**
 * Route files that authenticate in a plugin-scoped `addHook("onRequest")` rather
 * than a per-route preHandler. SCIM does this, so every route inherits it and a
 * per-route check would report all eighteen as unauthenticated.
 */
function hookAuthenticatedFiles() {
  const out = new Set();
  for (const f of fs.readdirSync(path.join(root, "src/routes"))) {
    const rel = `src/routes/${f}`;
    if (f.endsWith(".ts") && /addHook\("onRequest"/.test(read(rel))) out.add(rel);
  }
  return out;
}
const HOOK_AUTH = hookAuthenticatedFiles();

/**
 * Local guard aliases: `const requireSsoReader = requireOrganizationRole(…)`.
 *
 * `src/routes/admin/sso.ts` builds three guards this way and uses the **aliases** in
 * every `preHandler`. The tool recognised the call that defines them and not the names
 * that use them, so it reported ten SSO and SCIM administration routes as
 * "no authentication guard" — routes guarded by an owner-or-admin check.
 *
 * Tabulating the three names would have been the wrong fix twice over: it would need
 * editing whenever a guard is renamed, and it would leave a name in a list that a
 * reader assumes was verified. So the aliases are **derived** — any local bound
 * directly to a known guard counts — which is the same rule a reader applies and
 * needs no maintenance.
 *
 * The binding is restricted to a direct call so that a local named `x` assigned from
 * something *involving* a guard (`requireRole(a) || publicRoute`) is not silently
 * treated as a guard. That would be a false negative, which is worse than a false
 * positive here: a false positive sends someone to read the code, and a false negative
 * retires a finding.
 */
function localGuardAliases(source) {
  const known = /require(AuthAndRole|PlatformRole|Owner|OrganizationRole|Scopes)|app\.(authenticate|requirePermission)|authenticateOrApiKey/;
  const out = [];
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*([A-Za-z_][\w.]*)\s*\(/g)) {
    if (known.test(m[2])) out.push(new RegExp(`\\b${m[1]}\\b`));
  }
  return out;
}

const routeFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    // **The label comes from the current directory, not the top-level one.** The
    // first version wrote `path.join("src/routes", entry.name)`, so recursing into
    // `admin/` produced `src/routes/platform.ts` for `src/routes/admin/platform.ts` —
    // a path that does not exist. `read()` returns "" for a missing file rather than
    // throwing, so every route in a subdirectory was reported as zero routes, and
    // nothing anywhere said the file could not be read.
    //
    // This is the root cause of SEC-064, and it is why the report read "79 routes
    // across 22 files" while the repository declares far more. The prefix walk could
    // not have fixed it: `MOUNT` held correctly-named `admin/` entries that no
    // `routeFiles` entry could match, which is why the resolved count read
    // **40 of 31** — more resolved files than exist.
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel);
    else if (entry.name.endsWith(".ts") && entry.name !== "helpers.ts") routeFiles.push(rel);
  }
})("src/routes");

// Placed after the walker, because it reports on `routeFiles` — the first version
// of this block sat beside the prefix walk, above the walker's declaration, and
// exited 1 on an empty report because the array did not exist yet.
/**
 * `--explain` — where each prefix came from.
 *
 * `MOUNTED_VIA` exists because a prefix with no recorded derivation is a claim with
 * nothing behind it, and the walk that produces them is three hops deep for the admin
 * tree: `src/index.ts` → `routes/admin.ts` (a barrel) → `routes/admin/index.ts` →
 * seven files. When that is wrong the symptom is routes at a URL the server does not
 * serve, and the chain is what makes that diagnosable without re-deriving it by hand.
 *
 * It was built for this and left unused, which oxlint correctly reported as a dead
 * variable — a check that is written and not used is the same shape as a check that is
 * not written.
 */
if (process.argv.includes("--explain")) {
  const files = routeFiles.filter((f) => MOUNT.has(f));
  for (const file of files.sort()) {
    const chain = MOUNTED_VIA.get(file) ?? [];
    console.log(`  ${(MOUNT.get(file) || "").padEnd(14)} ${file}`);
    for (const step of chain) console.log(`                 ${step}`);
  }
  const missing = routeFiles.filter((f) => !MOUNT.has(f));
  console.log(`\n  ${files.length}/${routeFiles.length} route files placed.`);
  for (const file of missing) {
    console.log(`  UNPLACED  ${file} — reached from no register() call in the graph`);
  }
  process.exit(missing.length === 0 ? 0 : 1);
}

/**
 * Resolve an import specifier to a source file.
 *
 * `./routes/admin.js` names a real file (`src/routes/admin.ts`), but a barrel's
 * `./admin/index.js` names a path that only exists as a file once `.ts` replaces
 * `.js`. This returns whichever exists, and `null` for neither — a null is what makes
 * a file report itself unplaceable rather than being placed at a guessed path.
 */

const routes = [];
/** `PUBLIC_BY_DESIGN` keys that match no route. See the check below. */
const publicKeyMisses = [];
/** Keys whose route exists in a file the parser could not place. */
const unverifiedReasons = [];
/**
 * Find every `app.<method>("path", …)` in a source file, with its options object.
 *
 * ## Why this is not one regex (SEC-064)
 *
 * The first version was:
 *
 *     app\.(get|post|put|patch|delete)\(\s*("|`)([^"`]+)\2\s*,\s*(\{[\s\S]*?\}\s*)?,
 *
 * Note the trailing comma. It requires **two** commas — one after the path and one
 * after an optional options object — so it matched only the long form:
 *
 *     app.get("/platform/users", { preHandler: [...] }, async (request, reply) => {
 *
 * and silently skipped the short one, which is the other completely ordinary way to
 * write a route and is what most of `admin/*.ts` uses:
 *
 *     app.get("/platform/users", async (request, reply) => {
 *
 * The consequence: **76 routes across eight files were never parsed at all.** The
 * report said "79 routes across 22 files", did not enumerate the other nine, and gave
 * no hint that the reason was a parser that only understood one calling convention.
 * Those 76 routes have never been checked for an authentication guard, a rate limit or
 * audit logging — and the platform-owner administration surface is exactly where that
 * matters most.
 *
 * The two forms are not reliably distinguishable by a single pattern, because whether
 * an options object is present depends on what the *next* token is. So the path is
 * found with a small pattern and the options are read forward with brace depth, which
 * is how a reader does it too. String literals are skipped so a `}` or a brace inside
 * one cannot move the depth.
 */
function findRoutes(source) {
  const found = [];
  const head = /app\.(get|post|put|patch|delete)\(\s*(?:"|`)([^"`]+)(?:"|`)/g;
  const matches = [...source.matchAll(head)];
  for (const [n, m] of matches.entries()) {
    let i = m.index + m[0].length;
    // Skip to the comma that separates the path from what follows.
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== ",") continue;
    i++;
    while (i < source.length && /\s/.test(source[i])) i++;
    let opts = "";
    if (source[i] === "{") {
      const start = i;
      let depth = 0;
      let quote = null;
      for (; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
          if (ch === "\\") i++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      opts = source.slice(start, i);
    }
    // **The whole declaration, not just the options.** Some guards are called in the
    // handler body rather than in a preHandler — `if (!assertSetupToken(request, reply))
    // return;` on every /setup route except /status — which is the right shape for a
    // guard that has to answer with a body. Testing only the options object reports
    // those eleven routes as unauthenticated, including `/setup/init`, which creates
    // the first owner.
    //
    // The block runs to the start of the next route declaration, so it contains the
    // options and the handler and nothing else. That is the same unit a reader uses.
    const end = n + 1 < matches.length ? matches[n + 1].index : source.length;
    const block = source.slice(m.index, end);
    found.push({ method: m[1], url: m[2], opts, block });
  }
  return found;
}

for (const file of routeFiles) {
  const source = read(file);
  const prefix = MOUNT.get(file) ?? null;
  const fileAudits = AUDIT.some((r) => r.test(source));
  const aliases = localGuardAliases(source);
  for (const { method, url, opts, block } of findRoutes(source)) {
    const full = ((prefix === null ? url : `${prefix}${url}`).replace(/\/+$/, "")) || "/";
    // A guard counts anywhere in the route's own declaration — options or handler.
    // `rateLimit` is deliberately *not* widened this way: it must be a preHandler
    // entry, and a `rateLimit(` call inside a handler body would be something else.
    const guarded = (list) => list.some((r) => r.test(opts) || r.test(block));
    routes.push({
      file,
      method: method.toUpperCase(),
      url: full,
      auth: guarded(AUTH) || aliases.some((r) => r.test(block)) || SCIM.test(full) || HOOK_AUTH.has(file),
      authorization: guarded(AUTHORIZATION) || aliases.some((r) => r.test(block)),
      rateLimit: RATE_LIMIT.some((r) => r.test(opts)),
      audit: fileAudits,
    });
  }
}

const concerns = [];
for (const r of routes) {
  const publicReason = PUBLIC_BY_DESIGN.get(r.url);
  const problems = [];
  if (!r.auth && !publicReason) problems.push("no authentication guard");
  if (r.auth && !r.authorization) problems.push("authenticated, no authorization guard");
  if (!r.rateLimit && r.method !== "GET" && !publicReason) problems.push("state-changing, no rate limit");
  if (problems.length) concerns.push({ ...r, publicReason: publicReason ?? null, problems });
}

/**
 * Split a `preHandler` array body into its top-level elements.
 *
 * Depth-aware on purpose. The obvious `body.split(",")` reports every property of
 * every options object as if it were an element — so `rateLimit({ maxAttempts:
 * config.LOGIN_MAX_ATTEMPTS, ... })` yields `config.LOGIN_MAX_ATTEMPTS` as a
 * candidate guard, and the check reports 40 problems that are all artefacts of
 * the splitting. A gate that cries wolf is disabled, so the first version of this
 * was wrong twice: once by scanning string literals, and once by not tracking
 * depth.
 */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      // Skip the whole literal, backslash escapes included, so a comma or a brace
      // inside a string or a regex cannot move the depth.
      current += ch;
      if (ch === "\\") {
        current += body[++i] ?? "";
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Remove line and block comments, so a guard named only in a comment is not counted. */
function stripComments(text) {
  return text
    .replace(/\/\*\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/**
 * The mechanically decidable problems, which are the ones `--strict` fails on.
 *
 * Deliberately narrower than `concerns`. Two of the three reported categories are
 * not decidable by reading the source:
 *
 * - "authenticated, no authorization guard" (27 routes) is a real question and a
 *   product judgement. Some routes are legitimately readable by any member of the
 *   organization; which ones is a decision a person has to make and write down,
 *   and a gate that encodes 27 guesses is worse than no gate.
 * - "state-changing, no rate limit" (30 routes) depends on what the endpoint is
 *   worth attacking, which is not a property of its source.
 *
 * So those two stay reported. The three below are decidable, and all three are
 * currently satisfied — which makes them tripwires rather than fixes, the same
 * shape as the `throw` rule in §3.2.
 */
  const strictFailures = [];

  // **Every route file must be analysable.** Added because reverting the walker's
  // label — the exact bug SEC-064 was — left `--strict` passing with seven files
  // unplaced and 74 routes unexamined. A strict mode that cannot tell the difference
  // between a reviewed surface and an unreviewed one is the same failure this whole
  // tool exists to prevent, one level up: it reports a clean surface over a surface it
  // never looked at.
  //
  // This is decidable, which is what puts it in the strict set. It is also the only
  // check here that fires on the *tool* rather than on the routes, and it is the one
  // that would have caught every false negative below it.
  const unplacedRouteFiles = routeFiles.filter((f) => !MOUNT.has(f));
  if (strict && unplacedRouteFiles.length > 0) {
    strictFailures.push(
      `${unplacedRouteFiles.length} route file(s) have no resolved mount prefix and were not ` +
        `analysed at all:\n` +
        unplacedRouteFiles.map((f) => `        ${f}`).join("\n") +
        `\n      A file the tool cannot place is a file it does not check — for an ` +
        `authentication guard, a rate limit, or audit logging. Run with --explain to see ` +
        `each file's derivation chain. (SEC-064)`
    );
  }

if (strict) {
  for (const r of routes) {
    if (!r.auth && !PUBLIC_BY_DESIGN.has(r.url)) {
      strictFailures.push(
        `${r.method} ${r.url} — no authentication guard and no entry in PUBLIC_BY_DESIGN. ` +
          `Add the guard, or add the route to the list with a reason.`
      );
    }
  }

  for (const [url, reason] of PUBLIC_BY_DESIGN) {
    if (typeof reason !== "string" || reason.trim() === "") {
      strictFailures.push(
        `PUBLIC_BY_DESIGN has no reason for ${url}. An entry without a reason is ` +
          `indistinguishable from a route nobody looked at.`
      );
    }
  }

  // Every guard named in a route must resolve, so a typo cannot disable it.
  for (const file of routeFiles) {
    // Comments are removed from the whole file before the blocks are matched, not
    // from each block afterwards. A `//` comment inside a preHandler list that
    // mentions a guard name is prose, and a comment containing a `]` also
    // truncates the match and swallows the real guards after it. Both showed up
    // as guards named "so" and "which".
    const source = stripComments(read(file));
    for (const block of source.matchAll(/preHandler:\s*\[([^\]]*)\]/g)) {
      for (const element of splitTopLevel(block[1])) {
        // `app.<name>` is a decorator lookup; a bare leading identifier is a
        // helper. Anything else at this position is a value, not a guard.
        const decorated = /^\s*app\.([A-Za-z_][A-Za-z0-9_]*)/.exec(element);
        if (decorated) {
          const name = decorated[1];
          if (!APP_GUARDS.has(name) && name !== "container") {
            strictFailures.push(
              `${file} — preHandler names app.${name}, which is not a guard. Fastify ` +
                `evaluates an unknown decorator to undefined and skips it, so this ` +
                `guard does not run. Known: ${[...APP_GUARDS].sort().join(", ")}.`
            );
          }
          continue;
        }
        const bare = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(element);
        if (!bare) continue;
        const name = bare[1];
        // A guard defined in the same file resolves, whether it is a shared
        // helper or something the file builds for itself — `factorRateLimit` in
        // totp.ts, `requireOrgIdParam` in workflows.ts. Requiring a file-local
        // guard to appear in a global allowlist would mean adding a name to a
        // shared list every time a route file grows one, which is a tax with no
        // safety in return: the thing being checked is whether the name resolves
        // to something, and a local declaration is something.
        const declaredHere = new RegExp(
          `(?:const|let|var|function)\\s+${name}\\b`
        ).test(source);
        if (!declaredHere && !HELPER_GUARDS.has(name) && !NOT_GUARDS.has(name)) {
          strictFailures.push(
            `${file} — preHandler names "${name}", which is not a known guard. ` +
              `A misspelled guard is skipped at request time, not rejected at load. ` +
              `Known: ${[...HELPER_GUARDS].sort().join(", ")}.`
          );
        }
      }
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ routes, concerns, strictFailures }, null, 2));
} else {
  // Every `PUBLIC_BY_DESIGN` key must name a route the server actually serves.
  //
  // An entry that names a path which does not exist is **inert**: `get()` returns
  // undefined for the route it was written about, and the reason reads as if it were
  // doing work. Three entries were inert for exactly this reason — `/sso/saml/login`,
  // `/sso/saml/metadata/:connectionId` and `/sso/oidc/callback` all name paths that
  // do not exist, and nothing noticed until an unrelated change made those routes
  // visible to the parser at all.
  //
  // Checked in both directions, and only the missing-key direction was checked
  // before. The same shape as every other finding in this registry: a control that
  // looks like it covers something and does not.
  //
  // The two failures are different and the difference matters. An entry whose path
  // appears **nowhere in the source** is inert: the reason is written about a route
  // that does not exist. An entry whose path exists in a file the parser could not
  // place is merely unverified — the route is real, and the reason may well be
  // correct, but this tool cannot see it. Reporting the second as the first would be
  // its own kind of false report.
  const allSource = routeFiles.map((file) => read(file)).join("\n");
  const unresolvedFiles = routeFiles.filter((file) => !MOUNT.has(file));
  for (const key of PUBLIC_BY_DESIGN.keys()) {
    if (routes.some((other) => other.url === key)) continue;
    // Progressively drop leading segments, keeping at least the last two, because a
    // path parameter in the final segment defeats a single-tail comparison:
    // `/sso/saml/:connectionId/metadata` has a tail of `/:connectionId/metadata`,
    // and the source says `"/saml/:connectionId/metadata"` — so a tail check calls
    // a real route inert. Two segments is the floor because a single segment
    // (`/setup`) matches too much to mean anything.
    //
    // The plugin's prefix is not in the file, so `/auth/refresh` is declared as
    // `app.post("/refresh", …)` in a file mounted at `/auth`. Comparing the whole
    // key therefore finds nothing for a route that plainly exists, and the fix is
    // to compare on the trailing segments — the part the file actually declares.
    //
    // A heuristic, and a documented one: a single trailing segment is weak evidence
    // (`/setup` would match any `"/setup"` route), so the full key and two trailing
    // segments are tried first and the single segment is the last resort. A key that
    // matches none of them appears in no route file at all, which is what an inert
    // reason looks like.
    const segments = key.split("/").filter(Boolean);
    const forms = [
      `"${key}"`,
      ...[2, 3, 4]
        .filter((take) => segments.length >= take)
        .map((take) => `"/${segments.slice(-take).join("/")}"`),
      ...(segments.length >= 1 ? [`"/${segments[segments.length - 1]}"`] : []),
    ];
    const present = forms.some((form) => allSource.includes(form));
    if (present) unverifiedReasons.push(key);
    else publicKeyMisses.push(key);
  }
  if (publicKeyMisses.length > 0) {
    console.log("PUBLIC_BY_DESIGN entries naming a route that does not exist (inert reasons):");
    for (const key of publicKeyMisses) console.log(`    ${key}`);
    console.log("");
  }
  if (unverifiedReasons.length > 0) {
    console.log("PUBLIC_BY_DESIGN entries in route files this tool cannot place (unverified, not inert):");
    for (const key of unverifiedReasons) console.log(`    ${key}`);
    console.log(`    (${unresolvedFiles.length} route file(s) have no resolved prefix — see SEC-064)`);
    console.log("");
  }

  console.log(`Routes enumerated: ${routes.length} across ${new Set(routes.map((r) => r.file)).size} files`);
  console.log(`  authenticated:         ${routes.filter((r) => r.auth).length}`);
  console.log(`  with authorization:    ${routes.filter((r) => r.authorization).length}`);
  console.log(`  with rate limiting:    ${routes.filter((r) => r.rateLimit).length}`);
  console.log(`  in a file that audits: ${routes.filter((r) => r.audit).length}`);
  console.log(`  public by design:      ${routes.filter((r) => PUBLIC_BY_DESIGN.has(r.url)).length}`);
  // Counted over route files only. `MOUNT` also holds `src/routes/admin.ts` and
  // `src/routes/index.ts` — barrels with no routes of their own — so `MOUNT.size`
  // against `routeFiles.length` printed **40 of 31**, which reads as a bug in the
  // count rather than as two different sets being compared. A ratio above 1 is the
  // tell: it cannot mean what the label says.
  const routeFilesResolved = routeFiles.filter((f) => MOUNT.has(f)).length;
  console.log(`  prefixes resolved:     ${routeFilesResolved}/${routeFiles.length} route files`);
  console.log("");
  console.log(`Routes with an open question: ${concerns.length}`);
  for (const c of concerns) {
    console.log(`  ${c.method.padEnd(6)} ${c.url.padEnd(46)} ${c.problems.join("; ")}`);
  }
  // A gate that cannot fail is not a gate, and this one reported problems while
  // exiting 0 — the finding was on screen and the build went green. `--strict`
  // exists to be wired into the release job, so it has to set the exit code.
  if (strictFailures.length > 0) process.exitCode = 1;

  if (strict) {
    console.log("");
    if (strictFailures.length === 0) {
      console.log("Strict: OK — every route has a guard or a written reason, every guard name resolves.");
    } else {
      console.log(`Strict: ${strictFailures.length} problem(s):`);
      for (const f of strictFailures) console.log(`  ${f}`);
    }
  }
  if (MOUNT.size < routeFiles.length) {
    console.log("");
    console.log("  Route files with no resolved prefix (urls below are relative):");
    for (const f of routeFiles) if (!MOUNT.has(f)) console.log(`    ${f}`);
  }
}
