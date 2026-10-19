/**
 * What may never reach a log line, and the one place that decides it.
 *
 * §5.1 lists the values that must never be logged — passwords, access and refresh
 * tokens, API secrets, OAuth codes, webhook secrets — and a list like that only
 * holds if there is exactly one implementation of it. A per-call-site rule ("don't
 * log the token here") is not a rule at all: it is a promise that every future
 * call site will remember, and the reason secrets end up in logs is that one of
 * them eventually does not.
 *
 * So the decision is made once, here, and applied by the logger itself rather than
 * by the code that calls it (see `hooks.logMethod` in `lib/logger.ts`). A handler
 * that logs `{ password }` in full gets a redacted line without knowing this file
 * exists.
 *
 * ## Why not pino's `redact`
 *
 * pino's built-in `redact` takes a list of *paths*, and a path is a fixed shape.
 * Measured against the installed version, `*.password` matches exactly one level
 * — `{ body: { password } }` is redacted, `{ a: { b: { password } } }` is not —
 * and wildcards do not descend into arrays at all, so `{ items: [{ password }] }`
 * survives. Credentials in this codebase are nested to whatever depth the payload
 * happens to have, so a path list would be a list of the shapes someone thought
 * of. The hook below walks the value instead, which is the only form of the rule
 * that does not depend on guessing the shape in advance.
 *
 * ## Why the match is on key names
 *
 * Values cannot be recognised — a refresh token is an opaque string, and a
 * heuristic ("looks random") would censor request ids and hashes as readily as
 * secrets, which is a worse failure than the one it prevents. Key names are the
 * only signal available, so the rule is a substring match on the normalised name:
 * `refreshToken`, `refresh_token` and `x-refresh-token` are one entry, and
 * `passwordHash` is caught by the same rule that catches `password` because a
 * hash of a password is not publishable either.
 */

export const REDACTED = "[REDACTED]";

/**
 * Case- and separator-insensitive fragments that mark a value as unpublishable.
 *
 * Substrings rather than exact names on purpose. The cost of a false positive is a
 * censored debug field; the cost of a false negative is a live credential in a log
 * aggregator, which cannot be un-shipped.
 *
 * `code` is deliberately absent. It is this codebase's error contract —
 * `{ error, code }` — and §5.1 asks for `errorCode` on every operation, so
 * redacting the key named `code` would delete the field the same requirement asks
 * for. OAuth authorization codes never arrive under that name in a structured log
 * field either; they arrive as a query parameter, which is `stripQuery`'s job.
 */
const SENSITIVE_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "credential",
  "authorization",
  "cookie",
  "signature",
  "otp",
  "session",
  "recoverycode",
  "backupcode",
] as const;

/** Lower-case and drop everything that is not alphanumeric: `x-api-key` → `xapikey`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveLogKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Bounds on the walk.
 *
 * A log call is on the hot path of everything, and an unbounded recursive walk of
 * an arbitrary object is how a log line turns into a stall. Both limits are far
 * above the shapes this codebase logs — the deepest is a payload nested three or
 * four levels — so the effect of hitting them is that a pathological value is
 * logged as-is past the limit rather than that a normal one is missed.
 */
const MAX_DEPTH = 8;
const MAX_NODES = 1000;

interface WalkState {
  /** Breaks cycles; a payload that references itself must not spin the walk. */
  seen: WeakSet<object>;
  budget: number;
}

/**
 * Plain objects only.
 *
 * An `Error`, a `Date`, a `Buffer`, a `Map` or a Fastify request is not something
 * to walk into: it has accessors, prototypes and internal state, and copying it
 * would either lose the shape pino's serializers rely on or produce a log line
 * about the sanitizer instead of about the request. Anything that is not a plain
 * object or an array is returned untouched, and is redacted only if its *key* is
 * sensitive.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function walk(value: unknown, depth: number, state: WalkState): unknown {
  if (depth >= MAX_DEPTH || state.budget <= 0) return value;

  if (Array.isArray(value)) {
    if (state.seen.has(value)) return value;
    state.seen.add(value);
    let changed = false;
    const out = value.map((item) => {
      state.budget -= 1;
      const next = walk(item, depth + 1, state);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  if (!isPlainObject(value)) return value;
  if (state.seen.has(value)) return value;
  state.seen.add(value);

  // Copied lazily: an object with nothing sensitive in it is handed to pino by
  // reference, so the common log line costs a walk and no allocation.
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    state.budget -= 1;
    const original = value[key];
    const next = isSensitiveLogKey(key) ? REDACTED : walk(original, depth + 1, state);
    if (next !== original && copy === undefined) copy = { ...value };
    if (copy !== undefined) copy[key] = next;
  }
  return copy ?? value;
}

/**
 * Remove every value under a sensitive key, at any depth.
 *
 * Returns a new object only when something actually changed.
 */
