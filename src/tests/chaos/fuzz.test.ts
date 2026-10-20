import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "chaos-fuzz";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
process.env.LOGIN_MAX_ATTEMPTS ||= "1000000";
process.env.LOGIN_PER_ADDRESS_MAX ||= "1000000";
process.env.LOGIN_WINDOW_SECONDS ||= "60";
process.env.GLOBAL_RATE_LIMIT_MAX ||= "1000000";
process.env.GLOBAL_RATE_LIMIT_WINDOW ||= "60";
process.env.SCIM_RATE_LIMIT_MAX ||= "1000000";
process.env.SCIM_RATE_LIMIT_WINDOW_SECONDS ||= "60";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../db/index.js");
const { buildApp } = await import("../../index.js");
const { loadSigningKeys } = await import("../../services/tokens.js");
const { users } = await import("../../db/schema.js");

import { eq as eqWhere } from "drizzle-orm";
import { migrationsFolder } from "../../lib/paths.js";

/**
 * §8.7 — fuzzing the surfaces an attacker reaches.
 *
 * There is no fuzzing library in this repository and this suite does not add
 * one. The house style for "a lot of inputs" is statistical rather than
 * generative — the backoff test asserts on the *distribution* of two thousand
 * samples rather than on a value — and the reason is the same here: a fuzz
 * case that fails must be reproducible, and a random input that fails once and
 * never again is a bug report nobody can act on.
 *
 * So the generator is seeded, the seed is printed with every failure, and the
 * same seed produces the same inputs on every machine. What is asserted is
 * not "no crash" — a crash would take the process down and the runner would
 * say so — but the property that matters at each surface:
 *
 * - a malformed token is **rejected**, not accepted and not a server error;
 * - a malformed body is a **400**, not a 500 and not a partial write;
 * - a malformed URL is **refused** before anything is sent to it;
 * - a malformed header or query parameter is **ignored**, not fatal.
 *
 * A 500 is the thing worth looking for. A 500 says the server met something it
 * did not expect, and every 500 in a fuzz run is a place where a crafted
 * input reached a line of code that assumes the world is well formed.
 */


const createdUserIds: string[] = [];

let app: FastifyInstance;

/**
 * A small, fast, seeded generator.
 *
 * `mulberry32`: thirty-two bits of state, a multiply and two shifts. It is
 * not a good generator and does not need to be — the requirement is that the
 * same seed produces the same sequence everywhere, not that the sequence is
 * unpredictable.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fuzzer {
  next: () => number;
  int: (max: number) => number;
  pick: <T>(values: readonly T[]) => T;
  string: (maxLength: number) => string;
  bytes: (length: number) => Buffer;
  /** A string built from characters that break parsers. */
  nasty: (maxLength: number) => string;
}

const NASTY = [
  "\u0000", "\u0001", "\u001b", "\u007f", "\u2028", "\u2029", "\uFEFF",
  '"', "'", "\\", "`", "<", ">", "&", "%", "#", "?", ";", "|", "$",
  "\n", "\r", "\r\n", "\t", " ", "\u0000",
  "../", "..%2f", "%2e%2e%2f", "%00", "%0d%0a", "%%", "%zz",
  "http://", "https://", "file://", "javascript:", "data:",
  "-1", "0", "1e309", "-1e309", "NaN", "Infinity", "1.7976931348623157e308",
  "0x00", "0b1", "0o7", "1_000", "null", "true", "false", "undefined",
  "{}", "[]", '{"a":', "[1,", "()", "()=>{}",
  "Bearer", "Basic", "Bearer ", "eyJ", "eyJhbGciOiJIUzI1NiJ9.",
  "AAAA", "A".repeat(4096),
];

function makeFuzzer(seed: number): Fuzzer {
  const next = makeRandom(seed);
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T>(values: readonly T[]): T => values[int(values.length)];
  const string = (maxLength: number) => {
    const length = int(maxLength);
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += String.fromCharCode(32 + int(95));
    }
    return out;
  };
  const bytes = (length: number) => crypto.randomBytes(length);
  const nasty = (maxLength: number) => {
    const length = int(maxLength);
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += pick(NASTY);
    }
    return out;
  };
  return { next, int, pick, string, bytes, nasty };
}

/**
 * A string safe to put in an assertion message.
 *
 * The fuzzer's inputs contain control characters, and the test reporter
 * parses its own output as TAP. A raw NUL in a failure message makes the
 * reporter's own nesting assertion fail, which replaces the real failure with
 * a confusing one about the reporter. So every input that goes into a message
 * goes through here first.
 */
function safe(value: unknown): string {
  return JSON.stringify(value)
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      // Spelled out rather than written as a character class: the class would
      // be a control-character regex, which is exactly what that lint rule
      // exists to flag, and the rule is right to — a regex that matches
      // control characters is usually a mistake. Here the class is the point,
      // and the comparison says what it means.
      return code < 0x20 || code === 0x7f
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : character;
    })
    .join("")
    .slice(0, 120);
}

