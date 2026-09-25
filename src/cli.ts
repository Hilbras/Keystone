#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program.name("keystone").description("Hilbras Keystone CLI").version("1.9.0");

program
  .command("init")
  .description("Create a sample .env file for Keystone")
  .action(async () => {
    console.log("Keystone init: copy .env.example and configure DATABASE_URL, ZITADEL_DOMAIN, etc.");
  });

program
  .command("migrate")
  .description("Run database migrations")
  .action(async () => {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const { db } = await import("./db/index.js");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "./db/migrations") });
    console.log("Migrations applied");
  });

program
  .command("keys:create")
  .description("Generate a JWT signing key pair")
  .action(async () => {
    const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privateKey = await exportPKCS8(pair.privateKey);
    const publicKey = await exportSPKI(pair.publicKey);
    console.log("JWT_PRIVATE_KEY=");
    console.log(privateKey);
    console.log("JWT_PUBLIC_KEY=");
    console.log(publicKey);
  });

program
  .command("secrets:rotate")
  .description("Rotate the active JWT signing key")
  .action(async () => {
    const { rotateSigningKeys } = await import("./services/secrets/index.js");
    const pair = await rotateSigningKeys();
    console.log(`Rotated signing key. New key id: ${pair.keyId}`);
  });

program
  .command("user:create")
  .description("Create a local user account")
  .requiredOption("--email <email>", "User email")
  .requiredOption("--password <password>", "User password")
  .option("--username <username>", "Username")
  .option("--name <name>", "Display name")
  .option("--role <role>", "Platform role (owner or user)", "user")
  .action(
    async (options: {
      email: string;
      password: string;
      username?: string;
      name?: string;
      role: string;
    }) => {
      const { initializeContainer } = await import("./di.js");
      const { AuthenticationDomainService } = await import("./services/domain/index.js");
      if (options.role !== "owner" && options.role !== "user") {
        console.error("Role must be either owner or user");
        process.exit(1);
      }

      const { MfaService } = await import("./services/mfa.js");
      const container = initializeContainer();
      const authService = new AuthenticationDomainService(
        container.userRepository,
        container.applicationRepository,
        container.organizationRepository,
        new MfaService(container.mfaChallengeRepository, container.userRepository)
      );
      const result = await authService.register({
        email: options.email,
        password: options.password,
        username:
          options.username ||
          options.email.split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32),
        name: options.name,
      });

      if (!result.success) {
        console.error(`Failed to create user: ${result.error.message}`);
        process.exit(1);
      }

      if (options.role === "owner") {
        await container.userRepository.updateRole(result.data.user.id, "owner");
        const { persistAudit } = await import("./services/audit.js");
        await persistAudit({
          event: "platform_role_changed",
          metadata: { actor: "cli", targetUserId: result.data.user.id, newRole: "owner" },
        });
      }

      console.log(`Created user ${result.data.user.id} (${result.data.user.email}) with role ${options.role}`);
    }
  );

program
  .command("org:create")
  .description("Create a new organization")
  .requiredOption("--name <name>", "Organization name")
  .option("--slug <slug>", "Organization slug")
  .option("--plan <plan>", "Billing plan", "free")
  .requiredOption("--owner-email <email>", "Existing platform user email that will own the organization")
  .action(async (options: { name: string; slug?: string; plan: string; ownerEmail: string }) => {
    const { initializeContainer } = await import("./di.js");
    const { OrganizationDomainService } = await import("./services/domain/index.js");
    const { DrizzleUserRepository } = await import("./repositories/index.js");
    const container = initializeContainer();
    const orgService = new OrganizationDomainService(
      container.organizationRepository,
      container.applicationRepository
    );
    const users = new DrizzleUserRepository();
    const owner = await users.findByEmail(options.ownerEmail);
    if (!owner) {
      console.error(`Owner email ${options.ownerEmail} not found; organization was not created`);
      process.exit(1);
    }

    const orgResult = await orgService.createOrganization(
      {
        name: options.name,
        slug: options.slug,
        plan: options.plan,
      },
      owner.id
    );
    if (!orgResult.success) {
      console.error(`Failed to create organization: ${orgResult.error.message}`);
      process.exit(1);
    }
    const org = orgResult.data;
    console.log(`Created organization ${org.id} (${org.slug})`);
  });

program
  .command("keys:list")
  .description("List active JWT signing keys")
  .action(async () => {
    const { listActiveSigningKeys } = await import("./services/secrets/index.js");
    const keys = await listActiveSigningKeys();
    for (const key of keys) {
      console.log(`${key.keyId}\tcreated=${key.createdAt.toISOString()}\texpires=${key.expiresAt?.toISOString() ?? "never"}`);
    }
  });

program
  .command("config:validate")
  .description("Validate required configuration and print status")
  .action(async () => {
    const { config } = await import("./config.js");
    const required = ["DATABASE_URL"];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      console.error(`Missing required environment variables: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log("Configuration OK");
    console.log(`  DATABASE_URL: ${config.DATABASE_URL.replace(/\/\/.*@/, "//***@")}`);
    console.log(`  REDIS_URL: ${config.REDIS_URL.replace(/\/\/.*@/, "//***@")}`);
    console.log(`  Queue provider: ${config.KEYSTONE_QUEUE_PROVIDER || "auto"}`);
    console.log(`  Secrets provider: ${config.KEYSTONE_SECRETS_PROVIDER}`);
  });

program.parse();
