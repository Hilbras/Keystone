import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, rmSync, openSync, writeSync, closeSync } from "node:fs";
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

/**
 * Route files the review deliberately does not analyse, each with its reason.
 *
 * **A separate list from `NO_ROUTE_FILES`, because they answer different questions.**
 * A file in `NO_ROUTE_FILES` is a route file the tool places and which declares no routes —
 * a barrel, a helpers module. A file here is one the tool never looks at, so nothing about
 * it is checked and that has to be a decision rather than a gap.
 *
 * `src/setup-server.ts` is the only one. It is a standalone Fastify instance behind
 * `npm run start:setup` / `KEYSTONE_SETUP_MODE=true`, serving `/setup/*` and a liveness
 * probe before the application is configured. The tool's model is one application with many
 * mount prefixes; putting a second application's routes in the same report would make every
 * count in it wrong. It is also a bare `.get("/health")`, which would collide with the main
 * app's own `/health` — the clearest possible signal that it does not belong in that report.
 */
const EXCLUDED_FROM_REVIEW = new Map([
  ["src/setup-server.ts", "a separate entry point and a separate Fastify application; see the note above"],
]);

/**
 * Every file under `src/` that is **route-shaped**, decided by a deliberately cruder rule
 * than the tool's own.
 *
 * ## Why not the tool's `findRoutes`
 *
 * The tool decides "this file declares routes" with `findRoutes`, and if this used the same
 * function it would be checking the tool against itself: a bug in `findRoutes` would make a
 * file look route-less to both, and the assertion below would pass over exactly the file it
 * exists to catch. That is not a hypothetical here — SEC-064 *was* a `findRoutes`-adjacent
 * bug that reported zero routes for seven files while looking entirely healthy.
 *
 * So this scans for the shape rather than parsing it: any `.get(`/`.post(`/`.put`/
 * `.patch(`/`.delete(` call whose first argument is a string or template literal.
 *
 * The bias is deliberately toward over-inclusion. It matched 32 files across `src/`: the 31
 * the tool analyses, plus `src/setup-server.ts`, and **nothing else** — so a false positive
 * here would show up as a file that has to be justified, which is the direction to err in.
 * A pattern that missed a form the tool accepts would fail the other way and silently, which
 * is the failure this whole release is about.
 */
function routeShapedFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    if (dir === "src/tests") return;
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".ts")) {
        const source = readFileSync(path.join(root, rel), "utf-8");
        if (/\.\s*(get|post|put|patch|delete)\s*\(\s*["'`]/.test(source)) out.push(rel);
      }
    }
  })("src");
  return out.sort();
}

