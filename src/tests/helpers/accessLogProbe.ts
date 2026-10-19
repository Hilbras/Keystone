import crypto from "node:crypto";

/**
 * Serve two requests that carry a secret in the query string, and let the real
 * access log land on stdout.
 *
 * §5.1 says never to log an OAuth code or an access token. The largest source of
 * both was `request.url`, which every HTTP access log records: Keystone consumes a
 * magic-link token straight out of the query string, and that token *is* the
 * authentication, so a log line was a durable, searchable record of a live
 * credential. Read the counterpart in `tests/observability/logging.test.ts`, which
 * asserts on this process's output.
 *
 * **A separate process, because a pino destination is not swappable in-process.**
 * `buildApp` builds its own logger — that is the point of the test, since the
 * production wiring is what must be correct — and pino writes to file descriptor 1
 * through a buffered stream it captures at construction. Replacing
 * `process.stdout.write` would not intercept a single byte of it, and asserting on
 * the line without capturing the line is asserting nothing. As a child process,
 * stdout *is* the destination, which is also how a container collects it.
 *
 * The two requests are chosen for what they prove together:
 *
 * - `GET /auth/magic-link/verify?token=…` is the real route the leak was on. It is
 *   a 400 with a bogus token — the request that matters is one an attacker would
 *   send, and it goes down the same handler as a valid one.
 * - A route registered here answers `{ error, code }`, which no unauthenticated
 *   built-in route does, so `errorCode` on the access line is asserted against a
 *   real response body rather than against a hand-built log argument.
 *
 * Invoked as: node dist/tests/helpers/accessLogProbe.js
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.KEYSTONE_INTERNAL_API_KEY = process.env.KEYSTONE_INTERNAL_API_KEY ?? "access-log-probe";
process.env.KEYSTONE_ENCRYPTION_KEY =
  process.env.KEYSTONE_ENCRYPTION_KEY ?? "0123456789abcdef0123456789abcdef";
// The line under test is emitted at `info`, which is the default in production and
// would be silenced by a level set for a quieter suite.
process.env.KEYSTONE_LOG_LEVEL = "info";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const SECRET = process.env.PROBE_SECRET ?? crypto.randomBytes(24).toString("hex");

const { buildApp } = await import("../../index.js");

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  app = await buildApp();

  app.get("/__access-log-probe/with-code", async (_request, reply) =>
    reply.status(400).send({ error: "probe", code: "PROBE_ERROR_CODE" })
  );

  await app.ready();

  await app.inject({
    method: "GET",
    url: `/auth/magic-link/verify?token=${SECRET}`,
  });
  await app.inject({
    method: "GET",
    url: `/__access-log-probe/with-code?token=${SECRET}`,
  });
} catch (err) {
  // A boot failure is a legitimate outcome for the caller to see, and a bare stack
  // trace in the middle of a log-filled stdout is harder to diagnose than this.
  console.error(`accessLogProbe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 3;
} finally {
  await app?.close().catch(() => {});
  // Explicit: the app holds Redis and PostgreSQL connections, and a process that
  // lingers would make the caller wait for the spawn timeout instead of failing.
  process.exit(process.exitCode ?? 0);
}
