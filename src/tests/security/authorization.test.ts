import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Organization, User } from "../../db/schema.js";
import type { UserRepository, OrganizationRepository } from "../../repositories/types.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "security-test-internal-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samlTestCertificate = fs.readFileSync(
  path.resolve(__dirname, "../../../src/tests/fixtures/saml-idp-test-cert.pem"),
  "utf8"
);
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../db/index.js");
const { users, workflows, workflowRuns, auditLog, oidcConnections, apiKeys, refreshTokens, orgMemberships } = await import("../../db/schema.js");
const { buildApp } = await import("../../index.js");
const { createAccessToken, createTokenSet, generateApiKey, hashApiKey, loadSigningKeys, rotateRefreshToken } = await import("../../services/tokens.js");
const { triggerWorkflowRun, executeRunById } = await import("../../services/workflows/engine.js");
const { getSdk } = await import("../../sdk/index.js");
const { provisionEnterpriseUser } = await import("../../services/enterpriseSso.js");
const { upsertOAuthUser } = await import("../../services/users.js");

let app: FastifyInstance;
let userRepository: UserRepository;
let organizationRepository: OrganizationRepository;

interface Actor {
  user: User;
  accessToken: string;
}

before(async () => {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../db/migrations") });
  await loadSigningKeys();
  app = await buildApp();
  userRepository = app.container.userRepository;
  organizationRepository = app.container.organizationRepository;
  await app.container.permissionRepository.ensureRolePermissionsSeeded();
});

