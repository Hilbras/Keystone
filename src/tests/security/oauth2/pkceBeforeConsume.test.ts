import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "pkce-order-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { hashPassword, hashClientSecret, generateClientSecret } = await import(
  "../../../services/secrets/index.js"
);
const { applications, organizations, orgMemberships, users, oauth2AuthorizationCodes } =
  await import("../../../db/schema.js");
const { storeAuthorizationCode, peekAuthorizationCode, consumeAuthorizationCode } =
  await import("../../../services/oauth2.js");

/**
 * SEC-077 — the token endpoint consumed the authorization code *before* it
 * verified the PKCE verifier.
 *
 * A request carrying a wrong `code_verifier` therefore marked the code used. The
 * legitimate client, holding the correct verifier, then found it spent and
 * received `invalid_grant` — indistinguishable from an expired or replayed code,
 * so the failure was undiagnosable and unrecoverable. A failed proof destroyed the
 * thing it was a proof about.
 *
 * **Not an authentication bypass.** An attacker who guesses a code without the
 * verifier still gets nothing: PKCE verification fails, and now the real code
 * survives for its rightful owner. The severity is the availability and
 * diagnosability loss, not a compromise.
 *
 * Every case here goes through the real HTTP endpoint with a real database, so
 * the ordering under test is the ordering that ships.
 */
