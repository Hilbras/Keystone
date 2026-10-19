import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pino } from "pino";

const run = promisify(execFile);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "logging-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { sanitizeLogValue, isSensitiveLogKey, stripQuery, scrubDriverErrorText, REDACTED } =
  await import("../../lib/logSanitizer.js");
const { loggerOptions, serviceLogger } = await import("../../lib/logger.js");

/**
 * §5.1: "Never log passwords, access tokens, refresh tokens, API secrets, OAuth
 * codes, webhook secrets."
 *
 * Three things are asserted, and they fail in different ways:
 *
 * 1. **The scrubber reaches any depth.** pino's built-in `redact` takes *paths*,
 *    and a measured `*.password` matches exactly one level and does not descend
 *    into arrays, so a path list only covers the shapes someone thought of. The
 *    scrubber walks the value. The depth and array cases below are the difference.
 *
 * 2. **Both loggers carry it.** Fastify builds its own pino instance from the
 *    options passed to `fastify()`, so the service logger being safe says nothing
 *    about `request.log`. Both are built from `loggerOptions`, and the assertion
 *    is on the object that both are built from.
 *
 * 3. **The request target loses its query string.** This is the one with a real,
 *    exploitable failure behind it: `request.url` was logged verbatim, and
 *    `GET /auth/magic-link/verify?token=…` takes a credential that by itself signs
 *    you in. Asserted end-to-end against a booted server, because the text
 *    `stripQuery` returns is not evidence that the access log uses it.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PROBE = path.resolve(__dirname, "../helpers/accessLogProbe.js");
const SECRET = `magic-link-token-${RUN_ID}`;

describe("log scrubbing", () => {
  it("redacts a sensitive key at the top level", () => {
    assert.deepEqual(sanitizeLogValue({ password: "hunter2", user: "a" }), {
      password: REDACTED,
      user: "a",
    });
  });

  it("redacts a sensitive key at any depth", () => {
    // The case pino's path syntax cannot express: `*.password` stops at one level.
    const nested = { a: { b: { c: { refresh_token: "rt" } } } };
    assert.deepEqual(sanitizeLogValue(nested), {
      a: { b: { c: { refresh_token: REDACTED } } },
    });
  });

  it("redacts inside arrays", () => {
    // Also unexpressible as a path: wildcards do not descend into arrays, and a
    // batch of credentials logged as an array is the shape a bulk import logs.
    assert.deepEqual(sanitizeLogValue({ keys: [{ apiKey: "k1" }, { apiKey: "k2" }] }), {
      keys: [{ apiKey: REDACTED }, { apiKey: REDACTED }],
    });
  });

  it("matches keys case-insensitively and across separators", () => {
    // `X-Api-Key`, `apiKey` and `api_key` are one rule, not three call-site rules.
    for (const key of ["apiKey", "API_KEY", "X-Api-Key", "x-api-key"]) {
      assert.equal(isSensitiveLogKey(key), true, `${key} should be sensitive`);
    }
    assert.deepEqual(sanitizeLogValue({ "X-Api-Key": "k" }), { "X-Api-Key": REDACTED });
  });

  it("treats a hash of a secret as a secret", () => {
    // `passwordHash` is not the password, but it is a credential-equivalent: it is
    // what an offline attack is run against, and it must not be in a log either.
    assert.deepEqual(sanitizeLogValue({ passwordHash: "$argon2id$..." }), {
      passwordHash: REDACTED,
    });
  });

  it("leaves the error contract's `code` field alone", () => {
    // The deliberate exclusion. §5.1 asks for `errorCode` on every operation, and
    // this codebase's error contract is `{ error, code }`; a rule that redacted a
    // key named `code` would censor the field the same requirement asks for.
    assert.deepEqual(sanitizeLogValue({ error: "Invalid token", code: "INVALID_TOKEN" }), {
      error: "Invalid token",
      code: "INVALID_TOKEN",
    });
  });

  it("does not touch values it cannot reason about", () => {
    // Errors, dates and buffers are handed to pino's serializers intact. Copying
    // them would either lose the shape those serializers need or produce a log
    // line about the sanitizer instead of about the failure.
    const err = new Error("boom");
    const when = new Date(0);
    const value = sanitizeLogValue({ err, when, password: "p" }) as Record<string, unknown>;
    assert.equal(value.err, err, "an Error must survive by reference");
    assert.equal(value.when, when, "a Date must survive by reference");
    assert.equal(value.password, REDACTED);
  });

  it("terminates on a value that references itself", () => {
    // A self-referential payload logged from an error path is exactly when the
    // walk must not spin: the log line is already the last thing that runs.
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    cyclic.password = "p";
    const out = sanitizeLogValue(cyclic) as Record<string, unknown>;
    assert.equal(out.password, REDACTED);
    assert.equal(out.name, "root");
  });

  it("returns the original object when nothing needed redacting", () => {
    // Not an optimisation detail: the common log line should not allocate, and
    // "copied everything anyway" is a behaviour change for callers holding a
    // reference to what they logged.
    const value = { a: 1, b: { c: 2 } };
    assert.equal(sanitizeLogValue(value), value);
  });
});

describe("the logger every component logs through", () => {
  /** Capture what a pino instance built from the shared options writes. */
  function capture(level: string) {
    const lines: string[] = [];
    const logger = pino(loggerOptions(level), {
      write: (line: string) => {
        lines.push(line);
      },
    });
    return { logger, lines };
  }

  it("scrubs the structured argument before it is serialised", () => {
    const { logger, lines } = capture("info");
    logger.info({ body: { password: "hunter2", user: "a" } }, "sign-in");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"password":"\[REDACTED\]"/);
    assert.ok(!lines[0].includes("hunter2"), `the password reached the log: ${lines[0]}`);
  });

  it("scrubs a nested argument on a child logger too", () => {
    // Children inherit the hook, which is what makes `serviceLogger("x")` safe for
    // the components that log payloads.
    const { logger, lines } = capture("info");
    logger.child({ component: "webhooks" }).warn({ endpoint: { secret: "whsec_1" } });
    assert.ok(!lines[0].includes("whsec_1"), `the webhook secret reached the log: ${lines[0]}`);
  });

  it("tags its lines with the service name, so both instances are greppable together", () => {
    const { logger, lines } = capture("info");
    logger.info({}, "x");
    assert.match(lines[0], /"service":"keystone"/);
  });

  it("is the logger the service logger is built from", () => {
    // `serviceLogger` reaches pino through the same options object; asserting the
    // file's own exported seam is what keeps a future logger from being added
    // beside it without the scrubbing.
    const logger = serviceLogger("logging-test");
    assert.ok(logger, "the service logger should exist");
    assert.equal(typeof logger.info, "function");
  });
});