after(async () => {
  await app?.close();
  const { closeDb } = await import("../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

/**
 * SCIM requests are authorized by a per-organization connection since 1.9.0,
 * so tests provision a real credential instead of setting the legacy env vars.
 */
async function scimHeaders(orgId: string, name: string): Promise<{ authorization: string }> {
  const { ScimConnectionService } = await import("../../services/scimCredentials.js");
  const service = new ScimConnectionService(app.container.scimConnectionRepository);
  const created = await service.create({ orgId, name });
  assert.ok(created.success, "SCIM connection should be created");
  if (!created.success) throw new Error("unreachable");
  return { authorization: `Bearer ${created.data.token}` };
}

async function createActor(role: "owner" | "user", label: string): Promise<Actor> {
  const id = crypto.randomUUID();
  let user = await userRepository.create({
    email: `${label}-${id}@example.com`,
    username: `${label.slice(0, 8)}-${id.slice(0, 8)}`,
    name: label,
    emailVerified: true,
  });
  if (role !== "user") {
    user = (await userRepository.updateRole(user.id, role)) ?? user;
  }
  return { user, accessToken: await createAccessToken(user) };
}

async function createOrganization(label: string, memberships: Array<{ userId: string; role: "owner" | "admin" | "member" }>): Promise<Organization> {
  const id = crypto.randomUUID().slice(0, 8);
  const firstMembership = memberships[0];
  let ownerId = firstMembership?.userId;
  if (!ownerId) {
    const bootstrapOwner = await userRepository.create({
      email: `fixture-owner-${id}@example.com`,
      username: `fixture-owner-${id}`,
      name: "Fixture owner",
      emailVerified: true,
    });
    ownerId = bootstrapOwner.id;
  }
  const organization = await organizationRepository.createWithOwner(
    { name: `${label}-${id}`, slug: `${label}-${id}` },
    ownerId
  );
  for (const [index, membership] of memberships.entries()) {
    if (index === 0) continue;
    await organizationRepository.addMembership({ orgId: organization.id, ...membership });
  }

  if (firstMembership && firstMembership.role !== "owner") {
    const temporaryOwner = await userRepository.create({
      email: `fixture-temp-owner-${id}@example.com`,
      username: `fixture-temp-owner-${id}`,
      name: "Temporary fixture owner",
      emailVerified: true,
    });
    await organizationRepository.addMembership({ orgId: organization.id, userId: temporaryOwner.id, role: "owner" });
    await organizationRepository.updateMembershipRole(organization.id, firstMembership.userId, firstMembership.role);
  }
  return organization;
}

function authHeaders(actor: Actor) {
  return { authorization: `Bearer ${actor.accessToken}` };
}

describe("Phase 1 authorization security regressions", () => {
  it("does not put a cross-tenant client organization in a user token", async () => {
    const firstOwner = await createActor("owner", "token-scope-first-owner");
    const secondOwner = await createActor("owner", "token-scope-second-owner");
    const firstOrg = await createOrganization("token-scope-first", [
      { userId: firstOwner.user.id, role: "owner" },
    ]);
    const secondOrg = await createOrganization("token-scope-second", [
      { userId: secondOwner.user.id, role: "owner" },
    ]);
    const firstApp = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${firstOrg.id}/applications`,
      headers: authHeaders(firstOwner),
      payload: { name: "First token client" },
    });
    const secondApp = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${secondOrg.id}/applications`,
      headers: authHeaders(secondOwner),
      payload: { name: "Second token client" },
    });
    assert.strictEqual(firstApp.statusCode, 201);
    assert.strictEqual(secondApp.statusCode, 201);

    const email = `token-scope-${crypto.randomUUID()}@example.com`;
    const username = `token-scope-${crypto.randomUUID()}`.slice(0, 32);
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        username,
        email,
        password: "Correct-Horse-Battery-Staple-42",
        client_id: JSON.parse(firstApp.body).clientId,
      },
    });
    assert.strictEqual(registered.statusCode, 200);
    const userId = JSON.parse(registered.body).user.id as string;
    await organizationRepository.addMembership({ orgId: firstOrg.id, userId, role: "member" });

    const login = await app.inject({
      method: "POST",
      url: "/auth/token-login",
      payload: {
        email,
        password: "Correct-Horse-Battery-Staple-42",
        client_id: JSON.parse(secondApp.body).clientId,
      },
    });
    assert.strictEqual(login.statusCode, 200);
    const token = JSON.parse(login.body).accessToken as string;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { org_id?: string };
    assert.notStrictEqual(claims.org_id, secondOrg.id);

    const consent = await app.inject({
      method: "POST",
      url: "/oauth2/consent",
      headers: { authorization: `Bearer ${token}` },
      payload: { client_id: JSON.parse(secondApp.body).clientId, scopes: [], grant: true },
    });
    assert.strictEqual(consent.statusCode, 403);
  });

  it("always assigns an owner when creating an organization through the API", async () => {
    const creator = await createActor("owner", "organization-creator");
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/organizations",
      headers: authHeaders(creator),
      payload: { name: "Owned organization" },
    });
    assert.strictEqual(response.statusCode, 201);
    const organizationId = JSON.parse(response.body).id as string;
    const membership = await organizationRepository.findMembership(organizationId, creator.user.id);
    assert.strictEqual(membership?.role, "owner");
  });

  it("requires a platform owner to create an organization", async () => {
    const creator = await createActor("user", "organization-create-denied");
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/organizations",
      headers: authHeaders(creator),
      payload: { name: "Unauthorized organization" },
    });
    assert.strictEqual(response.statusCode, 403);
  });

  it("rolls back organization creation when owner membership cannot be written", async () => {
    const slug = `owner-rollback-${crypto.randomUUID().slice(0, 8)}`;
    await assert.rejects(() =>
      organizationRepository.createWithOwner({ name: "Rollback organization", slug }, crypto.randomUUID())
    );
    assert.strictEqual(await organizationRepository.findBySlug(slug), undefined);
  });

  it("blocks an organization admin from writing a global platform role", async () => {
    const attacker = await createActor("user", "org-admin");
    const organization = await createOrganization("org-admin-escalation", [
      { userId: attacker.user.id, role: "admin" },
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${organization.id}/users/${attacker.user.id}`,
      headers: authHeaders(attacker),
      payload: { role: "owner" },
    });

    assert.strictEqual(response.statusCode, 410);
    const unchanged = await userRepository.findById(attacker.user.id);
    assert.strictEqual(unchanged?.role, "user");
  });

  it("blocks an organization owner from writing a global platform role", async () => {
    const attacker = await createActor("user", "org-owner");
    const organization = await createOrganization("org-owner-escalation", [
      { userId: attacker.user.id, role: "owner" },
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${organization.id}/users/${attacker.user.id}`,
      headers: authHeaders(attacker),
      payload: { role: "owner" },
    });

    assert.strictEqual(response.statusCode, 410);
    const unchanged = await userRepository.findById(attacker.user.id);
    assert.strictEqual(unchanged?.role, "user");
  });

  it("does not allow an organization member to modify a user", async () => {
    const actor = await createActor("user", "org-member");
    const target = await createActor("user", "org-target");
    const organization = await createOrganization("org-member-boundary", [
      { userId: actor.user.id, role: "member" },
      { userId: target.user.id, role: "member" },
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${organization.id}/users/${target.user.id}`,
      headers: authHeaders(actor),
      payload: { role: "owner" },
    });

    assert.strictEqual(response.statusCode, 403);
    const unchanged = await userRepository.findById(target.user.id);
    assert.strictEqual(unchanged?.role, "user");
  });

  it("does not allow a cross-organization target to be modified", async () => {
    const attacker = await createActor("user", "cross-tenant-attacker");
    const target = await createActor("user", "cross-tenant-target");
    const attackerOrg = await createOrganization("cross-tenant-a", [
      { userId: attacker.user.id, role: "admin" },
    ]);
    await createOrganization("cross-tenant-b", [{ userId: target.user.id, role: "member" }]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${attackerOrg.id}/users/${target.user.id}`,
      headers: authHeaders(attacker),
      payload: { role: "owner" },
    });

    assert.strictEqual(response.statusCode, 404);
    const unchanged = await userRepository.findById(target.user.id);
    assert.strictEqual(unchanged?.role, "user");
  });

  it("rejects tenant workflows that assign global roles", async () => {
    const actor = await createActor("user", "workflow-author");
    const organization = await createOrganization("workflow-escalation", [
      { userId: actor.user.id, role: "owner" },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/workflows",
      headers: authHeaders(actor),
      payload: {
        orgId: organization.id,
        name: "Privilege escalation",
        trigger: "user_login",
        definition: { steps: [{ type: "assign_role", role: "owner" }] },
      },
    });

    assert.strictEqual(response.statusCode, 400);
    const existing = await db.select().from(workflows).where(eq(workflows.orgId, organization.id));
    assert.strictEqual(existing.length, 0);
  });

  it("prevents an organization admin from self-promoting to owner", async () => {
    const actor = await createActor("user", "self-promotion");
    const organization = await createOrganization("self-promotion-boundary", [
      { userId: actor.user.id, role: "admin" },
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${organization.id}/members/${actor.user.id}`,
      headers: authHeaders(actor),
      payload: { role: "owner" },
    });

    assert.strictEqual(response.statusCode, 403);
    const membership = await organizationRepository.findMembership(organization.id, actor.user.id);
    assert.strictEqual(membership?.role, "admin");
  });

  it("prevents an organization admin from inviting another owner", async () => {
    const actor = await createActor("user", "owner-invite");
    const organization = await createOrganization("owner-invite-boundary", [
      { userId: actor.user.id, role: "admin" },
    ]);

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organization.id}/invites`,
      headers: authHeaders(actor),
      payload: { email: `invite-${crypto.randomUUID()}@example.com`, role: "owner" },
    });

    assert.strictEqual(response.statusCode, 403);
  });

  it("prevents demoting the sole organization owner", async () => {
    const actor = await createActor("user", "last-owner");
    const organization = await createOrganization("last-owner-boundary", [
      { userId: actor.user.id, role: "owner" },
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${organization.id}/members/${actor.user.id}`,
      headers: authHeaders(actor),
      payload: { role: "member" },
    });

    assert.strictEqual(response.statusCode, 400);
    const membership = await organizationRepository.findMembership(organization.id, actor.user.id);
    assert.strictEqual(membership?.role, "owner");
  });

  it("does not expose password, TOTP, or nested metadata secrets in user responses", async () => {
    const reader = await createActor("user", "secret-reader");
    const target = await createActor("user", "secret-target");
    await db
      .update(users)
      .set({
        passwordHash: "test-password-hash",
        totpSecret: "test-totp-secret",
        metadata: { safe: "visible", nested: { apiSecret: "nested-secret-value" } },
      })
      .where(eq(users.id, target.user.id));
    const organization = await createOrganization("secret-boundary", [
      { userId: reader.user.id, role: "member" },
      { userId: target.user.id, role: "member" },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organization.id}/users`,
      headers: authHeaders(reader),
    });

    assert.strictEqual(response.statusCode, 200);
    assert.doesNotMatch(response.body, /passwordHash|totpSecret|password_hash|totp_secret|nested-secret-value|apiSecret/);
  });

  it("sanitizes invite and platform profile responses", async () => {
    const owner = await createActor("user", "projection-owner");
    const organization = await createOrganization("projection-boundary", [
      { userId: owner.user.id, role: "owner" },
    ]);

    const invite = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organization.id}/invites`,
      headers: authHeaders(owner),
      payload: { email: `projection-${crypto.randomUUID()}@example.com`, role: "member" },
    });
    assert.strictEqual(invite.statusCode, 201);
    assert.doesNotMatch(invite.body, /passwordHash|totpSecret/);

    const platformOwner = await createActor("owner", "projection-platform-owner");
    const target = await createActor("user", "projection-platform-target");
    const profile = await app.inject({
      method: "PATCH",
      url: `/v1/admin/platform/users/${target.user.id}`,
      headers: authHeaders(platformOwner),
      payload: { name: "Updated name" },
    });
    assert.strictEqual(profile.statusCode, 200);
    assert.doesNotMatch(profile.body, /passwordHash|totpSecret|password_hash|totp_secret/);
  });

  it("atomically binds refresh-token rotation to its client and organization", async () => {
    const owner = await createActor("user", "refresh-binding-owner");
    const member = await createActor("user", "refresh-binding-member");
    const organization = await createOrganization("refresh-binding-boundary", [
      { userId: owner.user.id, role: "owner" },
      { userId: member.user.id, role: "member" },
    ]);
    const application = await app.container.applicationRepository.create({
      orgId: organization.id,
      name: "Refresh-bound client",
    });
    const options = {
      appId: application.id,
      orgId: organization.id,
      clientId: application.clientId,
    } as const;
    const wrongClientSet = await createTokenSet(member.user, "127.0.0.1", "test-agent", options);
    assert.strictEqual(
      await rotateRefreshToken(wrongClientSet.refreshToken, "127.0.0.1", "test-agent", "wrong-client"),
      null
    );
    assert.ok(
      await rotateRefreshToken(wrongClientSet.refreshToken, "127.0.0.1", "test-agent", application.clientId)
    );

    const tokenSet = await createTokenSet(member.user, "127.0.0.1", "test-agent", options);
    const rotations = await Promise.all([
      rotateRefreshToken(tokenSet.refreshToken, "127.0.0.1", "test-agent", application.clientId),
      rotateRefreshToken(tokenSet.refreshToken, "127.0.0.1", "test-agent", application.clientId),
    ]);
    assert.strictEqual(rotations.filter(Boolean).length, 1);
  });

  it("does not expose application, OIDC, API-key, or configuration secrets", async () => {
    const owner = await createActor("owner", "secret-response-owner");
    const organization = await createOrganization("secret-response-boundary", [
      { userId: owner.user.id, role: "owner" },
    ]);

    const application = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organization.id}/applications`,
      headers: authHeaders(owner),
      payload: { name: "Safe application" },
    });
    assert.strictEqual(application.statusCode, 201);
    assert.doesNotMatch(application.body, /clientSecretHash/);
    assert.match(application.body, /clientSecret/);

    const applicationList = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organization.id}/applications`,
      headers: authHeaders(owner),
    });
    assert.strictEqual(applicationList.statusCode, 200);
    assert.doesNotMatch(applicationList.body, /clientSecretHash|clientSecret/);

    const oidc = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organization.id}/oidc-connections`,
      headers: authHeaders(owner),
      payload: {
        name: "Safe OIDC",
        issuer: "https://issuer.example.test",
        authorizationEndpoint: "https://issuer.example.test/authorize",
        tokenEndpoint: "https://issuer.example.test/token",
        jwksUri: "https://issuer.example.test/jwks",
        clientId: "safe-client",
        clientSecret: "safe-client-secret",
      },
    });
    assert.strictEqual(oidc.statusCode, 201);
    assert.doesNotMatch(oidc.body, /clientSecret|safe-client-secret/);
    const storedOidc = await db.select().from(oidcConnections).where(eq(oidcConnections.id, JSON.parse(oidc.body).id));
    assert.notStrictEqual(storedOidc[0]?.clientSecret, "safe-client-secret");

    const saml = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organization.id}/saml-connections`,
      headers: authHeaders(owner),
      payload: {
        name: "Safe SAML",
        idpEntityId: "https://idp.example.test",
        idpSsoUrl: "https://idp.example.test/sso",
        idpCertificate: "safe-certificate",
        spEntityId: "urn:safe-saml",
        spAcsUrl: "https://keystone.example.test/sso/saml/acs",
      },
    });
    assert.strictEqual(saml.statusCode, 201);
    assert.doesNotMatch(saml.body, /idpCertificate|safe-certificate/);
    const connectionLists = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organization.id}/saml-connections`,
        headers: authHeaders(owner),
      }),
      app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organization.id}/oidc-connections`,
        headers: authHeaders(owner),
      }),
    ]);
    assert.strictEqual(connectionLists[0].statusCode, 200);
    assert.strictEqual(connectionLists[1].statusCode, 200);
    assert.doesNotMatch(connectionLists[0].body, /idpCertificate|safe-certificate/);
    assert.doesNotMatch(connectionLists[1].body, /clientSecret|safe-client-secret/);

    const apiKey = await app.inject({
      method: "POST",
      url: "/auth/api-keys",
      headers: authHeaders(owner),
      payload: { name: "Safe key" },
    });
    assert.strictEqual(apiKey.statusCode, 200);
    assert.doesNotMatch(apiKey.body, /keyHash/);
    assert.match(apiKey.body, /"key"/);

    const serviceAccount = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organization.id}/service-accounts`,
      headers: authHeaders(owner),
      payload: { name: "Safe service account" },
    });
    assert.strictEqual(serviceAccount.statusCode, 201);
    const serviceAccountId = JSON.parse(serviceAccount.body).id as string;
    const serviceKey = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organization.id}/service-accounts/${serviceAccountId}/api-keys`,
      headers: authHeaders(owner),
      payload: { name: "Safe service key" },
    });
    assert.ok(serviceKey.statusCode === 200 || serviceKey.statusCode === 201);
    assert.doesNotMatch(serviceKey.body, /keyHash/);
    assert.match(serviceKey.body, /"key"/);

    const config = await app.inject({
      method: "GET",
      url: "/v1/admin/config",
      headers: authHeaders(owner),
    });
    assert.strictEqual(config.statusCode, 200);
    assert.doesNotMatch(config.body, /hilbras:hilbras|0123456789abcdef0123456789abcdef/);

    const profile = await app.inject({
      method: "GET",
      url: "/v1/admin/platform/configuration-profiles/development",
      headers: authHeaders(owner),
    });
    assert.strictEqual(profile.statusCode, 200);
    assert.doesNotMatch(profile.body, /hilbras:hilbras|0123456789abcdef0123456789abcdef/);

    const sdkInvite = await getSdk().organization.inviteMember(
      owner.user.id,
      organization.id,
      { email: `sdk-projection-${crypto.randomUUID()}@example.com`, role: "member" }
    );
    assert.strictEqual(sdkInvite.success, true);
    if (sdkInvite.success) {
      assert.doesNotMatch(JSON.stringify(sdkInvite.data.user), /passwordHash|totpSecret|emailVerifiedToken/);
    }
    const sdkApplications = await getSdk().organization.listOrganizationApplications(owner.user.id, organization.id);
    assert.strictEqual(sdkApplications.success, true);
    if (sdkApplications.success) {
      assert.doesNotMatch(JSON.stringify(sdkApplications.data), /clientSecretHash/);
    }
  });

  it("rejects role fields and invalid values on the generic platform profile endpoint", async () => {
    const platformOwner = await createActor("owner", "strict-platform-owner");
    const target = await createActor("user", "strict-platform-target");

    const roleInProfile = await app.inject({
      method: "PATCH",
      url: `/v1/admin/platform/users/${target.user.id}`,
      headers: authHeaders(platformOwner),
      payload: { role: "owner" },
    });
    assert.strictEqual(roleInProfile.statusCode, 400);

    const invalidRole = await app.inject({
      method: "PATCH",
      url: `/v1/admin/platform/users/${target.user.id}/role`,
      headers: authHeaders(platformOwner),
      payload: { role: "admin" },
    });
    assert.strictEqual(invalidRole.statusCode, 400);
    const unchanged = await userRepository.findById(target.user.id);
    assert.strictEqual(unchanged?.role, "user");
  });

  it("drops role fields smuggled through the generic in-process identity SDK", async () => {
    const platformOwner = await createActor("owner", "sdk-role-smuggling-owner");
    const target = await createActor("user", "sdk-role-smuggling-target");
    const result = await getSdk().identity.updateUserProfile(platformOwner.user.id, target.user.id, { role: "owner" } as never);
    assert.strictEqual(result.success, true);
    const unchanged = await userRepository.findById(target.user.id);
    assert.strictEqual(unchanged?.role, "user");
  });

  it("enforces the platform-owner actor inside the identity SDK use case", async () => {
    const target = await createActor("user", "sdk-platform-role-target");
    const result = await getSdk().identity.updatePlatformRole(target.user.id, target.user.id, "owner");
    assert.strictEqual(result.success, false);
    if (!result.success) assert.strictEqual(result.error.code, "FORBIDDEN");
    const unchanged = await userRepository.findById(target.user.id);
    assert.strictEqual(unchanged?.role, "user");
  });

  it("prevents an organization admin from modifying an owner target", async () => {
    const admin = await createActor("user", "owner-target-admin");
    const owner = await createActor("user", "owner-target-owner");
    const organization = await createOrganization("owner-target-boundary", [
      { userId: admin.user.id, role: "admin" },
      { userId: owner.user.id, role: "owner" },
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${organization.id}/members/${owner.user.id}`,
      headers: authHeaders(admin),
      payload: { role: "member" },
    });

    assert.strictEqual(response.statusCode, 403);
    const membership = await organizationRepository.findMembership(organization.id, owner.user.id);
    assert.strictEqual(membership?.role, "owner");
  });

  it("prevents cross-organization membership updates", async () => {
    const admin = await createActor("user", "member-cross-tenant-admin");
    const target = await createActor("user", "member-cross-tenant-target");
    const organization = await createOrganization("member-cross-tenant-a", [
      { userId: admin.user.id, role: "admin" },
    ]);
    await createOrganization("member-cross-tenant-b", [{ userId: target.user.id, role: "member" }]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${organization.id}/members/${target.user.id}`,
      headers: authHeaders(admin),
      payload: { role: "admin" },
    });

    assert.strictEqual(response.statusCode, 404);
    const membership = await organizationRepository.findMembership((await organizationRepository.listByUserId(admin.user.id))[0].id, target.user.id);
    assert.strictEqual(membership, undefined);
  });

  it("evaluates authz checks against an explicit organization membership", async () => {
    const member = await createActor("user", "authz-context-member");
    const organization = await createOrganization("authz-context-boundary", [
      { userId: member.user.id, role: "member" },
    ]);
    const otherOrganization = await createOrganization("authz-context-other", []);

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/authz/check",
      headers: authHeaders(member),
      payload: { organizationId: organization.id, resource: "application", action: "read" },
    });
    assert.strictEqual(allowed.statusCode, 200);
    assert.strictEqual(JSON.parse(allowed.body).allowed, true);

    const denied = await app.inject({
      method: "POST",
      url: "/v1/authz/check",
      headers: authHeaders(member),
      payload: { organizationId: otherOrganization.id, resource: "application", action: "read" },
    });
    assert.strictEqual(denied.statusCode, 403);
  });

  it("resolves permissions from the authenticated actor and route organization, not client app context", async () => {
    const owner = await createActor("user", "permission-context-owner");
    const organization = await createOrganization("permission-context-boundary", [
      { userId: owner.user.id, role: "owner" },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organization.id}/service-accounts`,
      headers: { ...authHeaders(owner), "x-app-client-id": "untrusted-client-context" },
    });

    assert.strictEqual(response.statusCode, 200);
  });

  it("propagates deactivation through SCIM and omits inactive users from lists", async () => {
    const target = await createActor("user", "scim-deactivation-target");
    const organization = await createOrganization("scim-deactivation-boundary", [
      { userId: target.user.id, role: "member" },
    ]);
    const headers = await scimHeaders(organization.id, "security-test-scim");
    const updated = await app.inject({
      method: "PUT",
      url: `/scim/v2/Users/${target.user.id}`,
      headers,
      payload: { userName: target.user.email, active: false },
    });
    assert.strictEqual(updated.statusCode, 200);
    assert.strictEqual(JSON.parse(updated.body).active, false);
    const scimAudit = (await db.select().from(auditLog).where(eq(auditLog.event, "scim_user_updated:v1")))
      .find((entry) => (entry.metadata as { targetUserId?: string } | null)?.targetUserId === target.user.id);
    assert.strictEqual(scimAudit?.userId, null);
    assert.strictEqual(scimAudit?.orgId, organization.id);
    const list = await app.inject({ method: "GET", url: "/scim/v2/Users", headers });
    assert.strictEqual(list.statusCode, 200);
    assert.doesNotMatch(list.body, new RegExp(target.user.id));
    // Deactivation already removed the membership, so a follow-up DELETE has
    // nothing left to remove in this organization.
    const deleted = await app.inject({ method: "DELETE", url: `/scim/v2/Users/${target.user.id}`, headers });
    assert.strictEqual(deleted.statusCode, 404);
    const stillPresent = await userRepository.findById(target.user.id);
    assert.strictEqual(stillPresent?.isActive, false);
  });

  it("removes a single-tenant user from the organization on SCIM delete", async () => {
    const target = await createActor("user", "scim-delete-target");
    const organization = await createOrganization("scim-delete-boundary", [
      { userId: target.user.id, role: "member" },
    ]);
    const headers = await scimHeaders(organization.id, "security-test-scim-delete");

    const deleted = await app.inject({ method: "DELETE", url: `/scim/v2/Users/${target.user.id}`, headers });
    assert.strictEqual(deleted.statusCode, 204);
    assert.strictEqual(
      await organizationRepository.findMembership(organization.id, target.user.id),
      undefined
    );
    const after = await userRepository.findById(target.user.id);
    assert.strictEqual(after?.isActive, false);
  });

  it("does not let a tenant SCIM credential provision a platform owner", async () => {
    const owner = await createActor("owner", "scim-platform-owner-target");
    const organization = await createOrganization("scim-owner-boundary", []);
    const headers = await scimHeaders(organization.id, "security-test-scim-owner");

    // The owner is not a member yet, so provisioning is refused outright.
    const response = await app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers,
      payload: { userName: owner.user.email, active: true },
    });
    assert.strictEqual(response.statusCode, 409);

    await organizationRepository.addMembership({ orgId: organization.id, userId: owner.user.id, role: "member" });
    const update = await app.inject({
      method: "PUT",
      url: `/scim/v2/Users/${owner.user.id}`,
      headers,
      payload: { userName: owner.user.email, active: true },
    });
    assert.strictEqual(update.statusCode, 409);
    const removal = await app.inject({
      method: "DELETE",
      url: `/scim/v2/Users/${owner.user.id}`,
      headers,
    });
    assert.strictEqual(removal.statusCode, 409);

    const untouched = await userRepository.findById(owner.user.id);
    assert.strictEqual(untouched?.isActive, true);
    assert.strictEqual(untouched?.role, "owner");
  });

  it("does not expose another organization's SAML connection metadata", async () => {
    const reader = await createActor("user", "saml-cross-tenant-reader");
    const organization = await createOrganization("saml-cross-tenant-a", [
      { userId: reader.user.id, role: "member" },
    ]);
    const otherOrganization = await createOrganization("saml-cross-tenant-b", []);
    const connection = await app.container.samlConnectionRepository.create({
      orgId: otherOrganization.id,
      name: "Other tenant SAML",
      spEntityId: "urn:other-tenant",
      spAcsUrl: "https://other.example.test/acs",
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organization.id}/saml-connections/${connection.id}/metadata`,
      headers: authHeaders(reader),
    });

    assert.strictEqual(response.statusCode, 404);
  });

  it("prevents removing the sole organization owner", async () => {
    const owner = await createActor("user", "last-owner-remove");
    const organization = await createOrganization("last-owner-remove-boundary", [
      { userId: owner.user.id, role: "owner" },
    ]);

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/admin/organizations/${organization.id}/members/${owner.user.id}`,
      headers: authHeaders(owner),
    });

    assert.strictEqual(response.statusCode, 400);
    const membership = await organizationRepository.findMembership(organization.id, owner.user.id);
    assert.strictEqual(membership?.role, "owner");
  });

  it("rejects all tenant authorization-mutating workflow steps", async () => {
    for (const [type, extra] of [
      ["assign_role", { role: "owner" }],
      ["add_membership", { orgRef: "orgId", role: "owner" }],
      ["add_app_membership", { clientId: "known-client" }],
    ] as const) {
      const actor = await createActor("user", `workflow-${type}`);
      const organization = await createOrganization(`workflow-${type}-boundary`, [
        { userId: actor.user.id, role: "owner" },
      ]);
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/workflows",
        headers: authHeaders(actor),
        payload: {
          orgId: organization.id,
          name: `Blocked ${type}`,
          trigger: "user_login",
          definition: { steps: [{ type, ...extra }] },
        },
      });
      assert.strictEqual(response.statusCode, 400, `${type} should be rejected`);
    }
  });

  it("rejects plugin alias and ownerless-organization workflow steps", async () => {
    for (const step of [{ type: "tenant_plugin_alias", target: "users.role" }, { type: "create_organization" }]) {
      const actor = await createActor("user", `workflow-closed-${step.type}`);
      const organization = await createOrganization(`workflow-closed-${step.type}`, [
        { userId: actor.user.id, role: "owner" },
      ]);
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/workflows",
        headers: authHeaders(actor),
        payload: {
          orgId: organization.id,
          name: `Blocked ${step.type}`,
          trigger: "user_login",
          definition: { steps: [step] },
        },
      });
      assert.strictEqual(response.statusCode, 400, `${step.type} should be rejected`);
    }
  });

  it("serializes concurrent organization owner demotions", async () => {
    const first = await createActor("user", "concurrent-owner-a");
    const second = await createActor("user", "concurrent-owner-b");
    const organization = await createOrganization("concurrent-owner-boundary", [
      { userId: first.user.id, role: "owner" },
      { userId: second.user.id, role: "owner" },
    ]);
    const demote = (actor: Actor, targetId: string) => app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${organization.id}/members/${targetId}`,
      headers: authHeaders(actor),
      payload: { role: "member" },
    });
    const responses = await Promise.all([
      demote(first, first.user.id),
      demote(second, second.user.id),
    ]);
    assert.strictEqual(responses.filter((response) => response.statusCode === 200).length, 1);
    assert.strictEqual(responses.filter((response) => response.statusCode === 400).length, 1);
    const members = await organizationRepository.listMembers(organization.id);
    assert.strictEqual(members.filter(({ membership }) => membership.role === "owner").length, 1);
  });

  it("requires the organization context on public SAML metadata lookups", async () => {
    const owner = await createActor("user", "public-saml-owner");
    const organization = await createOrganization("public-saml-a", [{ userId: owner.user.id, role: "owner" }]);
    const otherOrganization = await createOrganization("public-saml-b", []);
    const connection = await app.container.samlConnectionRepository.create({
      orgId: otherOrganization.id,
      name: "Public SAML scope",
      spEntityId: "urn:public-saml",
      spAcsUrl: "https://saml.example.test/acs",
    });

    const denied = await app.inject({
      method: "GET",
      url: `/sso/saml/${connection.id}/metadata?orgId=${organization.id}`,
    });
    assert.strictEqual(denied.statusCode, 404);

    const allowed = await app.inject({
      method: "GET",
      url: `/sso/saml/${connection.id}/metadata?orgId=${otherOrganization.id}`,
    });
    assert.strictEqual(allowed.statusCode, 200);
    assert.match(allowed.body, /public-saml/);
  });

  it("rejects tampered SAML RelayState before accepting a response", async () => {
    const relayState = Buffer.from(
      JSON.stringify({
        transactionId: crypto.randomBytes(24).toString("base64url"),
        connectionId: crypto.randomUUID(),
        orgId: crypto.randomUUID(),
        nonce: crypto.randomBytes(16).toString("base64url"),
        signature: "tampered-signature",
      })
    ).toString("base64url");
    const response = await app.inject({
      method: "POST",
      url: "/sso/saml/acs",
      payload: { SAMLResponse: "not-a-valid-saml-response", RelayState: relayState },
    });
    assert.strictEqual(response.statusCode, 400);
  });

  it("binds SAML RelayState to a one-time browser transaction", async () => {
    const owner = await createActor("user", "saml-transaction-owner");
    const organization = await createOrganization("saml-transaction-boundary", [
      { userId: owner.user.id, role: "owner" },
    ]);
    const connection = await app.container.samlConnectionRepository.create({
      orgId: organization.id,
      name: "Transaction test SAML",
      idpEntityId: "https://idp.example.test",
      idpSsoUrl: "https://idp.example.test/sso",
      idpCertificate: samlTestCertificate,
      spEntityId: `urn:saml-transaction-${crypto.randomUUID()}`,
      spAcsUrl: "https://keystone.example.test/sso/saml/acs",
    });
    const start = await app.inject({
      method: "GET",
      url: `/sso/saml/${connection.id}?orgId=${organization.id}`,
    });
    assert.strictEqual(start.statusCode, 302);
    const relayState = new URL(start.headers.location as string).searchParams.get("RelayState");
    const cookie = start.headers["set-cookie"];
    const acs = {
      method: "POST" as const,
      url: "/sso/saml/acs",
      headers: { cookie },
      payload: { SAMLResponse: "invalid", RelayState: relayState },
    };
    assert.strictEqual((await app.inject(acs)).statusCode, 400);
    assert.strictEqual((await app.inject(acs)).statusCode, 400);
  });

  it("does not auto-link generic OAuth accounts by email or unverified claims", async () => {
    const existing = await createActor("owner", "generic-oauth-existing-owner");
    await assert.rejects(() => upsertOAuthUser({ sub: "unverified-sub", email: existing.user.email }, "google"));
    await assert.rejects(() => upsertOAuthUser({ sub: "verified-sub", email: existing.user.email, emailVerified: true }, "google"));
  });

  it("does not auto-link an existing global user through enterprise SSO", async () => {
    const owner = await createActor("owner", "enterprise-sso-existing-owner");
    const organization = await createOrganization("enterprise-sso-existing-boundary", []);
    await assert.rejects(() =>
      provisionEnterpriseUser(
        organization.id,
        { email: owner.user.email, externalId: "attacker-controlled-subject" },
        { id: crypto.randomUUID(), type: "saml" }
      )
    );
    const membership = await organizationRepository.findMembership(organization.id, owner.user.id);
    assert.strictEqual(membership, undefined);

    await organizationRepository.addMembership({ orgId: organization.id, userId: owner.user.id, role: "member" });
    await assert.rejects(() =>
      provisionEnterpriseUser(
        organization.id,
        { email: owner.user.email, externalId: "attacker-controlled-subject" },
        { id: crypto.randomUUID(), type: "oidc" }
      )
    );
  });

  it("enforces organization permissions inside direct SDK application services", async () => {
    const admin = await createActor("user", "sdk-permission-admin");
    const target = await createActor("user", "sdk-permission-target");
    const organization = await createOrganization("sdk-permission-boundary", [
      { userId: admin.user.id, role: "admin" },
      { userId: target.user.id, role: "member" },
    ]);
    const permission = (await app.container.permissionRepository.list()).find(
      (entry) => entry.resource === "organization" && entry.action === "manage_members"
    );
    assert.ok(permission);
    await app.container.permissionRepository.removeFromRole("admin", permission.id);
    try {
      const result = await getSdk().organization.updateMemberRole(admin.user.id, organization.id, target.user.id, "admin");
      assert.strictEqual(result.success, false);
    } finally {
      await app.container.permissionRepository.assignToRole("admin", permission.id);
    }
  });

  it("scopes direct SDK permission checks to the organization", async () => {
    const member = await createActor("user", "sdk-scope-member");
    const organization = await createOrganization("sdk-scope-boundary", [
      { userId: member.user.id, role: "member" },
    ]);
    const otherOrganization = await createOrganization("sdk-scope-other", []);
    assert.strictEqual(
      await getSdk().authorization.hasPermission(member.user.id, organization.id, "application", "read"),
      true
    );
    assert.strictEqual(
      await getSdk().authorization.hasPermission(member.user.id, otherOrganization.id, "application", "read"),
      false
    );
  });

  it("requires workflow management permission and persists inactive workflows", async () => {
    const owner = await createActor("user", "workflow-management-owner");
    const member = await createActor("user", "workflow-management-member");
    const organization = await createOrganization("workflow-management-boundary", [
      { userId: owner.user.id, role: "owner" },
      { userId: member.user.id, role: "member" },
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/workflows",
      headers: authHeaders(owner),
      payload: {
        orgId: organization.id,
        name: "Inactive workflow",
        trigger: "user_login",
        isActive: false,
        definition: { steps: [{ type: "send_welcome_email" }] },
      },
    });
    assert.strictEqual(created.statusCode, 201);
    assert.strictEqual(JSON.parse(created.body).isActive, false);

    const denied = await app.inject({
      method: "DELETE",
      url: `/v1/admin/workflows/${JSON.parse(created.body).id}`,
      headers: authHeaders(member),
    });
    assert.strictEqual(denied.statusCode, 403);
    const stillPresent = await db.select().from(workflows).where(eq(workflows.id, JSON.parse(created.body).id));
    assert.strictEqual(stillPresent.length, 1);
    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, "workflow_created:v1"));
    const workflowAudit = audit.find((entry) => (entry.metadata as { workflowId?: string } | null)?.workflowId === JSON.parse(created.body).id);
    assert.strictEqual(workflowAudit?.orgId, organization.id);
    assert.strictEqual(workflowAudit?.userId, owner.user.id);
  });

  it("restricts global workflows to platform owners", async () => {
    const [workflow] = await db
      .insert(workflows)
      .values({ orgId: null, name: "Global workflow", trigger: "user_login", definition: { steps: [{ type: "webhook", url: "https://example.test" }] } })
      .returning();
    const member = await createActor("user", "global-workflow-member");
    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/workflows/${workflow.id}`,
      headers: authHeaders(member),
    });
    assert.strictEqual(response.statusCode, 403);
  });

  it("rechecks workflow authorization at execution time", async () => {
    const owner = await createActor("user", "workflow-execution-owner");
    const organization = await createOrganization("workflow-execution-boundary", [
      { userId: owner.user.id, role: "owner" },
    ]);
    const [workflow] = await db
      .insert(workflows)
      .values({ orgId: organization.id, name: "Execution authorization", trigger: "user_login", definition: { steps: [] } })
      .returning();
    const [run] = await db
      .insert(workflowRuns)
      .values({ workflowId: workflow.id, triggerEvent: "user_login", payload: { userId: owner.user.id }, status: "running" })
      .returning();
    await db
      .update(orgMemberships)
      .set({ role: "member" })
      .where(and(eq(orgMemberships.orgId, organization.id), eq(orgMemberships.userId, owner.user.id)));
    await executeRunById(run.id, workflow.id);
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    assert.strictEqual(stored?.status, "blocked");
  });

  it("fails closed for malformed persisted workflow definitions", async () => {
    const [workflow] = await db
      .insert(workflows)
      .values({ name: "Malformed legacy workflow", trigger: "user_login", definition: {} })
      .returning();
    const run = await triggerWorkflowRun(workflow, {
      type: "user_login",
      version: 1,
      timestamp: new Date(),
      payload: { userId: crypto.randomUUID() },
    });
    assert.ok(run);
    assert.strictEqual(run.status, "blocked");
    const stored = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    assert.strictEqual(stored[0]?.status, "blocked");
  });

  it("deactivates accounts and revokes sessions, refresh tokens, and user API keys", async () => {
    const owner = await createActor("owner", "deactivation-owner");
    const target = await createActor("user", "deactivation-target");
    const tokenSet = await createTokenSet(target.user, "127.0.0.1", "test-agent");
    const generatedKey = generateApiKey();
    const apiKey = await app.container.apiKeyRepository.create({
      userId: target.user.id,
      name: "revoked-on-deactivation",
      prefix: generatedKey.prefix,
      keyHash: hashApiKey(generatedKey.key),
      scopes: ["api:read"],
      expiresAt: null,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/admin/platform/users/${target.user.id}`,
      headers: authHeaders(owner),
    });
    assert.strictEqual(response.statusCode, 200);

    const stored = await userRepository.findById(target.user.id);
    assert.strictEqual(stored?.isActive, false);
    const targetRefreshTokens = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, target.user.id));
    assert.ok(targetRefreshTokens.length > 0);
    assert.ok(targetRefreshTokens.every((token) => token.revokedAt !== null));
    const revokedKeys = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    assert.ok(revokedKeys[0]?.revokedAt);
    assert.strictEqual(await rotateRefreshToken(tokenSet.refreshToken), null);

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${tokenSet.accessToken}` },
    });
    assert.strictEqual(me.statusCode, 401);
    const keyValidation = await app.inject({
      method: "GET",
      url: "/auth/validate",
      headers: { authorization: `Bearer ${generatedKey.key}` },
    });
    assert.strictEqual(keyValidation.statusCode, 401);
  });

  it("allows an explicit platform-owner review of quarantined legacy accounts", async () => {
    const owner = await createActor("owner", "legacy-review-owner");
    const target = await createActor("user", "legacy-review-target");
    await userRepository.update(target.user.id, { isActive: false, accountReviewRequired: true });
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/platform/users/${target.user.id}/account-review`,
      headers: authHeaders(owner),
      payload: { active: true },
    });
    assert.strictEqual(response.statusCode, 200);
    const reviewed = await userRepository.findById(target.user.id);
    assert.strictEqual(reviewed?.isActive, true);
    assert.strictEqual(reviewed?.accountReviewRequired, false);
  });

  it("records actor, target, organization, and previous/new membership state", async () => {
    const owner = await createActor("user", "membership-audit-owner");
    const target = await createActor("user", "membership-audit-target");
    const organization = await createOrganization("membership-audit-boundary", [
      { userId: owner.user.id, role: "owner" },
      { userId: target.user.id, role: "member" },
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/organizations/${organization.id}/members/${target.user.id}`,
      headers: authHeaders(owner),
      payload: { role: "admin" },
    });
    assert.strictEqual(response.statusCode, 200);

    const events = await db.select().from(auditLog).where(eq(auditLog.event, "organization_member_role_updated:v1"));
    const event = events.find((entry) => entry.userId === owner.user.id && entry.orgId === organization.id);
    assert.ok(event);
    assert.deepEqual(
      {
        targetUserId: (event.metadata as { targetUserId?: string }).targetUserId,
        previousRole: (event.metadata as { previousRole?: string }).previousRole,
        newRole: (event.metadata as { newRole?: string }).newRole,
      },
      { targetUserId: target.user.id, previousRole: "member", newRole: "admin" }
    );
    assert.ok(event.requestId);
  });

  it("records permission-role transitions with the correct event type", async () => {
    const owner = await createActor("owner", "permission-audit-owner");
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const resource = `audit_${suffix}`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/permissions",
      headers: authHeaders(owner),
      payload: { resource, action: "read", description: "authorization audit test" },
    });
    assert.strictEqual(created.statusCode, 201);
    const permissionId = JSON.parse(created.body).id as string;
    const role = "member";

    const assigned = await app.inject({
      method: "POST",
      url: `/v1/admin/roles/${role}/permissions`,
      headers: authHeaders(owner),
      payload: { permissionId },
    });
    assert.strictEqual(assigned.statusCode, 201);

    const events = await db.select().from(auditLog).where(eq(auditLog.event, "permission_role_updated:v1"));
    const event = events.find((entry) => entry.userId === owner.user.id && (entry.metadata as { permissionId?: string }).permissionId === permissionId);
    assert.ok(event);
    assert.strictEqual((event.metadata as { action?: string }).action, "assign");
    assert.deepEqual(
      {
        previousState: (event.metadata as { previousState?: boolean }).previousState,
        newState: (event.metadata as { newState?: boolean }).newState,
      },
      { previousState: false, newState: true }
    );
  });

  it("records denied platform authorization attempts", async () => {
    const organizationAdmin = await createActor("user", "denied-audit-admin");
    const target = await createActor("user", "denied-audit-target");
    const organization = await createOrganization("denied-audit-boundary", [
      { userId: organizationAdmin.user.id, role: "admin" },
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/platform/users/${target.user.id}/role`,
      headers: authHeaders(organizationAdmin),
      payload: { role: "owner" },
    });
    assert.strictEqual(response.statusCode, 403);

    const events = await db.select().from(auditLog).where(eq(auditLog.event, "unauthorized_access:v1"));
    const event = events.find((entry) => entry.userId === organizationAdmin.user.id);
    assert.ok(event);
    assert.strictEqual((event.metadata as { action?: string }).action, "platform_role_required");
    assert.ok(organization.id);
  });

  it("allows only a platform owner to use the dedicated platform role endpoint", async () => {
    const platformOwner = await createActor("owner", "platform-owner");
    const target = await createActor("user", "platform-target");
    const organizationAdmin = await createActor("user", "platform-denied-admin");
    const organization = await createOrganization("platform-role-boundary", [
      { userId: organizationAdmin.user.id, role: "admin" },
    ]);

    const denied = await app.inject({
      method: "PATCH",
      url: `/v1/admin/platform/users/${target.user.id}/role`,
      headers: authHeaders(organizationAdmin),
      payload: { role: "owner" },
    });
    assert.strictEqual(denied.statusCode, 403);

    const allowed = await app.inject({
      method: "PATCH",
      url: `/v1/admin/platform/users/${target.user.id}/role`,
      headers: authHeaders(platformOwner),
      payload: { role: "owner" },
    });
    assert.strictEqual(allowed.statusCode, 200);
    const updated = await userRepository.findById(target.user.id);
    assert.strictEqual(updated?.role, "owner");
    const events = await db.select().from(auditLog).where(eq(auditLog.event, "platform_role_changed:v1"));
    const event = events.find((entry) => (entry.metadata as { targetUserId?: string } | null)?.targetUserId === target.user.id);
    assert.ok(event);
    assert.strictEqual((event.metadata as { previousRole?: string }).previousRole, "user");
    assert.strictEqual((event.metadata as { newRole?: string }).newRole, "owner");
    assert.ok(organization.id);
  });
});