export function sanitizeLogValue(value: unknown): unknown {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  return walk(value, 0, { seen: new WeakSet(), budget: MAX_NODES });
}

/**
 * The request path, with the query string dropped.
 *
 * This is the second half of the same requirement, and the load-bearing half —
 * more credentials reach logs through the URL than through any field. Keystone
 * takes live, single-use credentials in the query string in four places:
 * `GET /auth/magic-link/verify?token=…` and
 * `GET /auth/email-verification/verify?token=…` consume a token that is the whole
 * of the authentication, and `GET /federation/:provider/callback?code=…` and
 * `GET /sso/oidc/:connectionId/callback?code=…` receive an authorization code.
 *
 * Every HTTP server's access log records the request target, and a request target
 * includes the query string, so without this the access log is a durable, indexed,
 * full-text-searchable transcript of live credentials — for the magic-link route,
 * a log line is enough to sign in as the user until the token is consumed. The
 * query values are dropped rather than redacted: `?token=[REDACTED]` still records
 * the length and position of the value, and nothing that reads these logs needs
 * the query string to identify a request — the path and the trace id do that.
 *
 * Accepts an absent target because all four call sites pass one that can be
 * absent. `FastifyRequest.url` is typed as always present, but a request object
 * assembled by hand — a test double, an internal call, a hook that runs before
 * routing has populated the field — need not carry it, and the four callers treat
 * a missing `url` as "no query string to strip" rather than as an error. This was
 * measured, not assumed: the rate limiter's refusal path threw `TypeError` on
 * `url.length` inside a `try`/`catch` whose comment said a monitoring failure must
 * not turn a 429 into a 500, so the throw was swallowed and the
 * `rate_limit_triggered` event was silently never emitted — the security-control
 * event disappeared at exactly the moment the control fired. Returning `""` keeps
 * the function total, which is the property the callers rely on.
 */
export function stripQuery(url: string | undefined): string {
  if (!url) return "";
  let end = url.length;
  const query = url.indexOf("?");
  if (query !== -1) end = query;
  const fragment = url.indexOf("#");
  if (fragment !== -1 && fragment < end) end = fragment;
  return url.slice(0, end);
}

/**
 * Remove the SQL driver's bound-parameter list from an error message.
 *
 * The third way a secret reaches a log, and the one that does not look like a
 * secret at all. `DrizzleQueryError` builds its message as:
 *
 * ```text
 * Failed query: SELECT * FROM sessions WHERE refresh_token_hash = $1
 * params: live-token-123
 * ```
 *
 * Measured, not read out of the source: `drizzle-orm/errors.js` interpolates the
 * parameter *values* into the message, and pino's error serializer copies the
 * message into `message` **and** into `stack`, flattening the cause chain into
 * both. So `logger.error({ err })` — the natural way to log a failed query —
 * publishes the query text with its arguments filled in, and the arguments are
 * whatever the call site passed: a refresh token, an authorization code, an API
 * key, a password hash. None of them appear under a key the scrubber above can
 * recognise, because they are inside a string.
 *
 * The same message is what readiness and diagnostics return to their callers, so
 * this is applied there too rather than only in the logger.
 *
 * The rule is deliberately narrow — the literal `\nparams: ` line that Drizzle's
 * own message format produces — so it cannot censor an unrelated message that
 * happens to mention the word. The query text itself is kept: it identifies the
 * failing statement, which is the reason to log the error at all.
 */
export function scrubDriverErrorText(text: string): string {
  if (!text.includes("\nparams: ")) return text;
  return text.replace(/\nparams: [^\n]*/g, "\nparams: [REDACTED]");
}