/** Every `.ts` under `src/routes`, which is where route files are expected to live. */
function routeFiles() {
  const out: string[] = [];
  (function walk(dir: string) {
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
    // distinctive and the file is removed in a `finally`, because a stray file under
    // `src/routes/` is picked up by the route walk and by anything else that
    // enumerates the directory.
    //
    // **Created with `O_EXCL`, which is both the write and the assertion.** The first
    // version asked `existsSync` and then wrote, which is a check-then-write — and
    // CodeQL reported it as `js/file-system-race` on this file, correctly, in the same
    // release that created it. The exclusive create makes "a previous run left its
    // fixture behind" atomic with the creation, so there is no window and no separate
    // statement to get wrong.
    const planted = path.join(root, "src/routes/zz-unplaced-for-test.ts");
    let handle: number;
    try {
      handle = openSync(planted, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      assert.fail(
        "planting the fixture must be exclusive, so a leftover from a previous run is " +
          `reported rather than overwritten (got ${code}). If one is present, remove ${planted} — ` +
          "it means a run was interrupted between planting and cleanup."
      );
    }
    try {
      // A Buffer, not a string: writeSync's string overload takes a *position* as its
      // third argument, so the two obvious spellings both fail to typecheck.
      writeSync(
        handle,
        Buffer.from(
          [
            "// Planted by src/tests/security/reviewApiSurface.test.ts, and removed by it.",
            "// Nothing imports or registers this module, so the tool cannot place it —",
            "// which is the condition strict mode must refuse.",
            "//",
            "// It declares a route. The previous version of this fixture exported a bare",
            "// constant, which worked only because the walker used to include every .ts file",
            "// under src/routes — so barrels and helper modules needed a mount prefix too, and",
            "// NO_ROUTE_FILES existed to excuse them. The walker now keeps only files that",
            "// declare a route, because a route-less file has *been* checked: it was read and",
            "// found empty. Demanding a mount for it was the wrong rule, and a fixture that",
            "// depended on the wrong rule was not testing the check.",
            "export async function planted(app: { get: (p: string, h: () => void) => void }) {",
            '  app.get("/zz-planted-for-test", async () => ({ ok: true }));',
            "}",
            "",
          ].join("\n"),
          "utf-8"
        )
      );
      closeSync(handle);
      const withStray = runSync(["--json", "--strict"]);
      assert.ok(
        withStray.strictFailures.some((f) => f.includes("no resolved mount prefix")),
        "strict mode must fail while a route file is unplaceable. Failures: " +
          JSON.stringify(withStray.strictFailures)
      );
    } finally {
      try {
        closeSync(handle);
      } catch {
        // Closed above; closing twice is not a failure worth reporting.
      }
      rmSync(planted, { force: true });
      assert.equal(existsSync(planted), false, "the fixture must not survive the test");
    }
  });

  it("finds routes in every file that is route-shaped", () => {
    // The mislabelled-walker bug reported zero for the admin tree while looking
    // entirely healthy, because a file that cannot be read and a file with no routes
    // are the same observation.
    //
    // Decided by `routeShapedFiles`, not by the tool's own parser — see its note. The
    // commit that this replaced walked `src/routes` and compared against the report; that
    // verified a *narrower* set than the tool used, so `src/index.ts` and
    // `src/plugins/metrics.ts` could both have been dropped again without this failing.
    const withRoutes = new Set(report.routes.map((r) => r.file));
    const missing = routeShapedFiles().filter(
      (f) => !withRoutes.has(f) && !EXCLUDED_FROM_REVIEW.has(f)
    );
    assert.deepEqual(
      missing,
      [],
      "these files declare a route and the report has none. Either the walker cannot read " +
        "them — the SEC-064 bug returning — or they are outside the directory it walks, " +
        "which is how two real routes went uncounted until 3.5.10. If the file really does " +
        "not belong in the review, add it to EXCLUDED_FROM_REVIEW with a reason."
    );
  });

  it("excludes exactly the files it says it excludes, and no others", () => {
    // An exclusion list that can grow silently is a hole with a comment on it. This
    // asserts both directions: every exclusion is a real file that really is route-shaped
    // (so the list is not padding), and no route-shaped file is excluded without appearing
    // in it (which the previous test already covers, and is restated here because the two
    // halves of the claim belong together).
    for (const file of EXCLUDED_FROM_REVIEW.keys()) {
      assert.ok(
        routeShapedFiles().includes(file),
        `${file} is excluded from the review but declares no route, so the exclusion is ` +
          `stale rather than deliberate. Remove it, or fix the reason, which then has to ` +
          `explain itself.`
      );
      assert.ok(
        existsSync(path.join(root, file)),
        `${file} is excluded from the review and does not exist.`
      );
    }
  });

  it("places every route file the tool claims to place", () => {
    // The narrower check the file-shaped scan cannot make: a file can be route-shaped and
    // in the report, and still be analysed at the wrong URL if its mount prefix is wrong.
    // That is the SEC-062 shape — a route reported at a path the server does not serve.
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

  it("does not report a route as unauthorized when it has not looked for the guard", () => {
    // SEC-068. The category used to read "authenticated, no authorization guard", which
    // on every run showed 43 unresolved problems. It was 43 routes whose guard this
    // tool cannot see, because this repository authorizes in a named preHandler, in
    // the handler body, and in the application service — and the tool reads one.
    //
    // The wording is the whole fix, and wording is exactly what no other check here
    // reads, so it had no test: reverting it would have passed every gate in the file.
    // This is that test. It pins the two separate populations, because collapsing them
    // back into one number is what produced the misreading.
    const text = (): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [SCRIPT],
          { cwd: root, maxBuffer: 32 * 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout))
        );
      });

    return text().then((out) => {
      assert.ok(
        !/no authorization guard/.test(out),
        "the report must not claim a route is unauthorized. It has not looked for the " +
          "guard, and saying otherwise is a statement about this tool presented as a " +
          "statement about the route. Output:\n" +
          out.slice(0, 600)
      );
      assert.ok(
        /no NAMED authorization guard found/.test(out),
        "and the category must be present in the form that names its own limit"
      );
      assert.ok(
        /with a NAMED guard:\s+\d+/.test(out) && /authorized elsewhere:\s+\d+/.test(out),
        "the summary must report the two populations separately, or a reader cannot " +
          "tell which routes were checked against a guard and which were not:\n" +
          out.slice(0, 600)
      );
      // The pointer is what makes the category honest: it names the test that covers
      // the population this tool cannot check. A dangling pointer is worse than none.
      assert.ok(
        /authorized elsewhere:.*tenantIsolation\.test\.ts/s.test(out),
        "the count the tool cannot verify must name the test that does verify it"
      );
      assert.ok(
        existsSync(path.join(root, "src/tests/security/authorization/tenantIsolation.test.ts")),
        "and that test must exist, or the pointer is a claim about a file that is not there"
      );
    });
  });

  it("analyses the routes declared in src/index.ts, not only those under src/routes", () => {
    // The tool's `routeFiles` came from walking `src/routes`, so the two routes declared
    // in the file that *builds* the app — `/.well-known/openid-configuration` and
    // `/.well-known/jwks.json` — were analysed by nothing. The report said "178 routes" as
    // though that were the surface; it was 180.
    //
    // This is the SEC-064 failure one level out. There, seven route files were unplaced and
    // the tool reported a clean surface over a surface it never looked at. Here, one file
    // sits outside the walk, and the count is simply lower than reality — which is the
    // easier version of the same mistake to miss, because a smaller number looks like
    // tidiness rather than omission.
    const report = runSync(["--json"]);

    const wellKnown = report.routes.filter((r) => r.url.startsWith("/.well-known/"));
    assert.deepEqual(
      wellKnown.map((r) => `${r.method} ${r.url}`).sort(),
      ["GET /.well-known/jwks.json", "GET /.well-known/openid-configuration"],
      "the discovery routes declared directly in src/index.ts must be in the report. If " +
        "they are missing, the walker is no longer reaching that file and every count here " +
        "is an undercount that reads as a total."
    );

    // And they must carry a recorded reason for being public. `--strict` enforces this, so
    // a route that became visible without anyone saying why fails the gate rather than
    // quietly joining the "public by design" count.
    const strict = runSync(["--json", "--strict"]);
    assert.deepEqual(
      strict.strictFailures,
      [],
      `--strict must pass now that src/index.ts is analysed. Its routes are public by ` +
        `design and have reasons recorded; an unplaced file or a public route without one ` +
        `appears here.`
    );
  });

  it("sees a limiter that a route shares through a named options object", () => {
    // `oidcEnterprise.ts` registers its callback at two paths with one `callbackOptions`,
    // because two `keyPrefix` values on one endpoint is two rate-limit allowances. That is
    // the correct shape, and it made the limiter invisible: `findRoutes` only captured an
    // options object when the argument after the path began with `{`, so a bare name
    // yielded an empty string and the reported count fell from 28 to 27 with nothing
    // failing.
    //
    // A tool that stops reporting is the failure this file exists to prevent, so the count
    // is pinned rather than the mechanism. Asserting "the mechanism works" would pass just
    // as well against a tool that stopped counting the routes entirely.
    const report = runSync(["--json"]);
    const callbacks = report.routes.filter((r) => r.url.endsWith("/oidc/:connectionId/callback"));
    assert.equal(
      callbacks.length,
      2,
      `expected the callback at both the canonical and the legacy path, found ` +
        `${callbacks.length}: ${callbacks.map((r) => r.url).join(", ")}`
    );
    for (const route of callbacks) {
      assert.ok(
        (route as unknown as { rateLimit: boolean }).rateLimit,
        `${route.url} shares its options object with the other callback path, so the ` +
          `limiter is not in its own declaration text. The tool must resolve the name — ` +
          `otherwise a rate limit that is present is reported as absent.`
      );
    }
  });
});
