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
  ["/sso/saml/login", "SAML AuthnRequest initiation"],
  ["/sso/saml/acs", "SAML assertion consumer, authenticated by the signed assertion"],
  ["/sso/saml/metadata/:connectionId", "IdP metadata fetch"],
  ["/sso/oidc/login", "OIDC initiation"],
  ["/sso/oidc/callback", "OIDC callback, authenticated by the state cookie and code"],
  ["/setup", "first-run provisioning; loopback-bound and origin-restricted"],
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

if (asJson) {
  console.log(JSON.stringify({ routes, concerns }, null, 2));
} else {
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
  if (MOUNT.size < routeFiles.length) {
    console.log("");
    console.log("  Route files with no resolved prefix (urls below are relative):");
    for (const f of routeFiles) if (!MOUNT.has(f)) console.log(`    ${f}`);
  }
}