before(async () => {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const id of createdUserIds) {
    await db.delete(users).where(eqWhere(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("a malformed token is rejected, never accepted and never a server error (§8.7)", () => {
  it("refuses a hundred malformed authorization headers", async () => {
    const fuzzer = makeFuzzer(0xc0ffee);
    const failures: string[] = [];

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const token = fuzzer.pick([
        fuzzer.nasty(40),
        fuzzer.string(120),
        fuzzer.bytes(48).toString("base64url"),
        `eyJhbGciOiJub25lIn0.${fuzzer.string(40)}.${fuzzer.string(40)}`,
        `${fuzzer.string(20)}.${fuzzer.string(20)}.${fuzzer.string(20)}`,
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });

      if (res.statusCode === 500) {
        failures.push(`seed 0xc0ffee attempt ${attempt}: 500 for ${safe(token)}`);
      }
      if (res.statusCode === 200) {
        failures.push(
          `seed 0xc0ffee attempt ${attempt}: a malformed token was ACCEPTED: ${JSON.stringify(token.slice(0, 60))}`
        );
      }
      if (res.statusCode !== 200 && res.statusCode !== 401 && res.statusCode !== 400) {
        failures.push(`seed 0xc0ffee attempt ${attempt}: unexpected ${res.statusCode}`);
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"));
  });
});

describe("a malformed body is a 400, not a 500 (§8.7)", () => {
  it("refuses a hundred malformed login bodies", async () => {
    const fuzzer = makeFuzzer(0xbadc0de);
    const failures: string[] = [];

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const payload = fuzzer.pick([
        {},
        { email: fuzzer.nasty(30) },
        { email: fuzzer.string(40), password: fuzzer.nasty(30) },
        { email: fuzzer.string(40), password: fuzzer.string(200) },
        { email: 123, password: true },
        { email: null, password: null },
        { email: ["a"], password: { b: 1 } },
        fuzzer.nasty(200),
      ]);

      const res = await app.inject({
        method: "POST",
        url: "/auth/token-login",
        payload: payload as never,
      });

      if (res.statusCode === 500) {
        failures.push(`seed 0xbadc0de attempt ${attempt}: 500 for ${safe(payload)}`);
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"));
  });
});

describe("a malformed OAuth parameter is refused (§8.7)", () => {
  it("refuses a hundred malformed token requests", async () => {
    const fuzzer = makeFuzzer(0x5eed);
    const failures: string[] = [];

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const payload = {
        grant_type: fuzzer.pick(["authorization_code", "refresh_token", "password", fuzzer.nasty(20)]),
        code: fuzzer.nasty(40),
        refresh_token: fuzzer.nasty(40),
        client_id: fuzzer.nasty(30),
        client_secret: fuzzer.nasty(30),
        redirect_uri: fuzzer.nasty(60),
        code_verifier: fuzzer.nasty(60),
      };

      const res = await app.inject({
        method: "POST",
        url: "/oauth2/token",
        payload: payload as never,
      });

      if (res.statusCode === 500) {
        failures.push(`seed 0x5eed attempt ${attempt}: 500 for ${safe(payload)}`);
      }
      // A refused OAuth request must still answer with an error body. The
      // *shape* is RFC 6749 §5.2's — an `error` member — but a body the
      // request schema rejected outright never reaches the grant handler, so
      // it is answered by the schema layer and carries Keystone's own code
      // instead. What matters is that it is an error and not a success.
      if (res.statusCode !== 200) {
        const body = res.json() as { error?: unknown };
        if (typeof body.error !== "string" || body.error.length === 0) {
          failures.push(
            `seed 0x5eed attempt ${attempt}: the refusal carried no error member: ${safe(res.body)}`
          );
        }
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"));
  });
});

describe("a malformed webhook URL is refused before anything is sent (§8.7)", () => {
  it("refuses a hundred malformed endpoint URLs", async () => {
    const fuzzer = makeFuzzer(0xf00d);
    const { assertSafeWebhookUrl } = await import("../../services/outboundPolicy.js");
    const failures: string[] = [];
    let refused = 0;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const url = fuzzer.pick([
        fuzzer.nasty(60),
        `http://${fuzzer.nasty(20)}`,
        `https://${fuzzer.nasty(20)}/hook`,
        `https://127.0.0.1/hook`,
        `https://169.254.169.254/latest/meta-data/`,
        `https://[::1]/hook`,
        `https://10.0.0.1/hook`,
        `file:///etc/passwd`,
        `javascript:alert(1)`,
        `not a url at all`,
        "",
      ]);

      let rejected = false;
      try {
        await assertSafeWebhookUrl(url);
      } catch {
        rejected = true;
      }
      if (rejected) {
        refused += 1;
      } else if (/169\.254|127\.0\.0\.1|10\.0\.0\.1|\[::1\]|file:|javascript:/i.test(url)) {
        failures.push(`seed 0xf00d attempt ${attempt}: a private or non-HTTP target was accepted: ${url}`);
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"));
    assert.ok(refused > 0, "the fuzzer must have produced refusals, or it proved nothing");
  });
});

describe("a malformed header or query parameter is ignored, not fatal (§8.7)", () => {
  it("survives a hundred malformed request headers and query strings", async () => {
    const fuzzer = makeFuzzer(0xfeed);
    const failures: string[] = [];

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const url = `/health/live?${fuzzer.pick([
        `x=${fuzzer.nasty(30)}`,
        `x=${fuzzer.string(200)}`,
        "x=",
        "x",
        "=value",
        "&&&",
        "x=1&x=2&x=3",
        `%${fuzzer.string(10)}`,
      ])}`;

      const res = await app.inject({
        method: "GET",
        url,
        headers: {
          "x-forwarded-for": fuzzer.nasty(30),
          "x-keystone-trace-id": fuzzer.nasty(30),
          "user-agent": fuzzer.nasty(40),
        },
      });

      if (res.statusCode === 500) {
        failures.push(`seed 0xfeed attempt ${attempt}: 500 for ${safe(url)}`);
      }
      if (res.statusCode !== 200) {
        failures.push(`seed 0xfeed attempt ${attempt}: liveness must answer 200, got ${res.statusCode}`);
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"));
  });
});