describe("PKCE is verified before the code is consumed (SEC-077)", () => {
  const REDIRECT = "https://app.example.test/callback";
  const PASSWORD = "Pkce-Order-Passw0rd!";
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdAppIds: string[] = [];

  let app: FastifyInstance;
  let userRepository: { create: Function; findById: Function };
  let user: { id: string; email: string };
  let application: { id: string; clientId: string; clientSecret: string };

  /** A code with a PKCE challenge, the way /authorize would store it. */
  async function issueCode(verifier: string) {
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const { code } = await storeAuthorizationCode({
      appId: application.id,
      userId: user.id,
      challenge,
      challengeMethod: "S256",
      redirectUri: REDIRECT,
      scopes: ["openid"],
    });
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    return { code, codeHash };
  }

  const usedAt = async (codeHash: string) => {
    const [row] = await db
      .select()
      .from(oauth2AuthorizationCodes)
      .where(eq(oauth2AuthorizationCodes.codeHash, codeHash));
    return row?.usedAt ?? null;
  };

  const redeem = (code: string, codeVerifier?: string) =>
    app.inject({
      method: "POST",
      url: "/oauth2/token",
      payload: {
        grant_type: "authorization_code",
        code,
        client_id: application.clientId,
        client_secret: application.clientSecret,
        redirect_uri: REDIRECT,
        ...(codeVerifier === undefined ? {} : { code_verifier: codeVerifier }),
      },
    });

  before(async () => {
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../db/migrations") });
    await loadSigningKeys();
    app = await buildApp();
    // The repository, not a raw insert: `users.username` is `notNull` and has no
    // default, so a hand-written insert has to supply fields the repository
    // derives. Following the existing `oauth2-hardening.test.ts` idiom rather
    // than inventing a second way to make a user.
    userRepository = app.container.userRepository as never;

    const suffix = crypto.randomBytes(4).toString("hex");
    const [org] = await db
      .insert(organizations)
      .values({ name: "PKCE Order Org", slug: `pkce-order-${suffix}` })
      .returning();
    createdOrgIds.push(org.id);

    user = await userRepository.create({
      email: `pkce-${suffix}@example.test`,
      username: `pkce-${suffix}`,
      name: `PKCE ${suffix}`,
      emailVerified: true,
      passwordHash: await hashPassword(PASSWORD),
    });
    createdUserIds.push(user.id);

    await db.insert(orgMemberships).values({ orgId: org.id, userId: user.id, role: "owner" });

    const clientSecret = generateClientSecret();
    const [row] = await db
      .insert(applications)
      .values({
        orgId: org.id,
        name: "PKCE Order App",
        clientId: `pkce-order-${suffix}`,
        clientSecretHash: await hashClientSecret(clientSecret),
        redirectUris: [REDIRECT],
      })
      .returning();
    createdAppIds.push(row.id);
    application = { id: row.id, clientId: row.clientId, clientSecret };

    // **No login, no session, no consent.** This suite calls
    // `storeAuthorizationCode` directly — the same function `/authorize` calls
    // once consent is granted — so the code under test is a granted code by
    // construction. An earlier draft logged in to obtain a session and asserted
    // one existed, which added a login dependency that made every case fail for
    // a reason unrelated to the ordering being measured.
    //
    // The cases still go over real HTTP against a real database, which is the
    // part that matters: the ordering that ships is the ordering under test.
  });

  after(async () => {
    // **In dependency order, and the same teardown the neighbouring suite uses.**
    // The first version deleted the organization before the user, which violates
    // the `org_memberships` foreign key and made the hook throw — so a suite whose
    // seven cases all passed still reported the file as failed with exit 1.
    // Ordering is apps → users → orgs, and each delete is `.catch(() => {})`
    // because a partial fixture should not fail teardown.
    for (const id of createdAppIds) {
      await db.delete(applications).where(eq(applications.id, id)).catch(() => {});
    }
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
    for (const id of createdOrgIds) {
      await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
    }
    await app?.close();
    const { closeDb } = await import("../../../db/index.js");
    await closeDb().catch(() => {});
  });

  it("a wrong code_verifier is rejected", async () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const { code } = await issueCode(verifier);
    const res = await redeem(code, crypto.randomBytes(32).toString("base64url"));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "invalid_grant");
  });

  it("a wrong code_verifier does NOT consume the code", async () => {
    // **The regression.** Before SEC-077 this row came back with a `usedAt`
    // timestamp, and the correct verifier below would then fail with
    // `invalid_grant` for a reason the client could not see.
    const verifier = crypto.randomBytes(32).toString("base64url");
    const { code, codeHash } = await issueCode(verifier);

    const bad = await redeem(code, crypto.randomBytes(32).toString("base64url"));
    assert.equal(bad.statusCode, 400);

    assert.equal(
      await usedAt(codeHash),
      null,
      "a failed PKCE proof must leave the code claimable"
    );
  });

  it("the correct verifier still redeems the same code afterwards", async () => {
    // The other half, and the one that matters operationally: not merely that the
    // code survives, but that a legitimate client holding the right verifier can
    // use it. Without this, "does not consume" could be satisfied by refusing
    // every code.
    const verifier = crypto.randomBytes(32).toString("base64url");
    const { code, codeHash } = await issueCode(verifier);

    const bad = await redeem(code, crypto.randomBytes(32).toString("base64url"));
    assert.equal(bad.statusCode, 400);

    const good = await redeem(code, verifier);
    assert.equal(good.statusCode, 200, `expected a token, got ${good.statusCode} ${good.body}`);
    assert.ok(good.json().access_token, "the redemption must actually issue a token");

    // And the code is spent now, exactly once.
    assert.ok(await usedAt(codeHash), "a successful redemption must consume the code");

    const replay = await redeem(code, verifier);
    assert.equal(replay.statusCode, 400, "a code is single-use");
    assert.equal(replay.json().error, "invalid_grant");
  });

  it("a missing code_verifier does not consume the code either", async () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const { code, codeHash } = await issueCode(verifier);
    const res = await redeem(code); // no verifier at all
    assert.equal(res.statusCode, 400);
    assert.equal(
      await usedAt(codeHash),
      null,
      "omitting the verifier must not burn the code for the real client"
    );
  });

  it("peek reads without consuming, and consume is what spends it", async () => {
    // The two primitives the endpoint now composes, asserted separately so the
    // ordering above is not the only thing being measured.
    const verifier = crypto.randomBytes(32).toString("base64url");
    const { code, codeHash } = await issueCode(verifier);

    const peeked = await peekAuthorizationCode(code, application.id, REDIRECT);
    assert.ok(peeked, "peek must find a claimable code");
    assert.equal(await usedAt(codeHash), null, "peek must not consume");

    const consumed = await consumeAuthorizationCode(code, application.id, REDIRECT);
    assert.ok(consumed, "consume must find the same code");
    assert.ok(await usedAt(codeHash), "consume must spend it");

    assert.equal(
      await peekAuthorizationCode(code, application.id, REDIRECT),
      undefined,
      "a spent code is no longer peekable"
    );
    assert.equal(
      await consumeAuthorizationCode(code, application.id, REDIRECT),
      undefined,
      "a spent code cannot be consumed twice"
    );
  });

  it("a wrong redirect_uri does not consume the code", async () => {
    // The same principle for the other pre-consume rejection: a mismatched
    // redirect URI must not let an attacker with a stolen code destroy it.
    const verifier = crypto.randomBytes(32).toString("base64url");
    const { code, codeHash } = await issueCode(verifier);
    const res = await app.inject({
      method: "POST",
      url: "/oauth2/token",
      payload: {
        grant_type: "authorization_code",
        code,
        client_id: application.clientId,
        client_secret: application.clientSecret,
        redirect_uri: "https://attacker.example.test/callback",
        code_verifier: verifier,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await usedAt(codeHash), null, "a redirect mismatch must not consume");
  });

  it("the endpoint peeks before it consumes", async () => {
    // Structural, and the assertion that catches the ordering being undone by a
    // refactor that leaves every behavioural case green — a change that moved the
    // consume back above the PKCE check would still pass the behaviour cases if
    // the codes involved happened not to collide in one run.
    //
    // Searched from the **call site**, not the first occurrence of the name: the
    // compiled module's import statement mentions both functions on one line, so
    // a plain `indexOf` finds `consumeAuthorizationCode` in the import list and
    // reports the consume as happening first. The first version of this assertion
    // did exactly that and failed against correct code.
    // **From the compiled location, not the source tree.** This file runs from
    // `dist/tests/security/oauth2/`, so `../../../dist/routes/oauth2.js` resolves
    // to `dist/dist/routes/oauth2.js` and throws ENOENT. The first version used
    // the path that is correct in `src/` and failed only in the compiled run —
    // which is where it actually runs.
    const route = readFileSync(
      path.resolve(__dirname, "../../../routes/oauth2.js"),
      "utf8"
    );
    const peek = route.indexOf("await peekAuthorizationCode(");
    const consume = route.indexOf("await consumeAuthorizationCode(");
    assert.ok(peek !== -1, "the endpoint must peek");
    assert.ok(consume !== -1, "the endpoint must still consume");
    assert.ok(
      peek < consume,
      `the peek (${peek}) must precede the consume (${consume})`
    );
  });
});
