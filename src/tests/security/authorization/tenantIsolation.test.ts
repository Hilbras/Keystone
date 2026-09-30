import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Organization, User } from "../../../db/schema.js";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "tenant-isolation-test-key";
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
const { organizations, orgMemberships, users } = await import("../../../db/schema.js");
const { buildApp } = await import("../../../index.js");
const { loadSigningKeys } = await import("../../../services/tokens.js");
const { createTokenSet } = await import("../../../services/tokens.js");

/**
 * Cross-tenant isolation for the organization-scoped administration surface.
 *
 * ## Why this exists, and why it is a test rather than a check
 *
 * `review-api-surface.mjs` reports 43 routes as "authenticated, no authorization
 * guard". That is not 43 problems, and treating it as 43 problems is the mistake this
 * suite exists to prevent.
 *
 * The tool finds a *named* guard in a route's own declaration — `app.requirePermission`,
 * `requireOrganizationRole`, `requirePlatformRole`, `requireOwner`. This repository
 * authorizes in three places, and the tool sees one:
 *
 * 1. a named preHandler,
 * 2. the handler body (`assertSetupToken`, a `role === "owner"` branch),
 * 3. **the application service** — `sdk.organization.getOrganization(userId, orgId)`
 *    calls `requireOrganizationPermission(userId, orgId, ["owner","admin","member"],
 *    "organization", "read")` and audits the denial.
 *
 * So for a route in category (3) the tool's "no authorization guard" means *this tool
 * cannot see the guard*, which is a statement about the tool and not about the route.
 * A static check cannot resolve it: the check would have to be a different check, and
 * the code that performs the authorization is the code under test.
 *
 * The only instrument that can answer "can a user from another tenant read this?" is
 * one that **tries it**. That is what this does: two organizations, two owners, and
 * every organization-scoped collection route is read by the *wrong* tenant's owner.
 *
 * ## What a pass proves, and what it does not
 *
 * It proves the routes deny cross-tenant reads for these shapes. It does not prove each
 * route's authorization is *minimal* — an owner reading their own billing is not
 * tested for whether a member could. Narrowing that is per-route work and belongs with
 * whoever owns the route.
 *
 * It also proves nothing about routes not listed in {@link COLLECTION_ROUTES}. The list
 * is derived from the review tool's own enumeration rather than written by hand, so a new
 * organization-scoped collection route cannot be added without appearing here.
 */
let app: FastifyInstance;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * The organization-scoped collection routes, taken from the review tool.
 *
 * Read from `review-api-surface.mjs --json` rather than tabulated, for the same reason
 * the tool derives its mount prefixes: a hand-kept list is one more thing to forget, and
 * a route added to a new file would simply be absent from it — which is the failure
 * this whole exercise is about.
 */
async function collectionRoutes(): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  // Four levels up, not three. This file sits in `tests/security/authorization/`, so
  // `../../..` lands on `dist/` when the suite runs compiled — where there is no
  // `dist/scripts/`, because the build copies migrations and not scripts. The test
  // failed with a bare module-not-found, which says nothing about isolation.
  const script = path.resolve(__dirname, "../../../../scripts/review-api-surface.mjs");
  const { stdout } = await run(process.execPath, [script, "--json"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const report = JSON.parse(stdout) as { routes: { method: string; url: string }[] };
  return report.routes
    .filter((r) => r.method === "GET" && /^\/v1\/admin\/organizations\/:id(?:\/|$)/.test(r.url))
    .map((r) => r.url)
    .filter((url) => {
      // A collection, not a member: the tail after `:id` must not itself be a `:param`.
      const tail = url.replace("/v1/admin/organizations/:id", "");
      return tail === "" || !/:/.test(tail);
    })
    .sort();
}

interface Tenant {
  organization: Organization;
  owner: User;
  token: string;
}

async function createTenant(label: string): Promise<Tenant> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await app.container.userRepository.create({
    email: `${label}-${suffix}@example.com`,
    username: `${label}-${suffix}`,
    name: `${label} owner`,
    emailVerified: true,
  });
  createdUserIds.push(owner.id);
  const organization = await app.container.organizationRepository.createWithOwner(
    { name: `${label}-${suffix}`, slug: `${label}-${suffix}` },
    owner.id
  );
  createdOrgIds.push(organization.id);
  const tokens = await createTokenSet(owner);
  return { organization, owner, token: tokens.accessToken };
}

