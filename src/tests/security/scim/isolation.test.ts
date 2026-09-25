import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Organization, User } from "../../../db/schema.js";
import type { OrganizationRepository, ScimConnectionRepository, UserRepository } from "../../../repositories/types.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "scim-test-internal-key";
process.env.KEYSTONE_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef";

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const pair = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.JWT_PUBLIC_KEY = await exportSPKI(pair.publicKey);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { db } = await import("../../../db/index.js");
const { scimConnections, scimGroups, scimGroupMembers, orgMemberships } = await import("../../../db/schema.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const {
  ScimConnectionService,
  generateScimToken,
  hashScimToken,
} = await import("../../../services/scimCredentials.js");

let app: FastifyInstance;
let userRepository: UserRepository;
let organizationRepository: OrganizationRepository;
let connections: ScimConnectionRepository;
let scimCredentials: InstanceType<typeof ScimConnectionService>;

interface Tenant {
  organization: Organization;
  owner: User;
  token: string;
  connectionId: string;
}

/** Create an organization, its owner, and a live SCIM credential for it. */
async function createTenant(label = "tenant"): Promise<Tenant> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await userRepository.create({
    email: `${label}-owner-${suffix}@example.com`,
    username: `${label}-owner-${suffix}`,
    name: `${label} owner`,
    emailVerified: true,
  });
  const organization = await organizationRepository.createWithOwner(
    { name: `${label}-${suffix}`, slug: `${label}-${suffix}` },
    owner.id
  );

  const created = await scimCredentials.create({ orgId: organization.id, name: `${label} scim` });
  assert.equal(created.success, true, "SCIM connection should be created");
  if (!created.success) throw new Error("unreachable");

  return {
    organization,
    owner,
    token: created.data.token,
    connectionId: created.data.connectionId,
  };
}

async function addMember(organization: Organization, label = "member"): Promise<User> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await userRepository.create({
    email: `${label}-${suffix}@example.com`,
    username: `${label}-${suffix}`,
    name: `${label} ${suffix}`,
    emailVerified: true,
  });
  await organizationRepository.addMembership({
    orgId: organization.id,
    userId: user.id,
    role: "member",
  });
  return user;
}

function scim(
  tenant: Tenant,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>
) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${tenant.token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** Provision a user through tenant A's credential. */
async function provision(tenant: Tenant, email: string): Promise<User> {
  const res = await scim(tenant, "POST", "/scim/v2/Users", { userName: email });
  assert.equal(res.statusCode, 201, res.body);
  const created = (await userRepository.findByEmail(email))!;
  return created;
}

before(async () => {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../db/migrations") });
  await loadSigningKeys();
  app = await buildApp();
  userRepository = app.container.userRepository;
  organizationRepository = app.container.organizationRepository;
  connections = app.container.scimConnectionRepository;
  scimCredentials = new ScimConnectionService(connections);
  await app.container.permissionRepository.ensureRolePermissionsSeeded();
});

after(async () => {
  await app?.close();
  const { closeDb } = await import("../../../db/index.js");
  await closeDb().catch(() => {});
  const { redis } = await import("../../../services/redis.js");
  try {
    if (redis.status !== "end") await redis.quit();
  } catch {
    redis.disconnect();
  }
});

describe("SCIM credential model", () => {
  it("binds every connection to exactly one organization", async () => {
    const tenant = await createTenant("bound");
    const record = await connections.findById(tenant.connectionId);
    assert.equal(record?.orgId, tenant.organization.id);
  });

  it("stores only a digest, never the token", async () => {
    const tenant = await createTenant("digest");
    const record = await connections.findById(tenant.connectionId);
    assert.equal(record?.tokenHash, hashScimToken(tenant.token));
    assert.notEqual(record?.tokenHash, tenant.token);

    const rows = await db.select().from(scimConnections);
    for (const row of rows) {
      assert.ok(!JSON.stringify(row).includes(tenant.token), "the plaintext token must not be stored");
    }
  });

  it("generates high-entropy, prefixed tokens", () => {
    const issued = generateScimToken();
    assert.match(issued.token, /^ksc_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(generateScimToken().token, issued.token);
  });

  it("allows only one active connection per organization", async () => {
    const tenant = await createTenant("single");
    const second = await scimCredentials.create({ orgId: tenant.organization.id, name: "second" });
    assert.equal(second.success, false);
    if (second.success) return;
    assert.equal(second.error.code, "SCIM_CONNECTION_EXISTS");
    assert.equal(second.error.statusCode, 409);
  });

  it("rejects an unknown or revoked token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/scim/v2/Users",
      headers: { authorization: `Bearer ${generateScimToken().token}` },
    });
    assert.equal(res.statusCode, 401);
  });

  it("rejects a request with no credential", async () => {
    const res = await app.inject({ method: "GET", url: "/scim/v2/Users" });
    assert.equal(res.statusCode, 401);
  });

  it("rejects an expired credential", async () => {
    const tenant = await createTenant("expired");
    await db
      .update(scimConnections)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(scimConnections.id, tenant.connectionId));

    const res = await scim(tenant, "GET", "/scim/v2/Users");
    assert.equal(res.statusCode, 401);
  });

  it("accepts a revoked connection's replacement", async () => {
    const tenant = await createTenant("replace");
    assert.equal((await scimCredentials.revoke(tenant.connectionId)).success, true);

    const replacement = await scimCredentials.create({
      orgId: tenant.organization.id,
      name: "replacement",
    });
    assert.equal(replacement.success, true);
    if (!replacement.success) return;

    const fresh: Tenant = { ...tenant, token: replacement.data.token, connectionId: replacement.data.connectionId };
    assert.equal((await scim(fresh, "GET", "/scim/v2/Users")).statusCode, 200);
  });
});

