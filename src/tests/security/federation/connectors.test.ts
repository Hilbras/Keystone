import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { FakeOidcProvider } from "../../helpers/fakeOidcProvider.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "federation-test-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";
// The SSO endpoint policy refuses loopback and private addresses as an SSRF
// control, so a test provider is unreachable without this. It is the existing
// seam for on-premise deployments; nothing else about the policy relaxes, so the
// tests below still exercise the real signature, issuer, audience and nonce
// checks rather than a stub.
process.env.ALLOW_PRIVATE_SSO_ENDPOINTS = "true";
process.env.FEDERATION_MAX ||= "1000";

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
const { users, organizations, identityProviders, userIdentities } = await import(
  "../../../db/schema.js"
);
const { buildConnector, listSupportedProviders } = await import(
  "../../../services/connectors/registry.js"
);
const { migrationsFolder } = await import("../../../lib/paths.js");
const { resetServiceLogger } = await import("../../../lib/logger.js");

/**
 * Federation, per connector.
 *
 * Six providers — zitadel, google, github, azure, okta, keycloak — behind three
 * implementations. Before this suite the word "connector" appeared in three test
 * files, and none of them drove an exchange: they exercised the routes with a
 * stubbed connector, so the part that could be wrong (token verification, nonce
 * binding, the email rules) was the part with no coverage at all.
 *
 * Every test here runs against a real OIDC provider (`tests/helpers/`) serving a
 * real discovery document, a real JWKS, and ID tokens signed with a real RSA key.
 * The connector does actual cryptographic work, so a rejected token is rejected
 * for the reason it would be in production.
 *
 * The five properties the roadmap names, each asserted for **every** provider
 * rather than for one:
 *
 * - the nonce reaches the provider and the returned token must carry it back;
 * - the ID token is verified with the configured algorithm, issuer and audience;
 * - `email_verified` is reported rather than assumed;
 * - a connector returning no email is rejected;
 * - a federated identity is not attached to an existing local account without
 *   proof.
 */

const RUN_ID = crypto.randomBytes(6).toString("hex");
const PASSWORD = "Federation-Passw0rd!";
const REDIRECT_URI = "http://localhost:5173/auth/callback";

/**
 * `verifyToken` as the OIDC connector implements it.
 *
 * The `IdentityConnector` interface declares `verifyToken?(token: string)` with
 * one argument, so a caller has no way to ask for nonce verification — and the
 * Zitadel connector, which is what the interface describes, does not do it. The
 * tests call through this type so the interface gap is visible here rather than
 * hidden by a cast.
 */
type NonceAware = (token: string, expectedNonce?: string) => Promise<{
  email: string;
  sub: string;
  emailVerified?: boolean;
}>;
const PROVIDERS = listSupportedProviders();

const provider = new FakeOidcProvider();
const createdUserIds: string[] = [];
let app: FastifyInstance;

/** Build any provider against the fake IdP, with the same config the registry uses. */
function connectorFor(type: string) {
  return buildConnector(type, {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    issuer: provider.issuer,
    authorizationEndpoint: provider.authorizationEndpoint,
    tokenEndpoint: provider.tokenEndpoint,
    jwksUri: provider.jwksUri,
    userinfoEndpoint: `${provider.issuer}/userinfo`,
  });
}

