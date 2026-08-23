import { sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { redis } from "../redis.js";
import { getPublicJwks } from "../tokens.js";

export interface DiagnosticCheck {
  name: string;
  status: "ok" | "error" | "warning" | "skipped";
  message?: string;
}

export async function runSetupDiagnostics(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  // Database
  try {
    if (db) {
      await db.execute(sql`SELECT 1`);
      checks.push({ name: "Database connectivity", status: "ok" });
    } else {
      checks.push({ name: "Database connectivity", status: "error", message: "Database not initialized" });
    }
  } catch (err) {
    checks.push({ name: "Database connectivity", status: "error", message: err instanceof Error ? err.message : String(err) });
  }

  // Redis
  try {
    if (redis.status === "ready" || redis.status === "connect") {
      await redis.ping();
      checks.push({ name: "Redis connectivity", status: "ok" });
    } else {
      checks.push({ name: "Redis connectivity", status: "warning", message: "Redis not connected" });
    }
  } catch (err) {
    checks.push({ name: "Redis connectivity", status: "error", message: err instanceof Error ? err.message : String(err) });
  }

  // JWT keys
  try {
    const jwks = await getPublicJwks();
    if (jwks.keys.length > 0) {
      checks.push({ name: "JWT signing keys", status: "ok", message: `${jwks.keys.length} key(s) available` });
    } else {
      checks.push({ name: "JWT signing keys", status: "error", message: "No signing keys available" });
    }
  } catch (err) {
    checks.push({ name: "JWT signing keys", status: "error", message: err instanceof Error ? err.message : String(err) });
  }

  // Internal API key
  if (config.INTERNAL_API_KEY) {
    checks.push({ name: "Internal API key", status: "ok" });
  } else {
    checks.push({ name: "Internal API key", status: "warning", message: "Internal API key is not set" });
  }

  // Email provider
  if (config.EMAIL_PROVIDER === "none") {
    checks.push({ name: "Email provider", status: "skipped", message: "No email provider configured" });
  } else if (config.EMAIL_PROVIDER === "console") {
    checks.push({ name: "Email provider", status: "ok", message: "Console email provider" });
  } else {
    checks.push({ name: "Email provider", status: "ok", message: `${config.EMAIL_PROVIDER} configured` });
  }

  // Allowed origins
  if (config.ALLOWED_ORIGINS.length > 0) {
    checks.push({ name: "CORS origins", status: "ok", message: `${config.ALLOWED_ORIGINS.length} origin(s) configured` });
  } else {
    checks.push({ name: "CORS origins", status: "warning", message: "No allowed origins configured" });
  }

  return checks;
}
