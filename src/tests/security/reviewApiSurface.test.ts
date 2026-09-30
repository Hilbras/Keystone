import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The API surface review's coverage. (SEC-064)
 *
 * **What was wrong, and it was three separate bugs stacked.**
 *
 * The tool reported "79 routes across 22 files" while the repository declares far more.
 * Each of the three causes below independently produced that, and none was visible in
 * the output:
 *
 * 1. **The file walker mislabelled nested directories.** It recursed into `admin/` but
 *    built each label from the *top-level* name, so `src/routes/admin/platform.ts` was
 *    read as `src/routes/platform.ts` — a path that does not exist. `read()` returns
 *    `""` for a missing file rather than throwing, so all seven admin files reported
 *    zero routes with nothing saying they could not be read.
 * 2. **The route pattern required two commas.** It matched
 *    `app.get(path, {opts}, handler)` and not `app.get(path, handler)` — the other
 *    ordinary way to write a route, and the one `admin/*.ts` uses. Even with a
 *    correctly-named file, 74 routes went unseen.
 * 3. **The prefix walk was one hop.** `admin/*.ts` are reached through
 *    `routes/admin.ts` (a one-line barrel) and then `routes/admin/index.ts`, and
 *    `health.ts` is registered as `app.register(healthRoutes)` with no options object
 *    at all — which the pattern required `prefix:` to match.
 *
 * The tell was a ratio above one: "prefixes resolved: **40/31** route files" was
 * printed every run and read as a quirk rather than as a contradiction. You cannot
 * resolve more files than exist.
 *
 * 79 → 176 routes. The 97 that appeared have **never** been checked for an
 * authentication guard, a rate limit, or audit logging, and they include the entire
 * platform-owner administration surface.
 *
 * ## Why this test exists separately
 *
 * The tool's own output is not evidence about the tool. Everything below is asserted
 * against a fresh run, and the specific assertions are about *properties* — a route
 * file that produces no routes, a route the old pattern could not match — rather than
 * a count, because a count changes every time a route is added and a test that fails
 * for that reason gets deleted.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(root, "scripts/review-api-surface.mjs");

/** One entry of the tool's JSON report. */
interface ReportRoute {
  file: string;
  method: string;
  url: string;
  auth: boolean;
  authorization: boolean;
  rateLimit: boolean;
  audit: boolean;
}

interface Report {
  routes: ReportRoute[];
  concerns: (ReportRoute & { publicReason: string | null; problems: string[] })[];
  strictFailures: string[];
}

/** Run the tool synchronously. Used where the caller mutates the tree first. */
function runSync(args: string[]): Report {
  const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Report;
}

/** Run the tool and return its parsed report. */
function run(args: string[]): Promise<Report> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) return reject(error);
        try {
          resolve(JSON.parse(stdout) as Report);
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          reject(new Error(`the tool did not produce JSON: ${why}\n${stdout.slice(0, 400)}`));
        }
      }
    );
  });
}

/**
 * Route files that legitimately declare no routes.
 *
 * Each is listed with the reason, because "the tool ignores these" is a claim that
 * needs its own evidence — and because an unexplained exception list is how a
 * "known exclusions" list starts hiding real files.
 */
const NO_ROUTE_FILES = new Map([
  ["src/routes/helpers.ts", "shared route helpers, not a plugin"],
  ["src/routes/index.ts", "barrel; re-exports the plugin list"],
  ["src/routes/admin.ts", "barrel; one line, re-exports admin/index.js"],
  ["src/routes/admin/helpers.ts", "shared admin route helpers, not a plugin"],
  ["src/routes/admin/index.ts", "composition root; registers the seven admin plugins"],
]);

/** Every `.ts` under src/routes, excluding the helpers barrels. */
function routeFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".ts")) out.push(rel);
    }
  })("src/routes");
  return out;
}

let report: Report;
let strictReport: Report;

before(async () => {
  report = await run(["--json"]);
  strictReport = await run(["--json", "--strict"]);
});