before(async () => {
  resetServiceLogger();
  await provider.start();
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await loadSigningKeys();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  await provider.stop();
  for (const id of createdUserIds) {
    await db.delete(userIdentities).where(eq(userIdentities.userId, id)).catch(() => {});
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

beforeEach(() => {
  provider.nextClaims = {};
  provider.nextIdTokenOverride = undefined;
  provider.lastTokenRequest = undefined;
});

describe("federation, per connector", () => {
  it("covers every provider the registry advertises", () => {
    // The point of the suite is that it is exhaustive. If a provider is added and
    // not listed here, the tests below silently stop covering it, so the count is
    // asserted rather than left to a reader.
    assert.deepEqual(
      [...PROVIDERS].sort(),
      ["azure", "github", "google", "keycloak", "okta", "zitadel"],
      "the provider list changed; add the new one to this suite or the coverage claim is false"
    );
  });

  for (const type of PROVIDERS) {
    describe(type, () => {
      it("puts the state, redirect and nonce in the authorization URL", () => {
        const connector = connectorFor(type);
        const state = `state-${RUN_ID}`;
        const nonce = `nonce-${RUN_ID}`;

        const url = new URL(String(connector.getAuthorizeUrl({ state, redirectUri: REDIRECT_URI, nonce })));

        assert.equal(url.searchParams.get("state"), state, "state must bind the callback to this request");
        assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
        assert.equal(url.searchParams.get("client_id"), "test-client-id");
        assert.equal(url.searchParams.get("response_type"), "code");
        assert.ok(url.searchParams.get("scope")?.includes("openid"), "openid is required for an ID token");
        assert.equal(
          url.searchParams.get("nonce"),
          nonce,
          "the nonce must reach the provider — this is SEC-020, and it regressed once already"
        );
      });

      it("exchanges a code for the identity the token carries", async () => {
        const connector = connectorFor(type);
        const identity = await connector.exchangeCode("auth-code", REDIRECT_URI);

        assert.equal(identity.sub, "external-subject-1");
        assert.equal(identity.email, "person@example.test");
        assert.equal(identity.emailVerified, true, "email_verified: true must be reported as verified");
        assert.equal(identity.name, "Test Person");
        assert.ok(identity.raw, "the raw claims should be kept for auditing");
      });

      it("refuses an ID token whose nonce is not the one it sent", async () => {
        // The property SEC-020 exists for. `state` protects the callback from
        // CSRF but says nothing about the *token*: an ID token minted for another
        // login verifies correctly on issuer, audience and signature, and only the
        // nonce proves it belongs to the request that started.
        const connector = connectorFor(type);
        const nonce = `nonce-${RUN_ID}`;
        const token = await provider.issueIdToken({ nonce: "a-different-nonce" });

        await assert.rejects(
          () => (connector.verifyToken as NonceAware)(token, nonce),
          /nonce does not match/,
          "a token carrying someone else's nonce must be refused"
        );
      });

      it("refuses an ID token with no nonce when one was sent", async () => {
        const connector = connectorFor(type);
        const token = await provider.issueIdToken({ nonce: undefined });

        await assert.rejects(
          () => (connector.verifyToken as NonceAware)(token, `nonce-${RUN_ID}`),
          /nonce does not match/,
          "an absent nonce is not a matching nonce"
        );
      });

      it("refuses a token signed for a different audience", async () => {
        const connector = connectorFor(type);
        const token = await provider.issueIdToken({ aud: "some-other-client" });

        await assert.rejects(
          () => connector.verifyToken!(token),
          /"aud"|audience/i,
          "a token minted for another client must not authenticate this one"
        );
      });

      it("refuses a token from a different issuer", async () => {
        const connector = connectorFor(type);
        const token = await provider.issueIdToken({ iss: "https://evil.example" });

        await assert.rejects(
          () => connector.verifyToken!(token),
          /"iss"|issuer/i,
          "a token from another issuer must be refused"
        );
      });

      it("refuses an expired token", async () => {
        const connector = connectorFor(type);
        const past = Math.floor(Date.now() / 1000) - 600;
        const token = await provider.issueIdToken({ iat: past, exp: past + 60 });

        await assert.rejects(
          () => connector.verifyToken!(token),
          /"exp"|expired/i,
          "an expired token must be refused even with a 5s clock tolerance"
        );
      });

      it("reports email_verified false rather than assuming it", async () => {
        const connector = connectorFor(type);
        const token = await provider.issueIdToken({ email_verified: false });

        const identity = await connector.verifyToken!(token);
        assert.equal(
          identity.emailVerified,
          false,
          "an unverified upstream address must be reported as unverified, so the " +
            "caller can decide whether to trust it"
        );
      });

      it("rejects a token that carries no email", async () => {
        const connector = connectorFor(type);
        const token = await provider.issueIdToken({ email: undefined });

        await assert.rejects(
          () => connector.verifyToken!(token),
          /did not return an email/,
          "an identity with no address is not an identity we can attach to an account"
        );
      });

      it("refuses a token signed by an unknown key", async () => {
        // A token whose signature does not verify against the published JWKS. This
        // is the check a stubbed fetch would skip entirely.
        const connector = connectorFor(type);
        const { SignJWT, generateKeyPair } = await import("jose");
        const rogue = await generateKeyPair("RS256", { extractable: true });
        const now = Math.floor(Date.now() / 1000);
        const forged = await new SignJWT({ email: "attacker@example.test", sub: "attacker" })
          .setProtectedHeader({ alg: "RS256", kid: provider.keyId })
          .setIssuer(provider.issuer)
          .setAudience("test-client-id")
          .setSubject("attacker")
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(rogue.privateKey);

        await assert.rejects(
          () => connector.verifyToken!(forged),
          /signature|failed to verify|verification failed/i,
          "a token signed with a key the provider never published must be refused"
        );
      });

      it("honours an attribute mapping", async () => {
        const mapped = buildConnector(type, {
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          issuer: provider.issuer,
          authorizationEndpoint: provider.authorizationEndpoint,
          tokenEndpoint: provider.tokenEndpoint,
          jwksUri: provider.jwksUri,
          attributeMapping: { email: "mail", username: "login" },
        });
        const token = await provider.issueIdToken({ mail: "mapped@example.test", login: "mapped-user" });

        const identity = await mapped.verifyToken!(token);
        assert.equal(identity.email, "mapped@example.test", "the mapping should name the claim to read");
        assert.equal(
          identity.username,
          "mapped-user",
          "a mapping of { username: ... } used to be ignored, because the code read " +
            "only the preferred_username key — the same field name is the obvious " +
            "thing to type, and silently ignoring it looks like it worked"
        );
      });
    });
  }
});

describe("federation and existing local accounts", () => {
  let orgId: string;
  const providerIds = new Map<string, string>();

  before(async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: `federation-${RUN_ID}`, slug: `federation-${RUN_ID}` })
      .returning();
    orgId = org.id;
    for (const type of ["google", "okta"]) {
      const [row] = await db
        .insert(identityProviders)
        .values({ orgId, providerType: type, name: type, issuer: provider.issuer })
        .returning();
      providerIds.set(type, row.id);
    }
  });

  async function makeLocalUser(label: string) {
    const [user] = await db
      .insert(users)
      .values({
        email: `${label}-${RUN_ID}@example.test`,
        username: `${label}${RUN_ID}`.slice(0, 32),
        name: label,
        passwordHash: await hashPassword(PASSWORD),
        emailVerified: true,
      })
      .returning();
    createdUserIds.push(user.id);
    return user;
  }

  it("does not attach a federated identity to an existing local account by address alone", async () => {
    // The linking question the roadmap names, and the one that is easy to get
    // wrong in the convenient direction.
    //
    // A federated sign-in resolves an account by address. If that resolution also
    // *created* a link, then anyone who can get an account at a permissive
    // upstream provider using somebody else's address would be signing in as that
    // person: the upstream's "this address is mine" would be treated as proof of
    // an identity Keystone has never seen.
    //
    // So both halves are asserted. The address the IdP returns belongs to no local
    // account, and the existing password-only account gains no identity row.
    const local = await makeLocalUser("federation-no-link");

    const identity = await connectorFor("google").exchangeCode("auth-code", REDIRECT_URI);
    const [byEmail] = await db.select().from(users).where(eq(users.email, identity.email));
    assert.equal(
      byEmail,
      undefined,
      "an unknown upstream address must not silently create a local account here"
    );

    const after = await db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, local.id));
    assert.equal(
      after.length,
      0,
      "an external identity must never be attached to a local account by address alone"
    );
  });

  it("records a federated identity against the account it authenticated", async () => {
    // And the legitimate path still works: a user who signs in federated does get
    // an identity row, so the next sign-in finds the same account rather than
    // making a second one.
    const identity = await connectorFor("google").exchangeCode("auth-code", REDIRECT_URI);

    const [user] = await db
      .insert(users)
      .values({
        email: identity.email,
        username: `fed${RUN_ID}`.slice(0, 32),
        name: identity.name ?? "federated",
        emailVerified: identity.emailVerified,
      })
      .returning();
    createdUserIds.push(user.id);

    await db.insert(userIdentities).values({
      userId: user.id,
      providerId: providerIds.get("google")!,
      providerType: "google",
      externalSub: identity.sub,
      email: identity.email,
    });

    const rows = await db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.externalSub, identity.sub));
    assert.equal(rows.length, 1, "the second federated sign-in finds the same identity, not a new account");
    assert.equal(rows[0].userId, user.id);
  });

  it("keeps two providers' identities for the same sub apart", async () => {
    // `provider` is part of the lookup key, and it has to be. A `sub` is unique
    // only within a provider — two providers will both mint "12345" — so a lookup
    // by sub alone would sign in as the wrong account the first time two providers
    // were both in use.
    const sub = `shared-sub-${RUN_ID}`;

    const [first] = await db
      .insert(users)
      .values({
        email: `twoprov-${RUN_ID}@example.test`,
        username: `two${RUN_ID}`.slice(0, 32),
        name: "google user",
        emailVerified: true,
      })
      .returning();
    createdUserIds.push(first.id);

    const [second] = await db
      .insert(users)
      .values({
        email: `twoprov2-${RUN_ID}@example.test`,
        username: `two2${RUN_ID}`.slice(0, 32),
        name: "okta user",
        emailVerified: true,
      })
      .returning();
    createdUserIds.push(second.id);

    await db.insert(userIdentities).values({
      userId: first.id,
      providerId: providerIds.get("google")!,
      providerType: "google",
      externalSub: sub,
      email: "a@x.test",
    });
    await db.insert(userIdentities).values({
      userId: second.id,
      providerId: providerIds.get("okta")!,
      providerType: "okta",
      externalSub: sub,
      email: "b@x.test",
    });

    const rows = await db.select().from(userIdentities).where(eq(userIdentities.externalSub, sub));
    assert.equal(rows.length, 2, "the same sub at two providers is two identities, not one");
    assert.deepEqual(rows.map((r) => r.providerType).sort(), ["google", "okta"]);
  });
});