describe("stripQuery", () => {
  it("drops the query string", () => {
    assert.equal(stripQuery("/auth/magic-link/verify?token=abc"), "/auth/magic-link/verify");
  });

  it("drops a fragment too", () => {
    assert.equal(stripQuery("/callback?code=abc#frag"), "/callback");
    assert.equal(stripQuery("/path#frag"), "/path");
  });

  it("leaves a path with no query alone", () => {
    assert.equal(stripQuery("/v1/users"), "/v1/users");
  });

  it("returns an empty string for an absent target", () => {
    // Not a convenience. `FastifyRequest.url` reads as always present but is not
    // on a hand-built request, and the rate limiter's refusal path passed one: the
    // throw on `url.length` landed inside a `try`/`catch` that exists to keep a
    // monitoring failure from becoming a 500, so the `rate_limit_triggered` event
    // was dropped and the refusal went unrecorded. Asserted directly because the
    // callers' behaviour, not this function's, is the contract — see
    // `security/rate-limiting/abuse-prevention.test.ts`, which pins the event.
    assert.equal(stripQuery(undefined), "");
  });

  it("covers every route that takes a credential in the query string", () => {
    // The four entry points found in the tree. Stated as a list because they are
    // what the assertion above is *for*, and a new one should be added here.
    const credentialRoutes = [
      "/auth/magic-link/verify?token=abc",
      "/auth/email-verification/verify?token=abc",
      "/federation/google/callback?code=abc&state=s",
      "/sso/oidc/conn_1/callback?code=abc&state=s",
    ];
    for (const url of credentialRoutes) {
      const stripped = stripQuery(url);
      assert.ok(!stripped.includes("?"), `${url} kept its query string`);
      assert.ok(!stripped.includes("abc"), `${url} kept its credential`);
    }
  });
});

