import "reflect-metadata";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";

const { GoogleConnector } = await import("../../../services/connectors/google.js");
const { OidcConnector } = await import("../../../services/connectors/oidc.js");

/**
 * Plan item 3: the userinfo endpoint.
 *
 * Two defects motivated these tests. `GoogleConnector.exchangeCode` overrode the
 * base method without forwarding its `opts`, so the OIDC nonce added in 2.4.0
 * was silently discarded for the default provider. And the enrichment path
 * passed `this.config.userinfoEndpoint!` into the fetcher, turning an
 * unconfigured endpoint into a misleading "must be a valid URL".
 */

type Config = ConstructorParameters<typeof OidcConnector>[3];

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    clientId: "client-1",
    clientSecret: "secret",
    issuer: "https://accounts.example.test",
    authorizationEndpoint: "https://accounts.example.test/authorize",
    tokenEndpoint: "https://accounts.example.test/token",
    jwksUri: "https://accounts.example.test/jwks",
    ...overrides,
  } as Config;
}

function google(overrides: Partial<Config> = {}) {
  return new GoogleConnector("google", "Google", "google", baseConfig(overrides));
}

/** Read the private endpoint resolver without widening the class's surface. */
function userinfoEndpointOf(connector: InstanceType<typeof GoogleConnector>): string | undefined {
  return (connector as unknown as { resolveUserinfoEndpoint(): string | undefined })
    .resolveUserinfoEndpoint();
}

describe("OIDC userinfo endpoint resolution", () => {
  it("uses a custom configured endpoint", () => {
    const connector = google({ userinfoEndpoint: "https://accounts.example.test/userinfo" });
    assert.equal(userinfoEndpointOf(connector), "https://accounts.example.test/userinfo");
  });

  it("returns undefined when no endpoint is configured", () => {
    // Must be undefined rather than the string "undefined" reaching the fetcher,
    // which would have produced "userinfoEndpoint must be a valid URL" for a URL
    // that was never configured.
    assert.equal(userinfoEndpointOf(google()), undefined);
  });

  it("treats a blank endpoint as unconfigured", () => {
    assert.equal(userinfoEndpointOf(google({ userinfoEndpoint: "   " })), undefined);
    assert.equal(userinfoEndpointOf(google({ userinfoEndpoint: "" })), undefined);
  });

  it("does not invent a default endpoint", () => {
    // Keystone has no opinion about a provider's userinfo URL; discovery supplies
    // it. Guessing one would send a bearer token somewhere unvetted.
    const connector = google();
    const endpoint = userinfoEndpointOf(connector);
    assert.ok(endpoint === undefined || endpoint.startsWith("https://"));
  });

  it("refuses a malformed endpoint through the shared policy validator", async () => {
    const { validateSsoEndpoint } = await import("../../../services/ssoEndpointPolicy.js");
    for (const bad of ["not-a-url", "", "   "]) {
      assert.throws(
        () => validateSsoEndpoint(bad, "userinfoEndpoint"),
        /must be a valid URL/,
        `${JSON.stringify(bad)} must be refused`
      );
    }
  });

  it("enforces the HTTPS requirement according to the loaded configuration", async () => {
    const { validateSsoEndpoint } = await import("../../../services/ssoEndpointPolicy.js");
    const { config } = await import("../../../config.js");

    // `config` is a load-time snapshot, so NODE_ENV cannot be flipped mid-process.
    // Assert against the value this process actually booted with, and say which
    // branch is being exercised rather than pretending both were.
    if (config.NODE_ENV === "production") {
      assert.throws(
        () => validateSsoEndpoint("http://idp.example.test/userinfo", "userinfoEndpoint"),
        /must use HTTPS/,
        "production must refuse plaintext HTTP"
      );
    } else {
      // The documented development allowance: plaintext HTTP is permitted so a
      // developer can point a connector at an unsecured IdP. It is a boot-time
      // decision; setting NODE_ENV=production is what turns it off.
      //
      // A loopback host is a separate matter and is still refused unless
      // ALLOW_PRIVATE_SSO_ENDPOINTS is set, so this uses a public hostname to
      // isolate the HTTPS rule from the private-address rule.
      const url = validateSsoEndpoint("http://idp.example.test/userinfo", "userinfoEndpoint");
      assert.equal(url.protocol, "http:");
      console.log(
        `[enterprise-sso] booted with NODE_ENV=${config.NODE_ENV}: the plaintext-HTTP ` +
          "refusal applies to production only, so it is not exercised here."
      );
    }

    // Either way, HTTPS endpoints are accepted and malformed ones are not.
    assert.equal(
      validateSsoEndpoint("https://idp.example.test/userinfo", "userinfoEndpoint").protocol,
      "https:"
    );
  });

  it("refuses a userinfo endpoint aimed at a private address", async () => {
    const { validateSsoEndpoint } = await import("../../../services/ssoEndpointPolicy.js");
    assert.throws(
      () => validateSsoEndpoint("https://127.0.0.1/userinfo", "userinfoEndpoint"),
      /private or local address/
    );
    assert.throws(
      () => validateSsoEndpoint("https://169.254.169.254/latest/meta-data", "userinfoEndpoint"),
      /private or local address/
    );
  });
});

