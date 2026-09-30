import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Connection lifecycle, not the client. This route establishes the pool against a
// configuration file the operator has just written, which is why it needs
// `initDb` — and it is the only route that does. See src/db/lifecycle.ts.
import { initDb, isDatabaseInitialized, runMigrations } from "../db/lifecycle.js";
import { AuthenticationDomainService } from "../services/domain/authentication.js";
import {
  DrizzleUserRepository,
  DrizzleApplicationRepository,
  DrizzleOrganizationRepository,
  DrizzleMfaChallengeRepository,
} from "../repositories/index.js";
import { MfaService } from "../services/mfa.js";
import { validateDatabase, validateRedis, validateEmail, validateSms } from "../services/setup/validation.js";
import { createConfigWriter } from "../services/setup/configWriter.js";
import { writeSetupMarker } from "../services/setup/setupMarker.js";
import { getSetupToken, validateSetupToken } from "../services/setup/token.js";
import { runSetupDiagnostics } from "../services/setup/diagnostics.js";
import { redactConfigurationValues } from "../services/configuration/profiles.js";
import { queue } from "../services/queue/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP_MARKER_PATH = path.resolve(__dirname, "../../.keystone-setup-complete");

const SetupInitSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
  username: z.string().optional(),
});

const ValidateDatabaseSchema = z.object({
  databaseUrl: z.string().min(1),
});

const ValidateRedisSchema = z.object({
  redisUrl: z.string().min(1),
});

const ValidateEmailSchema = z.object({
  provider: z.enum(["none", "console", "smtp", "sendgrid", "mailgun"]),
  from: z.string().email(),
  smtpHost: z.string().optional(),
  smtpPort: z.coerce.number().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpSecure: z.boolean().optional(),
  sendgridApiKey: z.string().optional(),
  mailgunApiKey: z.string().optional(),
  mailgunDomain: z.string().optional(),
  to: z.string().email(),
});

const ValidateSmsSchema = z.object({
  provider: z.enum(["none", "console", "twilio"]),
  twilioAccountSid: z.string().optional(),
  twilioAuthToken: z.string().optional(),
  twilioFromNumber: z.string().optional(),
  twilioMessagingServiceSid: z.string().optional(),
  to: z.string().min(1),
});

const SetupConfigSchema = z.object({
  env: z.record(z.string(), z.string()),
});

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    reply.status(400).send({ error: `Invalid input: ${issues}`, code: "VALIDATION_ERROR" });
    return null;
  }
  return result.data;
}

/**
 * Whether the platform has an owner yet.
 *
 * Through the repository rather than a `count()` on the users table, so this route
 * has no query of its own. The `catch` is unchanged and deliberate: this decides
 * whether the setup wizard is allowed to run, and a database that cannot answer
 * should not be read as "no owner, proceed" — except that it must, or an operator
 * recovering from a bad configuration would be locked out. The wizard is
 * protected by the setup token, so proceeding on an inconclusive read is the
 * lesser risk, and that is the same trade the original made.
 */
async function hasNoOwners(): Promise<boolean> {
  try {
    return (await new DrizzleUserRepository().countByRole("owner")) === 0;
  } catch {
    return true;
  }
}

async function ensureDbInitialized(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (isDatabaseInitialized()) return true;
  try {
    const writer = createConfigWriter();
    const values = await writer.read();
    const databaseUrl = values.DATABASE_URL;
    if (!databaseUrl) {
      request.log.warn({ configKeys: Object.keys(values) }, "DATABASE_URL missing when initializing database");
      reply.status(400).send({ error: "DATABASE_URL is not configured. Apply configuration first.", code: "DATABASE_URL_MISSING" });
      return false;
    }
    process.env.DATABASE_URL = databaseUrl;
    initDb();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    request.log.error({ err }, "Database initialization failed");
    reply.status(500).send({ error: message, code: "DB_INIT_FAILED" });
    return false;
  }
}

function assertSetupToken(request: FastifyRequest, reply: FastifyReply): boolean {
  const token = request.headers["x-setup-token"] as string | undefined;
  if (!validateSetupToken(token)) {
    request.log.warn(
      { hasToken: Boolean(token), tokenLength: token?.length, expectedLength: getSetupToken()?.length },
      "Invalid or missing setup token"
    );
    reply.status(401).send({ error: "Invalid or missing setup token" });
    return false;
  }
  return true;
}