describe("SCIM credential rotation", () => {
  it("keeps the previous token working during the grace period", async () => {
    const tenant = await createTenant("rotate");
    const oldToken = tenant.token;

    const rotated = await scimCredentials.rotate(tenant.connectionId, { rotationGraceSeconds: 300 });
    assert.equal(rotated.success, true);
    if (!rotated.success) return;
    assert.notEqual(rotated.data.token, oldToken);

    // Old token still accepted, new token accepted.
    assert.equal((await scim(tenant, "GET", "/scim/v2/Users")).statusCode, 200);
    const fresh: Tenant = { ...tenant, token: rotated.data.token };
    assert.equal((await scim(fresh, "GET", "/scim/v2/Users")).statusCode, 200);
  });

  it("rejects the previous token once the grace period has passed", async () => {
    const tenant = await createTenant("rotate-expiry");
    const oldToken = tenant.token;
    await scimCredentials.rotate(tenant.connectionId, { rotationGraceSeconds: 0 });

    await db
      .update(scimConnections)
      .set({ previousTokenValidUntil: new Date(Date.now() - 1000) })
      .where(eq(scimConnections.id, tenant.connectionId));

    const stale: Tenant = { ...tenant, token: oldToken };
    assert.equal((await scim(stale, "GET", "/scim/v2/Users")).statusCode, 401);
  });

  it("rejects a rotated token after revocation", async () => {
    const tenant = await createTenant("rotate-revoke");
    const rotated = await scimCredentials.rotate(tenant.connectionId);
    assert.equal(rotated.success, true);
    if (!rotated.success) return;

    await scimCredentials.revoke(tenant.connectionId);
    const fresh: Tenant = { ...tenant, token: rotated.data.token };
    assert.equal((await scim(fresh, "GET", "/scim/v2/Users")).statusCode, 401);
  });

  it("refuses to rotate a revoked connection", async () => {
    const tenant = await createTenant("rotate-revoked");
    await scimCredentials.revoke(tenant.connectionId);
    const again = await scimCredentials.rotate(tenant.connectionId);
    assert.equal(again.success, false);
    if (again.success) return;
    assert.equal(again.error.code, "SCIM_CONNECTION_REVOKED");
  });
});