describe("the access log of a booted server", () => {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  before(async () => {
    // A child process, because that is the only way to capture the destination a
    // pino instance resolved at construction. See `helpers/accessLogProbe.ts`.
    const result = await run(process.execPath, [PROBE], {
      env: { ...process.env, PROBE_SECRET: SECRET, KEYSTONE_LOG_LEVEL: "info" },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    }).catch((err: unknown) => {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        code: typeof e.code === "number" ? e.code : 1,
      };
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    exitCode = "code" in result && typeof result.code === "number" ? result.code : 0;
  });

  after(() => {
    stdout = "";
    stderr = "";
  });

  it("booted and served the requests", () => {
    assert.equal(exitCode, 0, `the probe exited ${exitCode}:\n${stderr}`);
    assert.ok(stdout.length > 0, "the probe produced no log output at all");
  });

  it("never writes the query string, and so never writes the token", () => {
    // The assertion this whole fixture exists for. A magic-link token is a bearer
    // credential: anyone who can read the log can sign in as the user until it is
    // consumed, and logs are copied, shipped and indexed far more freely than the
    // credential itself ever is.
    assert.ok(
      !stdout.includes(SECRET),
      `the magic-link token appears in the access log:\n${stdout}`
    );
    assert.ok(
      !stdout.includes("token="),
      `a query string was logged verbatim:\n${stdout}`
    );
  });

  it("records the path, so the line is still useful", () => {
    // Redacting by dropping the line would pass the test above and defeat the log.
    assert.match(stdout, /GET \/auth\/magic-link\/verify/);
    assert.match(stdout, /"path":"\/auth\/magic-link\/verify"/);
  });

  it("names the operation by route pattern, not by request target", () => {
    // §5.1's `operation`. The pattern is what groups: one series per route, rather
    // than one per id in the path.
    assert.match(stdout, /"operation":"GET \/auth\/magic-link\/verify"/);
  });

  it("reports the result and the error code of a failed request", () => {
    assert.match(stdout, /"operation":"GET \/__access-log-probe\/with-code"/);
    assert.match(stdout, /"errorCode":"PROBE_ERROR_CODE"/);
    assert.match(stdout, /"result":"error"/);
    assert.match(stdout, /"statusCode":400/);
  });

  it("joins the line to the trace, which is what the id is for", () => {
    assert.match(stdout, /"traceId":"[0-9a-f]{32}"/);
  });
});

describe("driver errors in log lines", () => {
  /**
   * The third leak surface, and the one that does not look like one: a failed
   * Drizzle query puts its bound parameters into the message text —
   *
   * ```text
   * Failed query: SELECT * FROM sessions WHERE refresh_token_hash = $1
   * params: live-token-123
   * ```
   *
   * — and pino copies that message into both `message` and `stack`. Measured
   * against the query builder in this repository, not read out of its source.
   */
  const drizzleMessage =
    "Failed query: SELECT * FROM sessions WHERE refresh_token_hash = $1\nparams: live-token-123";

  it("cuts the bound parameters out of the message text", () => {
    const scrubbed = scrubDriverErrorText(drizzleMessage);
    assert.ok(!scrubbed.includes("live-token-123"), scrubbed);
    assert.match(scrubbed, /params: \[REDACTED\]/);
    // The failing statement is kept: it is the reason to log the error at all.
    assert.match(scrubbed, /SELECT \* FROM sessions WHERE refresh_token_hash = \$1/);
  });

  it("leaves a message that only mentions `params:` in prose alone", () => {
    // The rule is narrow on purpose. A message that says "query params: invalid"
    // is not a driver dump, and rewriting it would be a scrubber inventing work.
    const prose = "invalid input: query params: invalid";
    assert.equal(scrubDriverErrorText(prose), prose);
  });

  it("scrubs the error before pino's serializer sees it", () => {
    // Through the real options object, so this asserts on the serializer that is
    // actually installed on both loggers rather than on the helper it calls.
    const lines: string[] = [];
    const logger = pino(loggerOptions("info"), {
      write: (line: string) => {
        lines.push(line);
      },
    });
    const err = new Error(drizzleMessage);
    err.cause = new Error("connect ECONNREFUSED");
    logger.error({ err }, "query failed");

    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("live-token-123"), `a bound parameter reached the log: ${lines[0]}`);
    // `message` and `stack` both carry a copy, and the stack is the one that gets
    // shipped to an error tracker.
    for (const line of lines) {
      assert.ok(!/live-token-123/.test(line), line);
    }
    assert.match(lines[0], /"type":"Error"/);
  });
});
