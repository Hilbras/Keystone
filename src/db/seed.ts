import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "./index.js";
import { organizations, users, orgMemberships, applications, workflows } from "./schema.js";
import { config } from "../config.js";
import { createApplication, hashClientSecret } from "../services/applications.js";
import { hashPassword } from "../services/secrets.js";

async function seed() {
  const clientAppUrl = process.env.CLIENT_APP_URL || "http://localhost:5173";
  const aiAppUrl = process.env.AI_APP_URL || "http://localhost:5174";
  const landingAppUrl = process.env.LANDING_APP_URL || "http://localhost:5175";

  // Idempotently create the Hilbras organization.
  let [hilbrasOrg] = await db.select().from(organizations).where(eq(organizations.slug, "hilbras")).limit(1);
  if (!hilbrasOrg) {
    [hilbrasOrg] = await db
      .insert(organizations)
      .values({ name: "Hilbras", slug: "hilbras", plan: "enterprise" })
      .returning();
    console.log(`[seed] created organization ${hilbrasOrg.id}`);
  } else {
    console.log(`[seed] organization Hilbras already exists`);
  }

  const appDefinitions = [
    {
      name: "hilbras-os",
      clientId: "hilbras-os",
      secretEnv: "HILBRAS_OS_CLIENT_SECRET",
      defaultSecret: "cs_os_default_secret_replace_in_production",
      redirectUris: [`${clientAppUrl}/auth/callback`, `${clientAppUrl}/callback`],
      allowedOrigins: [clientAppUrl],
    },
    {
      name: "hilbras-ai",
      clientId: "hilbras-ai",
      secretEnv: "HILBRAS_AI_CLIENT_SECRET",
      defaultSecret: "cs_ai_default_secret_replace_in_production",
      redirectUris: [`${aiAppUrl}/auth/callback`, `${aiAppUrl}/callback`],
      allowedOrigins: [aiAppUrl],
    },
    {
      name: "hilbras-landing",
      clientId: "hilbras-landing",
      secretEnv: "HILBRAS_LANDING_CLIENT_SECRET",
      defaultSecret: "cs_landing_default_secret_replace_in_production",
      redirectUris: [`${landingAppUrl}/auth/callback`, `${landingAppUrl}/callback`],
      allowedOrigins: [landingAppUrl],
    },
  ];

  for (const def of appDefinitions) {
    const existing = await db.select().from(applications).where(eq(applications.clientId, def.clientId)).limit(1);
    if (existing.length > 0) {
      console.log(`[seed] application ${def.clientId} already exists`);
      continue;
    }

    const secret = process.env[def.secretEnv] || def.defaultSecret;
    const app = await createApplication({
      orgId: hilbrasOrg.id,
      name: def.name,
      clientId: def.clientId,
      clientSecret: secret,
      redirectUris: def.redirectUris,
      allowedOrigins: def.allowedOrigins,
    });
    console.log(`[seed] created application ${app.clientId} (${app.id})`);
  }

  // Ensure a seed owner exists and owns the Hilbras org.
  const ownerEmail = config.SEED_OWNER_EMAIL;
  const ownerPassword = process.env.KEYSTONE_SEED_OWNER_PASSWORD || crypto.randomUUID();
  if (ownerEmail) {
    let [owner] = await db.select().from(users).where(eq(users.email, ownerEmail.toLowerCase())).limit(1);
    if (!owner) {
      const username = ownerEmail.split("@")[0].replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
      [owner] = await db
        .insert(users)
        .values({
          email: ownerEmail.toLowerCase(),
          username,
          name: username,
          provider: "password",
          emailVerified: true,
          passwordHash: await hashPassword(ownerPassword),
        })
        .returning();
      console.log(`[seed] created owner user ${owner.id}`);
      if (!process.env.KEYSTONE_SEED_OWNER_PASSWORD) {
        console.log(`[seed] generated owner password: ${ownerPassword}`);
      }
    } else {
      console.log(`[seed] owner user already exists`);
    }

    const existingMembership = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, hilbrasOrg.id), eq(orgMemberships.userId, owner.id)))
      .limit(1);

    if (existingMembership.length === 0) {
      await db.insert(orgMemberships).values({
        orgId: hilbrasOrg.id,
        userId: owner.id,
        role: "owner",
      });
      console.log(`[seed] added owner membership`);
    }
  }

  // Seed the default signup workflow.
  const [existingWorkflow] = await db.select().from(workflows).where(eq(workflows.trigger, "user_registered")).limit(1);
  if (!existingWorkflow) {
    await db.insert(workflows).values({
      orgId: hilbrasOrg.id,
      name: "Default signup",
      trigger: "user_registered",
      definition: {
        steps: [
          { type: "assign_role", role: "user" },
          { type: "create_organization", orgName: "{{username}}-personal", slug: "{{username}}-personal", outputKey: "personalOrgId" },
          { type: "add_membership", orgRef: "personalOrgId", role: "owner" },
          { type: "add_app_membership", role: "member" },
          { type: "send_welcome_email" },
        ],
      },
    });
    console.log("[seed] created default signup workflow");
  } else {
    console.log("[seed] default signup workflow already exists");
  }

  console.log("[seed] done");
}

seed()
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    process.exit(0);
  });
