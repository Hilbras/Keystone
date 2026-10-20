#!/usr/bin/env node
import { Command } from "commander";

/**
 * Run a command body, then release the connections it opened.
 *
 * Without this, **every command that opens a connection hangs**. `db` is a
 * module-level `postgres` pool and `redis` is a module-level `Redis`; an open
 * socket is a live handle, so the process never reaches an empty event loop and
 * never exits. The operator sees a command that produced its output and never
 * returns, with no way to tell whether it worked — and the natural response,
 * Ctrl-C, destroys the exit code that would have said so. `keystone migrate` is
 * the command somebody runs when the server will not start.
 *
 * Both are released, and it took both. Closing only the pool left
 * `initializeContainer()`'s three Redis sockets open and the command still hung,
 * which is worth writing down because the first fix looked complete: `migrate`
 * and `keys:list` exited, and `user:create` and `org:create` did not, and the
 * difference was the container.
 *
 * Released in a `finally` so a failing command still exits, and the body still
 * owns its own error reporting: this is about the handle, not the outcome.
 */
async function withReleasedConnections<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } finally {
    const { closeDb } = await import("./db/index.js");
    const { closeRedis } = await import("./services/redis.js");
    // The cache holds a *third* client, created in its constructor rather than
    // from the shared module. `migrate` and `keys:list` exit without it; anything
    // that builds the container — `user:create`, `org:create` — does not.
    const { cache } = await import("./services/cache.js");
    // And a **fourth**, when the queue provider is BullMQ: it owns its own Redis
    // connections, which nothing above releases.
    //
    // This was invisible because the default provider is `in-process` and that
    // setting is what CI runs, so every command exited. A deployment that followed
    // the roadmap's own §2.1 advice — `KEYSTONE_QUEUE_PROVIDER=bullmq` in
    // production — got a CLI where `user:create` and `org:create` printed their
    // success line and then hung forever, which is the exact defect this file's
    // `withReleasedConnections` exists to prevent. Finding it needed a local
    // `.env` that sets a provider CI never sees.
    const { queue } = await import("./services/queue/index.js");
    await closeDb().catch(() => {});
    await cache.close().catch(() => {});
    await queue.close?.().catch(() => {});
    await closeRedis().catch(() => {});
  }
}

const program = new Command();

// Read from package.json rather than repeating the number. It was hardcoded at
// "1.9.0" while the package was at 3.3.0, so `keystone --version` — the first
// thing anyone runs when filing a bug report — answered with a version three
// minor majors and two years out of date, and nothing noticed, because a test
// that asserted "1.9.0" would have passed just as long as nobody remembered to
// update it.
const packageVersion = (await import("../package.json", { with: { type: "json" } })).default.version;

program.name("keystone").description("Hilbras Keystone CLI").version(packageVersion);

program
  .command("init")
  .description("Create a sample .env file for Keystone")
  .action(async () => {
    console.log("Keystone init: copy .env.example and configure DATABASE_URL, ZITADEL_DOMAIN, etc.");
  });

program
  .command("migrate")
  .description("Run database migrations")
  // §6.5. Without this, "migrations applied" means only that the journal ran.
  // A stale restore or an interrupted migration still prints that line and then
  // fails per request, so the check is a separate, explicit step an operator (or
  // `scripts/migrate.sh`) asks for.
  .option("--verify", "Verify that every table the application expects exists")
  .action(async (options: { verify?: boolean }) =>
    withReleasedConnections(async () => {
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      const { db } = await import("./db/index.js");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      await migrate(db, { migrationsFolder: path.resolve(__dirname, "./db/migrations") });
      console.log("Migrations applied");

      if (options.verify) {
        const { verifySchema } = await import("./db/verifySchema.js");
        const result = await verifySchema();
        if (!result.ok) {
          console.error(
            `Schema verification failed: ${result.missing.length} table(s) missing — ${result.missing.join(", ")}`
          );
          // Set rather than exit: the `finally` above must still release the
          // sockets, and an immediate exit would leave the pool open.
          process.exitCode = 1;
          return;
        }
        console.log(`Schema verified (${result.expected.length} tables)`);
      }
    })
  );