describe("Tenant isolation — users", () => {
  it("does not list another organization's users", async () => {
    const a = await createTenant("iso-a");
    const b = await createTenant("iso-b");
    const userInB = await addMember(b.organization, "b-only");

    const res = await scim(a, "GET", "/scim/v2/Users");
    assert.equal(res.statusCode, 200);
    const ids = res.json().Resources.map((u: { id: string }) => u.id);
    assert.ok(!ids.includes(userInB.id), "organization A must not see organization B's users");
  });

  it("cannot read another organization's user by id", async () => {
    const a = await createTenant("read-a");
    const b = await createTenant("read-b");
    const userInB = await addMember(b.organization, "read-target");

    const res = await scim(a, "GET", `/scim/v2/Users/${userInB.id}`);
    assert.equal(res.statusCode, 404);
    // 404, not 403: the endpoint must not confirm that the id exists elsewhere.
    assert.equal(res.json().status, "404");
  });

  it("cannot update another organization's user", async () => {
    const a = await createTenant("update-a");
    const b = await createTenant("update-b");
    const userInB = await addMember(b.organization, "update-target");
    const originalName = userInB.name;

    const res = await scim(a, "PUT", `/scim/v2/Users/${userInB.id}`, {
      userName: userInB.email,
      name: { givenName: "Hijacked", familyName: "Attacker" },
    });
    assert.equal(res.statusCode, 404);

    const after = await userRepository.findById(userInB.id);
    assert.equal(after?.name, originalName, "the target's record must be untouched");
  });

  it("cannot delete another organization's user", async () => {
    const a = await createTenant("delete-a");
    const b = await createTenant("delete-b");
    const userInB = await addMember(b.organization, "delete-target");

    const res = await scim(a, "DELETE", `/scim/v2/Users/${userInB.id}`);
    assert.equal(res.statusCode, 404);

    const after = await userRepository.findById(userInB.id);
    assert.equal(after?.isActive, true, "the target must still be active");
    assert.ok(
      await organizationRepository.findMembership(b.organization.id, userInB.id),
      "the target's membership must survive"
    );
  });

  it("cannot attach a user who already exists in another organization", async () => {
    const a = await createTenant("adopt-a");
    const b = await createTenant("adopt-b");
    const userInB = await addMember(b.organization, "adopt-target");

    const res = await scim(a, "POST", "/scim/v2/Users", { userName: userInB.email });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().scimType, "uniqueness");

    const memberships = await db
      .select()
      .from(orgMemberships)
      .where(eq(orgMemberships.userId, userInB.id));
    assert.equal(memberships.length, 1, "no membership may be created in the other organization");
    assert.equal(memberships[0].orgId, b.organization.id);
  });

  it("does not deactivate a shared account when one organization removes it", async () => {
    const shared = await createTenant("shared-a");
    const other = await createTenant("shared-b");
    const email = `shared-${crypto.randomUUID().slice(0, 8)}@example.com`;

    // The user belongs to both organizations.
    const user = await provision(shared, email);
    await organizationRepository.addMembership({
      orgId: other.organization.id,
      userId: user.id,
      role: "member",
    });

    const res = await scim(shared, "DELETE", `/scim/v2/Users/${user.id}`);
    assert.equal(res.statusCode, 204);

    const after = await userRepository.findById(user.id);
    assert.equal(after?.isActive, true, "the shared account must stay active for the other tenant");

    assert.equal(
      await organizationRepository.findMembership(shared.organization.id, user.id),
      undefined,
      "the membership in the calling organization must be removed"
    );
    assert.ok(
      await organizationRepository.findMembership(other.organization.id, user.id),
      "the other organization's membership must survive"
    );
  });

  it("deactivates the account when the organization was the only membership", async () => {
    const tenant = await createTenant("solo");
    const email = `solo-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const user = await provision(tenant, email);

    const res = await scim(tenant, "DELETE", `/scim/v2/Users/${user.id}`);
    assert.equal(res.statusCode, 204);

    const after = await userRepository.findById(user.id);
    assert.equal(after?.isActive, false, "a single-tenant user is deactivated");
  });

  it("refuses to modify global attributes of a shared user", async () => {
    const a = await createTenant("shared-update-a");
    const b = await createTenant("shared-update-b");
    const email = `shared-update-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const user = await provision(a, email);
    await organizationRepository.addMembership({ orgId: b.organization.id, userId: user.id, role: "member" });

    const res = await scim(a, "PUT", `/scim/v2/Users/${user.id}`, {
      userName: email,
      name: { givenName: "Renamed", familyName: "Elsewhere" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().scimType, "mutability");

    const after = await userRepository.findById(user.id);
    assert.notEqual(after?.name, "Renamed Elsewhere");
  });

  it("never provisions or modifies a platform owner", async () => {
    const a = await createTenant("owner-a");
    const b = await createTenant("owner-b");
    await userRepository.updateRole(b.owner.id, "owner");
    const platformOwner = (await userRepository.findById(b.owner.id))!;
    assert.equal(platformOwner.role, "owner");
    await organizationRepository.addMembership({
      orgId: a.organization.id,
      userId: platformOwner.id,
      role: "member",
    });

    // Reading a member of the credential's own organization is legitimate, but
    // every mutation must be refused.
    const read = await scim(a, "GET", `/scim/v2/Users/${platformOwner.id}`);
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().userName, platformOwner.email);

    for (const [method, path, payload] of [
      ["PUT", `/scim/v2/Users/${platformOwner.id}`, { userName: platformOwner.email, active: false }],
      ["PATCH", `/scim/v2/Users/${platformOwner.id}`, { Operations: [{ op: "replace", path: "active", value: false }] }],
      ["DELETE", `/scim/v2/Users/${platformOwner.id}`, undefined],
    ] as const) {
      const res = await scim(a, method, path, payload as Record<string, unknown> | undefined);
      assert.equal(res.statusCode, 409, `${method} ${path}`);
      assert.equal(res.json().scimType, "mutability");
    }

    const after = await userRepository.findById(platformOwner.id);
    assert.equal(after?.isActive, true);
    assert.equal(after?.role, "owner");
  });

  it("refuses to attach a user that is pending platform review", async () => {
    const a = await createTenant("review-a");
    const email = `review-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const user = await userRepository.create({
      email,
      username: `review-${crypto.randomUUID().slice(0, 8)}`,
      name: "Pending review",
      emailVerified: false,
    });
    await userRepository.update(user.id, { accountReviewRequired: true });
    await organizationRepository.addMembership({ orgId: a.organization.id, userId: user.id, role: "member" });

    const res = await scim(a, "PUT", `/scim/v2/Users/${user.id}`, { userName: email });
    assert.equal(res.statusCode, 409);
  });
});

describe("Tenant isolation — groups", () => {
  async function createGroup(tenant: Tenant, displayName: string) {
    const res = await scim(tenant, "POST", "/scim/v2/Groups", { displayName });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  }

  it("does not list another organization's groups", async () => {
    const a = await createTenant("group-a");
    const b = await createTenant("group-b");
    const groupInB = await createGroup(b, "engineering");

    const res = await scim(a, "GET", "/scim/v2/Groups");
    assert.equal(res.statusCode, 200);
    const ids = res.json().Resources.map((g: { id: string }) => g.id);
    assert.ok(!ids.includes(groupInB.id), "organization A must not see organization B's groups");
  });

  it("cannot read, update, or delete another organization's group", async () => {
    const a = await createTenant("group-write-a");
    const b = await createTenant("group-write-b");
    const groupInB = await createGroup(b, "private");

    const read = await scim(a, "GET", `/scim/v2/Groups/${groupInB.id}`);
    assert.equal(read.statusCode, 404);

    const update = await scim(a, "PUT", `/scim/v2/Groups/${groupInB.id}`, { displayName: "hijacked" });
    assert.equal(update.statusCode, 404);

    const remove = await scim(a, "DELETE", `/scim/v2/Groups/${groupInB.id}`);
    assert.equal(remove.statusCode, 404);

    const after = await app.container.scimGroupRepository.findByIdInOrg(b.organization.id, groupInB.id);
    assert.equal(after?.displayName, "private", "the other tenant's group must be untouched");
  });

  it("cannot add a user from another organization to a group", async () => {
    const a = await createTenant("member-a");
    const b = await createTenant("member-b");
    const group = await createGroup(a, "staff");
    const outsider = await addMember(b.organization, "outsider");

    const res = await scim(a, "POST", `/scim/v2/Groups/${group.id}/members`, { value: outsider.id });
    assert.equal(res.statusCode, 404);

    const members = await app.container.scimGroupRepository.listMembers(a.organization.id, group.id);
    assert.equal(members.length, 0, "the outsider must not be a member");
  });

  it("cannot enumerate another organization's group members", async () => {
    const a = await createTenant("enum-a");
    const b = await createTenant("enum-b");
    const groupInB = await createGroup(b, "hidden");
    const memberInB = await addMember(b.organization, "hidden-member");
    await scim(b, "POST", `/scim/v2/Groups/${groupInB.id}/members`, { value: memberInB.id });

    const res = await scim(a, "GET", `/scim/v2/Groups/${groupInB.id}/members`);
    assert.equal(res.statusCode, 404);
    assert.ok(!res.body.includes(memberInB.id));
  });

  it("deletes a group's members when the group is deleted", async () => {
    const tenant = await createTenant("group-delete");
    const group = await createGroup(tenant, "temporary");
    const member = await addMember(tenant.organization, "temp-member");
    await scim(tenant, "POST", `/scim/v2/Groups/${group.id}/members`, { value: member.id });

    const res = await scim(tenant, "DELETE", `/scim/v2/Groups/${group.id}`);
    assert.equal(res.statusCode, 204);

    const remaining = await db
      .select()
      .from(scimGroupMembers)
      .where(eq(scimGroupMembers.groupId, group.id));
    assert.equal(remaining.length, 0, "memberships must cascade with the group");
  });
});

describe("SCIM search and patching", () => {
  it("filters users by userName", async () => {
    const tenant = await createTenant("filter");
    const wanted = `filter-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const other = `filter-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await provision(tenant, wanted);
    await provision(tenant, other);

    const res = await scim(tenant, "GET", `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${wanted}"`)}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().totalResults, 1);
    assert.equal(res.json().Resources[0].userName, wanted);
  });

  it("rejects an unsupported filter instead of silently ignoring it", async () => {
    const tenant = await createTenant("badfilter");
    const res = await scim(tenant, "GET", `/scim/v2/Users?filter=${encodeURIComponent("emails.value co \"x\"")}`);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().scimType, "invalidFilter");
  });

  it("paginates", async () => {
    const tenant = await createTenant("page");
    for (let i = 0; i < 3; i++) {
      await provision(tenant, `page-${i}-${crypto.randomUUID().slice(0, 8)}@example.com`);
    }

    const res = await scim(tenant, "GET", "/scim/v2/Users?startIndex=1&count=2");
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.Resources.length, 2);
    assert.ok(body.totalResults >= 3);
    assert.equal(body.startIndex, 1);
  });

  it("applies a PATCH to deactivate and re-provision", async () => {
    const tenant = await createTenant("patch");
    const email = `patch-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const user = await provision(tenant, email);

    const deactivate = await scim(tenant, "PATCH", `/scim/v2/Users/${user.id}`, {
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    assert.equal(deactivate.statusCode, 200, deactivate.body);
    assert.equal(deactivate.json().active, false, "the response reflects the requested state");
    assert.equal((await userRepository.findById(user.id))?.isActive, false);

    // A deactivated single-tenant user is also gone from the organization's list.
    const list = await scim(tenant, "GET", "/scim/v2/Users");
    const ids = list.json().Resources.map((u: { id: string }) => u.id);
    assert.ok(!ids.includes(user.id));
  });

  it("applies a PATCH that renames a user", async () => {
    const tenant = await createTenant("patch-name");
    const email = `patch-name-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const user = await provision(tenant, email);

    const res = await scim(tenant, "PATCH", `/scim/v2/Users/${user.id}`, {
      Operations: [
        { op: "replace", path: "name.givenName", value: "Ada" },
        { op: "replace", path: "name.familyName", value: "Lovelace" },
      ],
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await userRepository.findById(user.id))?.name, "Ada Lovelace");
  });

  it("cannot PATCH a user from another organization", async () => {
    const a = await createTenant("patch-iso-a");
    const b = await createTenant("patch-iso-b");
    const userInB = await addMember(b.organization, "patch-target");

    const res = await scim(a, "PATCH", `/scim/v2/Users/${userInB.id}`, {
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    assert.equal(res.statusCode, 404);
    assert.equal((await userRepository.findById(userInB.id))?.isActive, true);
  });

  it("serves the service provider configuration", async () => {
    const tenant = await createTenant("config");
    const res = await scim(tenant, "GET", "/scim/v2/ServiceProviderConfig");
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().patch.supported, true);
    assert.equal(res.json().authenticationSchemes[0].type, "oauthbearertoken");
  });
});