export default async function setupRoutes(app: FastifyInstance) {
  app.get("/status", async () => {
    return {
      needsSetup: await hasNoOwners(),
      setupToken: Boolean(getSetupToken()),
    };
  });

  app.get("/diagnostics", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;
    const checks = await runSetupDiagnostics();
    return { checks, ready: checks.every((c) => c.status === "ok" || c.status === "skipped") };
  });

  app.post("/config/dry-run", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;
    const body = parseBody(SetupConfigSchema, request.body, reply);
    if (!body) return;

    const writer = createConfigWriter();
    const existing = await writer.read();
    const merged = { ...existing, ...body.env };

    const validationErrors: string[] = [];
    if (!merged.DATABASE_URL) validationErrors.push("DATABASE_URL is required");
    if (!merged.REDIS_URL) validationErrors.push("REDIS_URL is required");
    if (!merged.AUTH_API_PUBLIC_URL) validationErrors.push("AUTH_API_PUBLIC_URL is required");

    return {
      ok: validationErrors.length === 0,
      validationErrors,
      wouldWrite: Object.keys(body.env),
      mergedPreview: redactConfigurationValues(merged),
    };
  });

  app.post("/validate/db", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;
    const body = parseBody(ValidateDatabaseSchema, request.body, reply);
    if (!body) return;
    const result = await validateDatabase(body);
    if (!result.success) {
      request.log.warn({ code: result.error.code, message: result.error.message }, "Database validation failed");
      return reply.status(result.error.statusCode || 400).send({ error: result.error.message, code: result.error.code });
    }
    return { ok: true };
  });

  app.post("/validate/redis", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;
    const body = parseBody(ValidateRedisSchema, request.body, reply);
    if (!body) return;
    const result = await validateRedis(body);
    if (!result.success) {
      request.log.warn({ code: result.error.code, message: result.error.message }, "Redis validation failed");
      return reply.status(result.error.statusCode || 400).send({ error: result.error.message, code: result.error.code });
    }
    return { ok: true };
  });

  app.post("/validate/email", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;
    const body = parseBody(ValidateEmailSchema, request.body, reply);
    if (!body) return;
    const { to, ...input } = body;
    const result = await validateEmail(input, to);
    if (!result.success) {
      return reply.status(result.error.statusCode || 400).send({ error: result.error.message, code: result.error.code });
    }
    return { ok: true };
  });

  app.post("/validate/sms", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;
    const body = parseBody(ValidateSmsSchema, request.body, reply);
    if (!body) return;
    const { to, ...input } = body;
    const result = await validateSms(input, to);
    if (!result.success) {
      return reply.status(result.error.statusCode || 400).send({ error: result.error.message, code: result.error.code });
    }
    return { ok: true };
  });

  app.post("/config", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;

    const body = parseBody(SetupConfigSchema, request.body, reply);
    if (!body) return;
    const writer = createConfigWriter();

    const backup = await writer.backup();
    if (!backup.success) {
      return reply.status(backup.error.statusCode || 500).send({ error: backup.error.message, code: backup.error.code });
    }

    const writeResult = await writer.write(body.env);
    if (!writeResult.success) {
      return reply.status(writeResult.error.statusCode || 500).send({ error: writeResult.error.message, code: writeResult.error.code });
    }

    return { ok: true, backupPath: backup.data || undefined };
  });

  app.post("/migrate", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;
    if (!(await ensureDbInitialized(request, reply))) return;
    try {
      await runMigrations();
      return { ok: true };
    } catch (err) {
      request.log.error({ err }, "Migration failed");
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message, code: "MIGRATION_FAILED" });
    }
  });

  app.post("/restart", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;
    reply.status(202).send({ ok: true, message: "Server is restarting" });
    try {
      await queue.close?.();
    } catch {
      // ignore
    }
    setTimeout(() => process.exit(0), 500);
  });

  app.post("/init", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSetupToken(request, reply)) return;
    if (!(await ensureDbInitialized(request, reply))) return;
    if (!(await hasNoOwners())) {
      return reply.status(403).send({ error: "Setup has already been completed" });
    }

    const body = parseBody(SetupInitSchema, request.body, reply);
    if (!body) return;

    // If a user with this email already exists (e.g. from an interrupted setup),
    // promote them to owner instead of failing with a duplicate-key error.
    const userRepository = new DrizzleUserRepository();
    const existing = await userRepository.findByEmail(body.email);

    let ownerUser;
    let previousRole: string;
    if (existing) {
      previousRole = existing.role;
      ownerUser = (await userRepository.updateRole(existing.id, "owner")) ?? existing;
    } else {
      const authService = new AuthenticationDomainService(
        new DrizzleUserRepository(),
        new DrizzleApplicationRepository(),
        new DrizzleOrganizationRepository(),
        new MfaService(new DrizzleMfaChallengeRepository(), new DrizzleUserRepository())
      );
      const result = await authService.register({
        email: body.email,
        password: body.password,
        name: body.name,
        username:
          body.username ||
          body.email
            .split("@")[0]
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "-")
            .slice(0, 32),
      });

      if (!result.success) {
        return reply.status(400).send({ error: result.error.message });
      }

      previousRole = result.data.user.role;
      ownerUser = (await userRepository.updateRole(result.data.user.id, "owner")) ?? result.data.user;
    }

    await request.audit("platform_role_changed", {
      targetUserId: ownerUser.id,
      previousRole,
      newRole: "owner",
      action: "setup_bootstrap",
    });

    // Through a descriptor, like every other write in the setup flow (SEC-065). This file
    // was simply outside `keystone-config-writes-by-descriptor`'s scope until 3.5.9, which
    // is why it still called `fs.writeFile` — a rule scoped to the directory that happened
    // to hold the code being fixed stops being about the defect and starts being about the
    // folder. See `setupMarker.ts` for the shape.
    //
    // A refusal is logged and ignored, exactly as before: the marker records that setup
    // completed, and failing to record it must not fail the setup that did.
    try {
      await writeSetupMarker(SETUP_MARKER_PATH, new Date().toISOString());
    } catch (err) {
      request.log.warn({ err }, "Could not write setup completion marker");
    }

    return {
      user: {
        id: ownerUser.id,
        email: ownerUser.email,
        username: ownerUser.username,
        role: "owner",
      },
    };
  });
}