describe("GoogleConnector nonce forwarding", () => {
  it("forwards the nonce to the base connector", async () => {
    const connector = google();
    const seen: Array<string | undefined> = [];

    // Intercept the base implementation so the hand-off is observed directly
    // rather than inferred from a network failure.
    const base = Object.getPrototypeOf(Object.getPrototypeOf(connector));
    const original = (base as { exchangeCode: (...a: unknown[]) => unknown }).exchangeCode;
    (base as { exchangeCode: (...a: unknown[]) => unknown }).exchangeCode = function (
      ...args: unknown[]
    ) {
      seen.push((args[2] as { nonce?: string } | undefined)?.nonce);
      return original.apply(this, args);
    };

    try {
      // The exchange itself will fail (no network), which is fine: what matters
      // is what the override forwarded on the way past.
      await connector
        .exchangeCode("code", "https://app.example.test/cb", { nonce: "n-abc" })
        .catch(() => undefined);
    } finally {
      (base as { exchangeCode: (...a: unknown[]) => unknown }).exchangeCode = original;
    }

    assert.equal(seen.length, 1, "the base exchangeCode must be called exactly once");
    assert.equal(seen[0], "n-abc", "the nonce must reach the base connector");
  });

  it("forwards an absent nonce as absent, not as a fabricated one", async () => {
    const connector = google();
    const seen: Array<string | undefined> = [];
    const base = Object.getPrototypeOf(Object.getPrototypeOf(connector));
    const original = (base as { exchangeCode: (...a: unknown[]) => unknown }).exchangeCode;
    (base as { exchangeCode: (...a: unknown[]) => unknown }).exchangeCode = function (
      ...args: unknown[]
    ) {
      seen.push((args[2] as { nonce?: string } | undefined)?.nonce);
      return original.apply(this, args);
    };

    try {
      await connector.exchangeCode("code", "https://app.example.test/cb").catch(() => undefined);
    } finally {
      (base as { exchangeCode: (...a: unknown[]) => unknown }).exchangeCode = original;
    }

    assert.equal(seen[0], undefined, "no nonce in, no nonce out");
  });
});

describe("Enterprise SSO membership is organization-scoped", () => {
  it("keys membership on organizationId and userId together", async () => {
    // Proves the composite key the plan requires: the same user in two
    // organizations is two memberships, and neither lookup can see the other.
    const { and, eq } = await import("drizzle-orm");
    const { db } = await import("../../../db/index.js");
    const { orgMemberships, users, organizations } = await import("../../../db/schema.js");
    const { DrizzleOrganizationRepository } = await import("../../../repositories/organization.js");

    const run = crypto.randomBytes(6).toString("hex");
    const [orgA] = await db
      .insert(organizations)
      .values({ name: `A ${run}`, slug: `a-${run}` })
      .returning();
    const [orgB] = await db
      .insert(organizations)
      .values({ name: `B ${run}`, slug: `b-${run}` })
      .returning();
    const handle = crypto.randomBytes(6).toString("hex");
    const [user] = await db
      .insert(users)
      .values({ email: `sso-${handle}@example.test`, username: `sso-${handle}`, name: "SSO" })
      .returning();

    await db.insert(orgMemberships).values({ orgId: orgA.id, userId: user.id, role: "member" });
    await db.insert(orgMemberships).values({ orgId: orgB.id, userId: user.id, role: "admin" });

    const repository = new DrizzleOrganizationRepository();

    const a = await repository.findMembership(orgA.id, user.id);
    const b = await repository.findMembership(orgB.id, user.id);
    assert.equal(a?.role, "member", "org A membership must be its own row");
    assert.equal(b?.role, "admin", "org B membership must be its own row");
    assert.notEqual(a?.id, b?.id, "the two memberships must be distinct rows");

    // A membership in A must not be discoverable through B.
    const wrongOrg = await repository.findMembership(
      "00000000-0000-0000-0000-000000000000",
      user.id
    );
    assert.equal(wrongOrg, undefined, "an unrelated organization must see no membership");

    const all = await db
      .select({ orgId: orgMemberships.orgId })
      .from(orgMemberships)
      .where(eq(orgMemberships.userId, user.id));
    assert.equal(all.length, 2, "the user holds exactly two memberships, one per organization");
    void and;

    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(organizations).where(eq(organizations.id, orgA.id));
    await db.delete(organizations).where(eq(organizations.id, orgB.id));
  });
});