describe("SCIM repository scoping", () => {
  it("findByIdInOrg does not resolve a user outside the organization", async () => {
    const a = await createTenant("repo-a");
    const b = await createTenant("repo-b");
    const userInB = await addMember(b.organization, "repo-target");

    assert.equal(await userRepository.findByIdInOrg(a.organization.id, userInB.id), undefined);
    assert.ok(await userRepository.findByIdInOrg(b.organization.id, userInB.id));
  });

  it("updateInOrg does not write a user outside the organization", async () => {
    const a = await createTenant("repo-update-a");
    const b = await createTenant("repo-update-b");
    const userInB = await addMember(b.organization, "repo-update-target");
    const before = userInB.name;

    const result = await userRepository.updateInOrg(a.organization.id, userInB.id, { name: "nope" });
    assert.equal(result, undefined);
    assert.equal((await userRepository.findById(userInB.id))?.name, before);
  });

  it("updateInOrg writes a member of the organization", async () => {
    const tenant = await createTenant("repo-update-ok");
    const user = await addMember(tenant.organization, "repo-ok");

    const result = await userRepository.updateInOrg(tenant.organization.id, user.id, { name: "Renamed" });
    assert.equal(result?.name, "Renamed");
  });

  it("removeFromOrg reports a user that is not a member", async () => {
    const a = await createTenant("repo-remove-a");
    const b = await createTenant("repo-remove-b");
    const userInB = await addMember(b.organization, "repo-remove-target");

    const result = await userRepository.removeFromOrg(a.organization.id, userInB.id);
    assert.equal(result?.outcome, "not_found");
    assert.equal((await userRepository.findById(userInB.id))?.isActive, true);
  });

  it("groups are only reachable through their organization", async () => {
    const a = await createTenant("group-repo-a");
    const b = await createTenant("group-repo-b");
    const [created] = await db
      .insert(scimGroups)
      .values({ orgId: b.organization.id, displayName: `repo-${crypto.randomUUID().slice(0, 6)}` })
      .returning();

    assert.equal(await app.container.scimGroupRepository.findByIdInOrg(a.organization.id, created.id), undefined);
    assert.ok(await app.container.scimGroupRepository.findByIdInOrg(b.organization.id, created.id));
    assert.equal(await app.container.scimGroupRepository.deleteInOrg(a.organization.id, created.id), false);
    assert.ok(await db.select().from(scimGroups).where(eq(scimGroups.id, created.id)));
  });
});

describe("SCIM audit trail", () => {
  it("attributes the connection and organization on every mutation", async () => {
    const tenant = await createTenant("audit");
    const email = `audit-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const user = await provision(tenant, email);

    const { auditLog } = await import("../../../db/schema.js");
    const rows = await db
      .select()
      .from(auditLog)
      .where(sql`event like 'scim_user%'`)
      .orderBy(sql`created_at desc`);

    const record = rows.find((row) => (row.metadata as Record<string, unknown>)?.targetUserId === user.id);
    assert.ok(record, "a SCIM audit row should exist for the provisioning");
    assert.equal(record.orgId, tenant.organization.id);
    assert.equal(record.userId, null, "the actor is the credential, not a platform user");
    assert.match(record.event, /^scim_user_created:v\d+$/);

    const metadata = record.metadata as Record<string, unknown>;
    assert.equal(metadata.scimConnectionId, tenant.connectionId);
    assert.equal(metadata.actorType, "scim");
    assert.equal(metadata.scimOrgId, tenant.organization.id);
  });
});