program
  .command("schema:verify")
  .description("Check that every table the application expects exists, without migrating")
  // §6.5. Separate from `migrate --verify` because the interesting use is *after*
  // something else migrated — a container start, a restore, a rollback — and
  // re-running migrations to answer "is the schema intact?" is a surprising side
  // effect for a read-only question.
  .action(async () =>
    withReleasedConnections(async () => {
      const { verifySchema } = await import("./db/verifySchema.js");
      const result = await verifySchema();
      if (!result.ok) {
        console.error(
          `Schema verification failed: ${result.missing.length} table(s) missing — ${result.missing.join(", ")}`
        );
        process.exitCode = 1;
        return;
      }
      console.log(`Schema verified (${result.expected.length} tables)`);
    })
  );

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
  .action(async () =>
    withReleasedConnections(async () => {
      const { rotateSigningKeys } = await import("./services/secrets/index.js");
      // The failure is reported and the exit code set, because an exception out
      // of an async commander action is an unhandled rejection and the process
      // still exits 0 — so an operator running a rotation during an incident saw
      // a success (SEC-055).
      try {
        const pair = await rotateSigningKeys();
        console.log(`Rotated signing key. New key id: ${pair.keyId}`);
      } catch (err) {
        console.error(`Signing key was NOT rotated: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    })
  );

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
    }) =>
      withReleasedConnections(async () => {
        if (options.role !== "owner" && options.role !== "user") {
          console.error("Role must be either owner or user");
          process.exitCode = 1;
          return;
        }

        // The signing keys have to be loaded before the first token is minted.
        // Without this, `user:create` — the command that creates the platform
        // owner, so the first thing anyone runs on a new deployment — always
        // failed with "JWT signing keys not loaded" (SEC-055). The server calls
        // this during bootstrap; the CLI never did.
        const { loadSigningKeys } = await import("./services/tokens.js");
        await loadSigningKeys();

        const { initializeContainer } = await import("./di.js");
        const { AuthenticationDomainService } = await import("./services/domain/index.js");
        const { MfaService } = await import("./services/mfa.js");
        const container = initializeContainer();
        const authService = new AuthenticationDomainService(
          container.userRepository,
          container.applicationRepository,
          container.organizationRepository,
          new MfaService(container.mfaChallengeRepository, container.userRepository),
          container.passwordResetTokenRepository
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
          process.exitCode = 1;
          return;
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
      })
  );

program
  .command("org:create")
  .description("Create a new organization")
  .requiredOption("--name <name>", "Organization name")
  .option("--slug <slug>", "Organization slug")
  .option("--plan <plan>", "Billing plan", "free")
  .requiredOption("--owner-email <email>", "Existing platform user email that will own the organization")
  .action(
    async (options: { name: string; slug?: string; plan: string; ownerEmail: string }) =>
      withReleasedConnections(async () => {
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
        process.exitCode = 1;
        return;
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
        process.exitCode = 1;
        return;
      }
      const org = orgResult.data;
      console.log(`Created organization ${org.id} (${org.slug})`);
    })
  );

program
  .command("keys:list")
  .description("List active JWT signing keys")
  .action(async () =>
    withReleasedConnections(async () => {
      const { listActiveSigningKeys } = await import("./services/secrets/index.js");
      const keys = await listActiveSigningKeys();
      for (const key of keys) {
        console.log(`${key.keyId}\tcreated=${key.createdAt.toISOString()}\texpires=${key.expiresAt?.toISOString() ?? "never"}`);
      }
    })
  );

program
  .command("config:validate")
  .description("Validate required configuration and print status")
  .action(async () => {
    const { config } = await import("./config.js");
    const required = ["DATABASE_URL"];
    // Allowed bootstrap read: `required` holds arbitrary variable names, which config's fixed keys cannot index; documented bootstrap site.
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
