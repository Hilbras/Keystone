import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
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
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../db/index.js");
const { users, workflows, workflowRuns, auditLog } = await import("../../db/schema.js");
const { buildApp } = await import("../../index.js");
const { createAccessToken, loadSigningKeys } = await import("../../services/tokens.js");
const { triggerWorkflowRun } = await import("../../services/workflows/engine.js");
const { getSdk } = await import("../../sdk/index.js");

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

async function createActor(role: "owner" | "user", label: string): Promise<Actor> {
  const id = crypto.randomUUID();
  let user = await userRepository.create({
    email: `${label}-${id}@example.com`,
    username: `${label}-${id}`.slice(0, 32),
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
  const organization = await organizationRepository.create({ name: `${label}-${id}`, slug: `${label}-${id}` });
  for (const membership of memberships) {
    await organizationRepository.addMembership({ orgId: organization.id, ...membership });
  }
  return organization;
}

function authHeaders(actor: Actor) {
  return { authorization: `Bearer ${actor.accessToken}` };
}

describe("Phase 1 authorization security regressions", () => {
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
      { userId: actor.user.id, role: "member" },
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
    const target = await createActor("user", "sdk-role-smuggling-target");
    const result = await getSdk().identity.updateUserProfile(target.user.id, { role: "owner" } as never);
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
        { userId: actor.user.id, role: "member" },
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
    assert.strictEqual(run.status, "blocked");
    const stored = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    assert.strictEqual(stored[0]?.status, "blocked");
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