/** A user with no membership in either tenant. */
async function createOutsider(): Promise<User> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await app.container.userRepository.create({
    email: `outsider-${suffix}@example.com`,
    username: `outsider-${suffix}`,
    name: `outsider ${suffix}`,
    emailVerified: true,
  });
  createdUserIds.push(user.id);
  return user;
}

async function outsiderToken(user: User): Promise<string> {
  return (await createTokenSet(user)).accessToken;
}

before(async () => {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../../db/migrations") });
  await loadSigningKeys();
  app = await buildApp();
  await app.container.permissionRepository.ensureRolePermissionsSeeded();
});

after(async () => {
  await app?.close();
  // Memberships first, by organization. This suite creates a membership per tenant via
  // `createWithOwner`, and the previous version of this block deleted memberships by a
  // hardcoded nil user id — a row that cannot exist, so a line that looked like cleanup
  // and removed nothing while relying on an unverified cascade. Order matters: the
  // membership rows reference both the organization and the user.
  if (createdOrgIds.length) {
    await db
      .delete(orgMemberships)
      .where(inArray(orgMemberships.orgId, createdOrgIds))
      .catch(() => {});
  }
  if (createdOrgIds.length) {
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  const { closeDb } = await import("../../../db/index.js");
  await closeDb().catch(() => {});
});

describe("cross-tenant isolation for organization-scoped administration", () => {
  it("finds the organization-scoped collection routes to probe", async () => {
    const routes = await collectionRoutes();
    assert.ok(
      routes.length >= 10,
      `expected the review tool to enumerate the org-scoped collections, found ${routes.length}: ${routes.join(", ")}`
    );
    assert.ok(
      routes.includes("/v1/admin/organizations/:id"),
      "the organization itself must be in the set, or this suite is probing nothing"
    );
  });

  it("refuses every organization-scoped collection to the owner of a different organization", async () => {
    const routes = await collectionRoutes();
    const alpha = await createTenant("alpha");
    const beta = await createTenant("beta");

    for (const route of routes) {
      const url = route.replace(":id", beta.organization.id);
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${alpha.token}` },
      });
      assert.ok(
        res.statusCode === 403 || res.statusCode === 404,
        `${route} answered ${res.statusCode} to the owner of another organization. ` +
          `A cross-tenant read must be refused; 404 is acceptable so the route does not ` +
          `confirm the organization exists. Body: ${res.body.slice(0, 200)}`
      );
    }
  });

  it("refuses every organization-scoped collection to a user with no membership at all", async () => {
    // The stronger case. The previous test's caller *is* an owner, of somewhere; this
    // one belongs to no organization, so nothing about the request is legitimate.
    const routes = await collectionRoutes();
    const target = await createTenant("target");
    const outsider = await createOutsider();
    const token = await outsiderToken(outsider);

    for (const route of routes) {
      const url = route.replace(":id", target.organization.id);
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.ok(
        res.statusCode === 403 || res.statusCode === 404,
        `${route} answered ${res.statusCode} to a user with no membership. ` +
          `Body: ${res.body.slice(0, 200)}`
      );
    }
  });

  it("still serves the organization to its own owner, so the refusals above are not a blanket 404", async () => {
    // Without this the suite passes just as well if every route 404s for everyone —
    // which is a server that is not serving, not one that is protecting.
    const tenant = await createTenant("self");
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${tenant.organization.id}`,
      headers: { authorization: `Bearer ${tenant.token}` },
    });
    assert.equal(
      res.statusCode,
      200,
      `the owner must be able to read their own organization. Body: ${res.body.slice(0, 200)}`
    );
    assert.equal(res.json().id, tenant.organization.id);
  });
});