describe("the API surface review's coverage (SEC-064)", () => {
  it("places every route file, so none is invisible to the review", () => {
    // The check that was missing: `--strict` passed with seven files unplaced and 74
    // routes unexamined. A strict mode that cannot tell a reviewed surface from an
    // unreviewed one reports a clean surface over one it never looked at.
    assert.deepEqual(
      strictReport.strictFailures,
      [],
      "strict mode must fail when a route file cannot be placed. Failures:\n" +
        strictReport.strictFailures.join("\n")
    );
  });

  it("fails strict mode when a route file cannot be placed", () => {
    // The assertion above **cannot** establish that the check exists. It asserts
    // `strictFailures` is empty, and an empty array is exactly what a tool with no
    // such check also returns on a clean tree. Disabling the check proved it: all nine
    // tests stayed green.
    //
    // So this one plants a route file that nothing registers — the state the check
    // exists to catch — and requires strict mode to fail, then removes it. The name is
    // distinctive and the file is deleted in a `finally`, because a stray file under
    // `src/routes/` is picked up by the route walk and by anything else that
    // enumerates the directory.
    const planted = path.join(root, "src/routes/zz-unplaced-for-test.ts");
    assert.equal(existsSync(planted), false, "a previous run left its fixture behind");
    writeFileSync(
      planted,
      [
        "// Planted by src/tests/security/reviewApiSurface.test.ts, and removed by it.",
        "// Nothing imports or registers this module, so the tool cannot place it —",
        "// which is the condition strict mode must refuse.",
        "export const unplaced = true;",
        "",
      ].join("\n"),
      "utf-8"
    );
    try {
      const withStray = runSync(["--json", "--strict"]);
      assert.ok(
        withStray.strictFailures.some((f) => f.includes("no resolved mount prefix")),
        "strict mode must fail while a route file is unplaceable. Failures: " +
          JSON.stringify(withStray.strictFailures)
      );
    } finally {
      rmSync(planted, { force: true });
      assert.equal(existsSync(planted), false, "the fixture must not survive the test");
    }
  });

  it("finds routes in every file that declares one", () => {
    // The mislabelled-walker bug reported zero for the admin tree while looking
    // entirely healthy, because a file that cannot be read and a file with no routes
    // are the same observation.
    const withRoutes = new Set(report.routes.map((r) => r.file));
    const missing = routeFiles().filter(
      (f) => !withRoutes.has(f) && !NO_ROUTE_FILES.has(f)
    );
    assert.deepEqual(
      missing,
      [],
      "these route files produced no routes. Either they declare none — add them to " +
        "NO_ROUTE_FILES with a reason — or the walker cannot read them, which is the " +
        "SEC-064 bug returning."
    );
  });

  it("matches both ways of writing a route", () => {
    // `app.get(path, handler)` and `app.get(path, {opts}, handler)` are the same thing.
    // The old pattern required two commas and saw only the second form, so most of
    // `admin/*.ts` was invisible. One of each, both in the admin tree.
    const urls = new Set(report.routes.map((r) => `${r.method} ${r.url}`));

    // Short form: no options object at all.
    assert.ok(
      urls.has("GET /v1/admin/platform/users"),
      "a route written `app.get(path, handler)` must be found; it is the form the old " +
        "two-comma pattern could not match"
    );
    // Long form: an options object between the path and the handler.
    assert.ok(
      urls.has("GET /v1/admin/permissions"),
      "a route written `app.get(path, {opts}, handler)` must be found"
    );
  });

  it("resolves the three-hop admin prefix and the no-options health mount", () => {
    // The two shapes that defeated the one-hop walk. `/health` is registered as
    // `app.register(healthRoutes)` with no second argument, which the old pattern's
    // required `prefix:` could not match — so it was recorded as unresolved rather
    // than as the root prefix it is.
    const byUrl = new Map(report.routes.map((r) => [r.url, r]));
    assert.ok(byUrl.has("/health"), "a plugin registered with no options mounts at the root");
    assert.ok(byUrl.has("/ready"), "and so does the readiness probe beside it");
    assert.ok(
      byUrl.has("/v1/admin/platform/users"),
      "a barrel re-exporting a composition root must pass the prefix down three hops"
    );
  });

  it("does not report a locally-aliased guard as missing", () => {
    // `admin/sso.ts` builds `const requireSsoReader = requireOrganizationRole(…)` and
    // uses the alias in every preHandler. The tool knew the defining call and not the
    // name, and reported ten SSO and SCIM administration routes as unauthenticated.
    const unguarded = report.concerns
      .filter((c) => c.problems.some((p) => p === "no authentication guard"))
      .map((c) => `${c.method} ${c.url}`);
    assert.deepEqual(
      unguarded,
      [],
      "these routes are reported as unauthenticated. A guard reached through a local " +
        "alias is still a guard."
    );
  });

  it("counts a guard called in the handler body, not only in a preHandler", () => {
    // Every /setup route except /status guards with
    // `if (!assertSetupToken(request, reply)) return;` in the handler body, which is
    // the right shape for a guard that has to answer with a body. Testing only the
    // options object reported eleven of them as open, including `/setup/init`.
    const setupOpen = report.concerns
      .filter((c) => c.url.startsWith("/setup/"))
      .filter((c) => c.problems.some((p) => p === "no authentication guard"))
      .map((c) => c.url);
    assert.deepEqual(setupOpen, [], "assertSetupToken guards these in the handler body");
  });

  it("has a reason for every route it calls public by design", () => {
    // Reasons are the only thing making a public route reviewable, and a route with
    // no reason is a route nobody has looked at.
    const withNoReason = report.concerns
      .filter((c) => c.problems.includes("no authentication guard"))
      .filter((c) => !c.publicReason)
      .map((c) => `${c.method} ${c.url}`);
    assert.deepEqual(withNoReason, [], "every publicly-reachable route needs a stated reason");
  });

  it("names a file for every route it reports", () => {
    // A route with no file cannot be acted on, and a wrong file sends someone to read
    // the wrong code.
    const bad = report.routes.filter((r) => !existsSync(path.join(root, r.file)));
    assert.deepEqual(
      bad.map((r) => r.file),
      [],
      "every reported route must name a file that exists — this is the mislabelled " +
        "walker's signature"
    );
  });

  it("gives every route file with a prefix a derivation chain", () => {
    // A prefix with no recorded derivation is a claim with nothing behind it, and the
    // admin chain is three hops deep.
    const explained = new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [SCRIPT, "--explain"],
        { cwd: root, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      );
    });
    return explained.then((out) => {
      assert.ok(/src\/routes\/admin\/platform\.ts/.test(out), "the admin chain must be shown");
      assert.ok(
        /re-exports default from/.test(out),
        "and the barrel hop in it must be named, since that is the step a reader " +
          "cannot infer from the file"
      );
      assert.ok(!/UNPLACED/.test(out), "nothing may be unplaced");
    });
  });
});
