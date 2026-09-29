import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "audit-export-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { auditLog, users } = await import("../../../db/schema.js");
const { hashPassword } = await import("../../../services/secrets/index.js");
const { migrationsFolder } = await import("../../helpers/paths.js");
const { auditLogSubscriber } = await import("../../../services/events/subscribers/auditLog.js");

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Audit-Export-Passw0rd!";

let app: FastifyInstance;
let ownerToken: string;
let ownerId: string;

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();

  const [owner] = await db
    .insert(users)
    .values({
      email: `owner-${RUN_ID}@example.test`,
      username: `own-${RUN_ID}`,
      name: "Audit Export Owner",
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
      isActive: true,
      role: "owner",
    })
    .returning();
  ownerId = owner.id;

  const login = await app.inject({
    method: "POST",
    url: "/auth/token-login",
    payload: { email: owner.email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, `owner login failed: ${login.body}`);
  ownerToken = login.json().accessToken;
});

after(async () => {
  await app?.close();
  await db.delete(auditLog).where(eq(auditLog.userId, ownerId)).catch(() => {});
  await db.delete(users).where(eq(users.id, ownerId)).catch(() => {});
  const { closeDb } = await import("../../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

/**
 * Write an audit row carrying `userAgent`, then export the log.
 *
 * The export reflects rows written *before* the request, so a row created by the
 * export call itself cannot appear in its own output. The row has to exist first.
 *
 * It is written through the audit subscriber rather than by making a request,
 * because this suite is about escaping in the export and has no business
 * depending on the login rate limiter. It originally seeded with a failed login
 * and asserted only that the status was `>= 400`; once the per-address login
 * budget was exhausted by the rest of the suite, the seed started returning 429,
 * a 429 is not audited, and the assertion passed on a row that was never written.
 * That is the same failure mode as everything else this phase found: a test that
 * does not exercise the real path.
 */
let seedCount = 0;

async function exportCsv(userAgent: string): Promise<{ body: string; type: string }> {
  seedCount += 1;
  await auditLogSubscriber({
    type: "user_login_failed",
    version: 1,
    payload: { userAgent, ip: "127.0.0.1", metadata: { marker: `seed-${RUN_ID}-${seedCount}` } },
  } as never);

  // Filtered to the event this test seeds, and with the maximum limit.
  //
  // The export returns the oldest rows first and defaults to 1,000, so against
  // a database the rest of the suite has filled up, a freshly seeded row falls
  // off the end and the assertion fails for a reason that has nothing to do
  // with escaping. Scoping to the event makes the test independent of how much
  // audit traffic exists.
  const response = await app.inject({
    method: "GET",
    url: `/v1/admin/platform/audit-logs/export?event=${encodeURIComponent("user_login_failed:v1")}&limit=10000`,
    headers: { authorization: `Bearer ${ownerToken}`, "user-agent": "audit-export-reader" },
  });
  assert.equal(response.statusCode, 200, `export failed: ${response.body}`);
  return { body: response.body, type: String(response.headers["content-type"]) };
}

/** Split a CSV line into cells, honouring doubled quotes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

describe("Audit log CSV export", () => {
  it("declares a CSV content type", async () => {
    const { type } = await exportCsv("audit-export-test");
    assert.match(type, /text\/csv/, "an export opened in a spreadsheet must be served as CSV");
  });

  // The finding that prompted this suite. Quoting alone does not stop a
  // spreadsheet evaluating a cell that begins with `=`; the leading apostrophe
  // is what forces the value to be treated as text.
  it("neutralises a formula injected through the user agent", async () => {
    const payload = "=cmd|'/c calc'!A1";
    const { body } = await exportCsv(payload);

    const offending = body
      .split("\n")
      .filter((line) => line.includes("calc"))
      .flatMap(cells)
      .filter((cell) => cell.includes("cmd"));

    assert.ok(offending.length > 0, `precondition: the injected value should appear in the export:\n${body.slice(0, 400)}`);
    for (const cell of offending) {
      assert.ok(
        cell.startsWith("'"),
        `a cell beginning with = would be evaluated as a formula when opened; got ${JSON.stringify(cell)}`
      );
    }
  });

  it("neutralises the other formula prefixes", async () => {
    for (const prefix of ["=", "+", "-", "@"]) {
      const { body } = await exportCsv(`${prefix}HYPERLINK("http://evil","click")`);
      const cellsWithPayload = body
        .split("\n")
        .filter((line) => line.includes("HYPERLINK"))
        .flatMap(cells)
        .filter((cell) => cell.includes("HYPERLINK"));
      for (const cell of cellsWithPayload) {
        assert.ok(
          cell.startsWith("'"),
          `prefix ${prefix} would be evaluated as a formula; got ${JSON.stringify(cell)}`
        );
      }
    }
  });

  it("still quotes embedded delimiters and doubled quotes", async () => {
    // No newline: an HTTP header cannot carry one, so it would be stripped
    // before it ever reached the audit row and the test would pass vacuously.
    const { body } = await exportCsv('audit, "quoted" and more');
    assert.ok(
      body.includes('"audit, ""quoted"" and more"'),
      `delimiters and quotes must survive intact:\n${body.slice(0, 400)}`
    );
  });

  it("leaves an ordinary user agent untouched", async () => {
    const agent = "Mozilla/5.0 audit-export";
    const { body } = await exportCsv(agent);
    const cell = body
      .split("\n")
      .filter((line) => line.includes(agent))
      .flatMap(cells)
      .find((c) => c.includes(agent));
    assert.ok(cell, `precondition: the seeded row should be in the export:\n${body.slice(0, 400)}`);
    assert.equal(
      cell,
      agent,
      "a value that is not a formula must not be prefixed; that would corrupt ordinary data"
    );
  });
});
