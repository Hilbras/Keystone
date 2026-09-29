import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { TOTP, Secret } from "otpauth";
import { SoftwareAuthenticator, clonedAssertion } from "../../helpers/softwareAuthenticator.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "webauthn-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// `app.requireHumanPrincipal()` and the step-up check both read this, and the
// suite exercises both paths. Each test file is its own process, so raising it
// here cannot move another suite's budget.
process.env.WEBAUTHN_MAX ||= "1000";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db, closeDb } = await import("../../../db/index.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { hashPassword } = await import("../../../services/secrets/index.js");
const { users, webauthnCredentials } = await import("../../../db/schema.js");
const { migrationsFolder } = await import("../../../lib/paths.js");
const { config } = await import("../../../config.js");

/**
 * WebAuthn, end to end.
 *
 * The whole ceremony, with a software authenticator (`tests/helpers/`): real CBOR,
 * real COSE key, real ECDSA signature, checked by `@simplewebauthn/server` against
 * the real stored public key. Nothing here mocks the verifier, because "the route
 * calls the service" is not the claim worth making about a second factor.
 *
 * The two properties asserted hardest are the ones a mock always skips:
 *
 * - **A challenge is portable between processes.** `createChallenge` writes to a
 *   process-local `Map`, so behind a load balancer a challenge minted on one
 *   container cannot be consumed on another. `docs/DEPLOYMENT.md` recommends
 *   "multiple Keystone containers behind a load balancer" and
 *   `docs/ARCHITECTURE.md` promises "horizontal scaling through Redis-backed
 *   state", so this is a claim the deployment mode breaks. See SEC-050.
 * - **A cloned authenticator is refused.** The signature is genuinely valid — the
 *   key really is the registered key — and the only signal is a sign counter that
 *   went backwards, which is what the relying party is supposed to notice.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "WebAuthn-Passw0rd!";
const ORIGIN = config.AUTH_API_PUBLIC_URL || `http://localhost:${config.PORT}`;
const RP_ID = new URL(ORIGIN).hostname;
const CHALLENGE_COOKIE = "keystone_webauthn_challenge";

const createdUserIds: string[] = [];
let app: FastifyInstance;

/** A fresh authenticator, one per test, so counters cannot leak between cases. */
function authenticator() {
  return new SoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
}

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${RUN_ID}@example.test`,
      username: `${label}${RUN_ID}`.slice(0, 32),
      name: label,
      passwordHash: await hashPassword(PASSWORD),
      ...extra,
    })
    .returning();
  createdUserIds.push(user.id);
  return user;
}

/** Enrol a passkey and return everything needed to sign in with it. */
async function enrol(label: string, userExtra: Record<string, unknown> = {}) {
  const user = await makeUser(label, userExtra);
  const token = await sessionFor(user.email);
  const device = authenticator();

  const optionsRes = await app.inject({
    method: "GET",
    url: "/auth/webauthn/register/options",
    headers: { authorization: `Bearer ${token}` },
  });
  const options = optionsRes.json();
  const credential = device.register({ challenge: options.challenge, user });
  device.remember(credential.id, credential.privateKey);

  const registered = await app.inject({
    method: "POST",
    url: "/auth/webauthn/register/verify",
    headers: {
      authorization: `Bearer ${token}`,
      cookie: `${CHALLENGE_COOKIE}=${cookieFrom(optionsRes)}`,
    },
    payload: { response: { ...credential, privateKey: undefined }, deviceName: label },
  });
  assert.equal(registered.statusCode, 200, registered.body);
  return { user, device, credentialId: credential.id };
}

/**
 * A TOTP-enabled account, with a real secret.
 *
 * Inserted directly rather than enrolled through the API, because enrolling needs
 * a completed session and these tests are about what happens *after* that.
 */
async function totpUser(label: string) {
  const { DrizzleUserRepository } = await import("../../../repositories/index.js");
  // `encryptSecret` from `services/totp.js`, not from `services/secrets`. They are
  // different functions with the same name and different ciphertext formats: the
  // TOTP service has its own synchronous pair, and `verifyUserTotpCode` decrypts
  // with that one. Storing a secret encrypted by the *provider* therefore produces
  // a user whose every code is rejected — which is what the first version of this
  // helper did, and it looked exactly like a wrong code.
  const { encryptSecret, generateSecret, storeBackupCodes, generateBackupCodes } =
    await import("../../../services/totp.js");
  const secret = generateSecret();
  const { hashes } = generateBackupCodes();
  const userRepository = new DrizzleUserRepository();
  // Built the same way `mfa.test.ts` builds one, because that suite's
  // `authedSession` works and this has to produce the same shape. A user
  // assembled any other way gets a 401 MFA_REQUIRED out of `completeMfa`, and
  // the error is swallowed inside `issueTokens` — so the symptom looks like a bad
  // TOTP code and is not one.
  const user = await userRepository.create({
    email: `${label}-${RUN_ID}@example.test`,
    username: `${label}${RUN_ID}`.slice(0, 32),
    name: label,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
  });
  createdUserIds.push(user.id);
  await userRepository.setTotpSecret(user.id, await encryptSecret(secret));
  await storeBackupCodes(user.id, hashes);
  await userRepository.enableTotp(user.id);
  return { user, secret };
}

/** A session with MFA completed, which is the only kind that reaches step-up. */
async function completedSession(email: string, secret: string): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/auth/token-login",
    payload: { email, password: PASSWORD },
  });
  // 401 with a challenge, not 200 with a token. That is the documented
  // `requires_mfa` state and the only thing a TOTP account ever gets from this
  // endpoint.
  assert.equal(login.statusCode, 401, login.body);
  assert.equal(login.json().code, "MFA_REQUIRED", login.body);
  const challenge = login.json().challenge;
  assert.ok(challenge, `expected an MFA challenge for a TOTP account: ${login.body}`);

  const completed = await app.inject({
    method: "POST",
    url: "/auth/mfa/verify",
    payload: {
      challenge,
      code: new TOTP({
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: Secret.fromBase32(secret),
      }).generate(),
    },
  });
  assert.equal(completed.statusCode, 200, completed.body);
  return completed.json().accessToken as string;
}

async function sessionFor(email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/token-login",
    payload: { email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().accessToken as string;
}

/**
 * The challenge cookie from a response.
 *
 * `set-cookie` arrives as a string when there is one cookie and an array when
 * there are several, which is a Node header quirk rather than anything about this
 * route — hence the join, and hence the assertion message carrying the header,
 * because "no challenge cookie" without the header is a debugging dead end.
 */
function cookieFrom(res: { headers: unknown }): string {
  const header = (res.headers as Record<string, string | string[] | undefined>)["set-cookie"];
  const raw = Array.isArray(header) ? header.join(";") : (header ?? "");
  const match = new RegExp(`${CHALLENGE_COOKIE}=([^;]+)`).exec(raw);
  assert.ok(match, `no ${CHALLENGE_COOKIE} cookie in: ${raw || "(no set-cookie header)"}`);
  return match[1];
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
    await db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, id)).catch(() => {});
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  await closeDb().catch(() => {});
  const { redis } = await import("../../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("WebAuthn registration", () => {
  it("completes a real ceremony and stores the credential", async () => {
    const user = await makeUser("wa-register");
    const device = authenticator();
    const token = await sessionFor(user.email);

    const optionsRes = await app.inject({
      method: "GET",
      url: "/auth/webauthn/register/options",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(optionsRes.statusCode, 200, optionsRes.body);
    const options = optionsRes.json();
    assert.equal(options.rp.id, RP_ID, "the options must name the relying party");
    assert.ok(options.challenge, "the options must carry a challenge");

    const credential = device.register({ challenge: options.challenge, user });
    const verifyRes = await app.inject({
      method: "POST",
      url: "/auth/webauthn/register/verify",
      headers: {
        authorization: `Bearer ${token}`,
        cookie: `${CHALLENGE_COOKIE}=${cookieFrom(optionsRes)}`,
      },
      payload: {
        response: { ...credential, privateKey: undefined },
        deviceName: "test key",
      },
    });
    assert.equal(verifyRes.statusCode, 200, verifyRes.body);
    assert.equal(verifyRes.json().success, true);

    const stored = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    assert.equal(stored.length, 1, "registration should store one credential");
    assert.equal(stored[0].credentialId, credential.id);
    assert.equal(stored[0].deviceName, "test key");
    assert.notEqual(
      stored[0].publicKey,
      credential.response.attestationObject,
      "the stored value must be the public key, not the attestation blob"
    );
  });

  it("requires authentication to ask for registration options", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/webauthn/register/options" });
    assert.equal(res.statusCode, 401);
  });

  it("refuses a service account, which has no authenticator", async () => {
    // A service account authenticates with a key it already holds. Letting one
    // "register a passkey" would be a way to mint a second factor with no second
    // factor present.
    const account = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: `svc-${RUN_ID}@example.test`,
        username: `svc${RUN_ID}`.slice(0, 32),
        password: PASSWORD,
        name: "svc",
      },
    });
    assert.ok(account.statusCode < 300, `register: ${account.statusCode} ${account.body}`);

    const res = await app.inject({
      method: "GET",
      url: "/auth/webauthn/register/options",
      headers: { "x-api-key": process.env.KEYSTONE_INTERNAL_API_KEY! },
    });
    assert.ok(
      res.statusCode === 401 || res.statusCode === 403,
      `a machine principal must not start a ceremony; got ${res.statusCode}: ${res.body}`
    );
  });

  it("needs the account's password to add a passkey once TOTP is on", async () => {
    // A stolen, fully-completed session token must not be enough to mint a
    // second factor.
    //
    // The session has to be a *completed* one. A TOTP account gets a challenge
    // from `/auth/token-login`, not an access token, so an unauthenticated helper
    // would stop at the guard and this test would pass without ever reaching the
    // step-up check it is about.
    const { user, secret } = await totpUser("wa-stepup");
    const token = await completedSession(user.email, secret);

    const optionsRes = await app.inject({
      method: "GET",
      url: "/auth/webauthn/register/options",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(optionsRes.statusCode, 200, optionsRes.body);

    const device = authenticator();
    const options = optionsRes.json();
    const credential = device.register({ challenge: options.challenge, user });

    const withoutPassword = await app.inject({
      method: "POST",
      url: "/auth/webauthn/register/verify",
      headers: {
        authorization: `Bearer ${token}`,
        cookie: `${CHALLENGE_COOKIE}=${cookieFrom(optionsRes)}`,
      },
      payload: { response: { ...credential, privateKey: undefined } },
    });
    assert.ok(
      withoutPassword.statusCode >= 400,
      `a session token alone must not be enough; got ${withoutPassword.statusCode} ${withoutPassword.body}`
    );

    const stored = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id));
    assert.equal(stored.length, 0, "and nothing may have been stored");
  });

  it("refuses a challenge issued for a different user", async () => {
    // The challenge carries the user it was minted for. A challenge from another
    // account must not register a credential on this one, or the ceremony is
    // only as private as the cookie jar.
    const alice = await makeUser("wa-chalice");
    const bob = await makeUser("wa-chbob");
    const aliceToken = await sessionFor(alice.email);
    const bobToken = await sessionFor(bob.email);

    const aliceOptions = await app.inject({
      method: "GET",
      url: "/auth/webauthn/register/options",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const device = authenticator();
    const credential = device.register({ challenge: aliceOptions.json().challenge, user: bob });

    const res = await app.inject({
      method: "POST",
      url: "/auth/webauthn/register/verify",
      headers: {
        authorization: `Bearer ${bobToken}`,
        cookie: `${CHALLENGE_COOKIE}=${cookieFrom(aliceOptions)}`,
      },
      payload: { response: { ...credential, privateKey: undefined } },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, "Invalid challenge");
  });
});

describe("WebAuthn authentication", () => {
  it("signs a user in and issues a session", async () => {
    const { user, device, credentialId } = await enrol("wa-authn");

    const optionsRes = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: user.email },
    });
    assert.equal(optionsRes.statusCode, 200, optionsRes.body);
    const assertion = device.authenticate(optionsRes.json(), credentialId);

    const res = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/verify",
      headers: { cookie: `${CHALLENGE_COOKIE}=${cookieFrom(optionsRes)}` },
      payload: { response: assertion },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user.email, user.email);
    assert.ok(res.json().accessToken, "a passkey sign-in must issue an access token");
    assert.ok(res.json().refreshToken, "and a refresh token");
  });

  it("advances the stored sign counter", async () => {
    const { user, device, credentialId } = await enrol("wa-counter");
    const before = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId));
    const counterBefore = before[0].counter;

    const optionsRes = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: user.email },
    });
    const assertion = device.authenticate(optionsRes.json(), credentialId);
    const res = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/verify",
      headers: { cookie: `${CHALLENGE_COOKIE}=${cookieFrom(optionsRes)}` },
      payload: { response: assertion },
    });
    assert.equal(res.statusCode, 200, res.body);

    const after = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId));
    assert.ok(
      after[0].counter > counterBefore,
      `the counter should advance: ${counterBefore} -> ${after[0].counter}`
    );
    assert.ok(after[0].lastUsedAt, "and the credential should record when it was last used");
  });

  it("refuses a cloned authenticator whose counter went backwards", async () => {
    // The signature is genuinely valid — it is the registered key — and the only
    // signal is the sign count. A relying party that does not notice this accepts
    // two assertions from a key that was copied.
    const { user, device, credentialId } = await enrol("wa-clone");
    const stored = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId));
    const registeredCounter = stored[0].counter;

    const optionsRes = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: user.email },
    });
    const assertion = clonedAssertion(
      device,
      optionsRes.json(),
      credentialId,
      registeredCounter
    );
    const res = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/verify",
      headers: { cookie: `${CHALLENGE_COOKIE}=${cookieFrom(optionsRes)}` },
      payload: { response: assertion },
    });
    assert.equal(
      res.statusCode,
      400,
      `a backwards sign counter must be refused; got ${res.statusCode} ${res.body}`
    );
  });

  it("refuses a tampered assertion", async () => {
    const { user, device, credentialId } = await enrol("wa-tamper");
    const optionsRes = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: user.email },
    });
    const assertion = device.authenticate(optionsRes.json(), credentialId);
    // Flip a byte in authenticatorData. The signature covers it, so this must fail
    // for the cryptographic reason rather than for anything a flag check caught.
    const raw = Buffer.from(assertion.response.authenticatorData, "base64url");
    raw[raw.length - 1] ^= 0xff;

    const res = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/verify",
      headers: { cookie: `${CHALLENGE_COOKIE}=${cookieFrom(optionsRes)}` },
      payload: {
        response: { ...assertion, response: { ...assertion.response, authenticatorData: raw.toString("base64url") } },
      },
    });
    assert.equal(res.statusCode, 400, `a tampered assertion must be refused: ${res.body}`);
  });

  it("refuses an assertion for a credential that was never registered", async () => {
    const { user } = await enrol("wa-unknown");
    const optionsRes = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: user.email },
    });
    const stranger = authenticator();
    const strangerCredential = stranger.register({
      challenge: optionsRes.json().challenge,
      user,
    });
    stranger.remember(strangerCredential.id, strangerCredential.privateKey);
    const assertion = stranger.authenticate(optionsRes.json(), strangerCredential.id);

    const res = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/verify",
      headers: { cookie: `${CHALLENGE_COOKIE}=${cookieFrom(optionsRes)}` },
      payload: { response: assertion },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, "Credential not found");
  });

  it("refuses a passkey on a deactivated account", async () => {
    const { user, device, credentialId } = await enrol("wa-deactivated");
    const optionsRes = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: user.email },
    });
    const assertion = device.authenticate(optionsRes.json(), credentialId);

    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));

    const res = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/verify",
      headers: { cookie: `${CHALLENGE_COOKIE}=${cookieFrom(optionsRes)}` },
      payload: { response: assertion },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, "User account is deactivated");
  });

  it("does not reveal whether an address has a passkey", async () => {
    // `/authenticate/options` is unauthenticated, so a differing response for a
    // known address is an account-enumeration oracle. The allow list differs —
    // that is the point of the endpoint — so what must not differ is whether the
    // request succeeds.
    const { user } = await enrol("wa-enum");
    const stranger = `nobody-${RUN_ID}@example.test`;

    const known = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: user.email },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: stranger },
    });
    assert.equal(known.statusCode, 200);
    assert.equal(unknown.statusCode, 200);
    assert.ok(known.json().challenge, "both must issue a challenge");
    assert.ok(unknown.json().challenge);
  });
});

describe("WebAuthn challenges", () => {
  it("refuses a ceremony with no challenge cookie", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/verify",
      payload: { response: { id: "x", rawId: "x", type: "public-key", response: {} } },
    });
    assert.equal(registered.statusCode, 400);
    assert.equal(registered.json().error, "Challenge expired or missing");
  });

  it("is consumed by the first ceremony and refused to the second", async () => {
    const { user, device, credentialId } = await enrol("wa-challenge-once");
    const optionsRes = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: user.email },
    });
    const challenge = cookieFrom(optionsRes);

    const first = device.authenticate(optionsRes.json(), credentialId);
    const ok = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/verify",
      headers: { cookie: `${CHALLENGE_COOKIE}=${challenge}` },
      payload: { response: first },
    });
    assert.equal(ok.statusCode, 200, ok.body);

    const second = device.authenticate(optionsRes.json(), credentialId);
    const replay = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/verify",
      headers: { cookie: `${CHALLENGE_COOKIE}=${challenge}` },
      payload: { response: second },
    });
    assert.equal(replay.statusCode, 400, `a replayed challenge must be refused: ${replay.body}`);
    assert.equal(replay.json().error, "Invalid challenge");
  });

  it("is consumable by a different process than the one that issued it", async () => {
    // The property behind SEC-051.
    //
    // A second import of the module with a cache-busting query string is a second
    // copy of the module registry entry: fresh module state, but the same Redis
    // connection, because the cache buster applies only to the module named. That
    // is the shape of a second container — separate memory, shared Redis and
    // PostgreSQL — and it is what made this test fail before the fix, when the
    // store was a module-level `Map`.
    const { storeChallenge, consumeChallenge } = await import("../../../services/webauthn.js");
    const other = (await import(
      `../../../services/webauthn.js?instance=${RUN_ID}`
    )) as typeof import("../../../services/webauthn.js");

    const challenge = `cross-instance-${RUN_ID}`;
    await storeChallenge(challenge, "11111111-1111-1111-1111-111111111111");

    const consumed = await other.consumeChallenge(challenge);
    assert.ok(
      consumed,
      "a challenge issued by one instance must be consumable by another; " +
        "docs/DEPLOYMENT.md recommends several containers behind a load balancer"
    );
    assert.equal(consumed.userId, "11111111-1111-1111-1111-111111111111");

    // And the second instance's redemption is final for both. A challenge cannot
    // be spent once on each instance.
    assert.equal(
      await consumeChallenge(challenge),
      undefined,
      "a challenge must be single-use across instances too, not once per instance"
    );
  });

  it("is single-use when several ceremonies present it at once", async () => {
    // `GETDEL` rather than `GET` then `DEL`. A read-then-delete is the same race
    // `singleUse.ts` was built to remove, and this is the other credential that
    // could have carried it.
    const { user, device, credentialId } = await enrol("wa-challenge-race");
    const optionsRes = await app.inject({
      method: "POST",
      url: "/auth/webauthn/authenticate/options",
      payload: { email: user.email },
    });
    const challenge = cookieFrom(optionsRes);

    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => {
        const assertion = device.authenticate(optionsRes.json(), credentialId);
        return app.inject({
          method: "POST",
          url: "/auth/webauthn/authenticate/verify",
          headers: { cookie: `${CHALLENGE_COOKIE}=${challenge}` },
          payload: { response: assertion },
        });
      })
    );
    const accepted = attempts.filter((r) => r.statusCode === 200);
    assert.equal(
      accepted.length,
      1,
      `exactly one ceremony may redeem a challenge; ${accepted.length} of ` +
        `${attempts.length} succeeded`
    );
  });

  it("expires a challenge within five minutes", async () => {
    // Asserted on the store's own TTL rather than by waiting five minutes, so the
    // test says something about the bound instead of being slow. Five minutes is
    // the WebAuthn spec's own ceiling for a ceremony and the cookie's `maxAge`
    // matches it, so the cookie cannot outlive the record it points at.
    const { storeChallenge } = await import("../../../services/webauthn.js");
    const { redis } = await import("../../../services/redis.js");
    const challenge = `ttl-${RUN_ID}`;
    await storeChallenge(challenge);

    const ttl = await redis.ttl(`keystone:webauthn:challenge:${challenge}`);
    assert.ok(
      ttl > 0 && ttl <= 300,
      `the stored challenge should expire within five minutes; redis reports ${ttl}s`
    );
  });
});

beforeEach(() => {
  // Nothing to reset — each test creates its own user and authenticator. Stated
  // so the absence of a `beforeEach` is not read as an oversight.
});
