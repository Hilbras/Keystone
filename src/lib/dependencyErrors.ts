/**
 * Whether an error means "the database is not reachable".
 *
 * §8.2. The distinction matters because the answer is different in each case.
 * A validation error is the caller's mistake and is a 400. A database that
 * cannot be reached is nobody's mistake and is a 503: the request may well be
 * correct, the server may well be fine, and the right response is to try
 * again. Answering 500 says the opposite — that this server is broken — and
 * it is the answer that makes an outage look like a release gone wrong.
 *
 * The errors are recognised by their SQLSTATE or their Node error code, and
 * they are looked for in the `cause` chain as well as the error itself.
 * Drizzle wraps the driver's error ("Failed query: select ..."), so the
 * Postgres error that actually carries the code is one level down.
 */

/** SQLSTATE class 08 — connection exception. */
const CONNECTION_EXCEPTION = /^08/;

/** SQLSTATE class 57P0 — operator intervention: admin shutdown, crash shutdown, cannot connect now. */
const OPERATOR_INTERVENTION = /^57P0/;

/**
 * SQLSTATEs that mean the server could not be reached or could not give us a
 * connection.
 *
 * - `53300` — too many connections: the pool is exhausted.
 * - `08006` — connection failure.
 * - `57P01` — the database was shut down by an administrator.
 * - `57P02` — crash shutdown.
 * - `57P03` — cannot connect now: the server is starting up.
 * - `25006` — read-only transaction: the database is in recovery.
 * - `40001` — serialization failure: a transaction was rolled back and the
 *   request can be retried, which is a 503 rather than a 500.
 * - `40P01` — deadlock detected: the transaction was aborted and the request
 *   can be retried.
 */
const DATABASE_UNAVAILABLE_CODES = new Set([
  "53300",
  "08006",
  "57P01",
  "57P02",
  "57P03",
  "25006",
  "40001",
  "40P01",
]);

/**
 * Node-level transport errors. These mean the socket could not be made or was
 * lost, which for a database client is the same thing as "not reachable".
 */
const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Whether the error, or anything in its cause chain, is a database outage.
 *
 * The chain is walked rather than the error being inspected once, because the
 * code lives at whichever level the driver put it: a raw `postgres` error has
 * it on itself, a Drizzle error has it on `cause`, and a Fastify error may have
 * wrapped either.
 */
export function isDatabaseUnavailable(error: unknown, depth = 0): boolean {
  // The chain is short in practice; the bound is here so a self-referential
  // cause cannot spin forever.
  if (depth > 5 || !error || typeof error !== "object") return false;

  const code = codeOf(error);
  if (code) {
    if (DATABASE_UNAVAILABLE_CODES.has(code)) return true;
    if (CONNECTION_EXCEPTION.test(code)) return true;
    if (OPERATOR_INTERVENTION.test(code)) return true;
    if (TRANSPORT_CODES.has(code)) return true;
  }

  return isDatabaseUnavailable((error as { cause?: unknown }).cause, depth + 1);
}
