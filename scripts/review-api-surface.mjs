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
 * The prefix each route module is mounted at, derived from index.ts.
 *
 * Without this, `/login` in `auth.ts` is indistinguishable from a genuinely
 * unauthenticated `/login` and every such route reads as a finding. A review
 * tool with fifty false positives gets ignored, which makes it worse than none.
 *
 * Derived rather than tabulated so a route added under a new prefix is covered
 * without editing this file — a hand-kept list is one more thing to forget.
 */
function mountPrefixByFile() {
  const source = read("src/index.ts");
  const prefixes = new Map();
  const re = /register\((\w+),\s*\{\s*prefix:\s*"([^"]*)"/g;
  for (const m of source.matchAll(re)) {
    prefixes.set(m[1], m[2] === "" ? "" : m[2].replace(/\/$/, ""));
  }
  const map = new Map();
  const importRe = /import\s+(\w+)\s+from\s+"\.\/routes\/([^"]+)\.js"/g;
  for (const m of source.matchAll(importRe)) {
    if (prefixes.has(m[1])) map.set(`src/routes/${m[2]}.ts`, prefixes.get(m[1]));
  }
  return map;
}
const MOUNT = mountPrefixByFile();

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

const routeFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join("src/routes", entry.name);
    if (entry.isDirectory()) walk(path.join(dir, entry.name));
    else if (entry.name.endsWith(".ts") && entry.name !== "helpers.ts") routeFiles.push(rel);
  }
})("src/routes");

const routes = [];
/** `PUBLIC_BY_DESIGN` keys that match no route. See the check below. */
const publicKeyMisses = [];
/** Keys whose route exists in a file the parser could not place. */
const unverifiedReasons = [];
for (const file of routeFiles) {
  const source = read(file);
  const prefix = MOUNT.get(file) ?? null;
  const fileAudits = AUDIT.some((r) => r.test(source));
  const re = /app\.(get|post|put|patch|delete)\(\s*(?:"|`)([^"`]+)(?:"|`)\s*,\s*(\{[\s\S]*?\}\s*)?,/g;
  for (const m of source.matchAll(re)) {
    const [, method, url, opts = ""] = m;
    const full = ((prefix === null ? url : `${prefix}${url}`).replace(/\/+$/, "")) || "/";
    routes.push({
      file,
      method: method.toUpperCase(),
      url: full,
      auth: AUTH.some((r) => r.test(opts)) || SCIM.test(full) || HOOK_AUTH.has(file),
      authorization: AUTHORIZATION.some((r) => r.test(opts)),
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
  console.log(`  prefixes resolved:     ${MOUNT.size}/${routeFiles.length} route files`);
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
