import crypto from "node:crypto";
import { config } from "../config.js";
import { emit } from "./events/bus.js";
import type {
  CreateScimConnectionInput,
  ScimConnectionRepository,
} from "../repositories/types.js";
import { err, ok, type Result } from "../lib/result.js";

/**
 * SCIM credential lifecycle.
 *
 * A SCIM credential is always bound to exactly one organization. There is no
 * global SCIM configuration, and the bearer token is stored only as a SHA-256
 * digest, so neither a database dump nor a log line yields a usable token.
 */

const TOKEN_PREFIX = "ksc_";
const TOKEN_ENTROPY_BYTES = 32;

export interface IssuedScimToken {
  /** The only time the plaintext token is ever available. */
  token: string;
  tokenHash: string;
  tokenHint: string;
}

export function generateScimToken(): IssuedScimToken {
  const secret = crypto.randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");
  const token = `${TOKEN_PREFIX}${secret}`;
  return { token, tokenHash: hashScimToken(token), tokenHint: token.slice(-4) };
}

/**
 * Tokens are always high-entropy random values, so an unkeyed digest is
 * sufficient and keeps lookup a plain indexed equality check.
 */
export function hashScimToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export interface ScimCredentialOptions {
  expiresInDays?: number;
  rotationGraceSeconds?: number;
}

export class ScimConnectionService {
  constructor(private readonly connections: ScimConnectionRepository) {}

  async create(input: {
    orgId: string;
    name: string;
    createdByUserId?: string;
    options?: ScimCredentialOptions;
  }): Promise<Result<{ connectionId: string; token: string; tokenHint: string; expiresAt: Date | null }>> {
    const existing = await this.connections.findActiveByOrg(input.orgId);
    if (existing) {
      return err({
        code: "SCIM_CONNECTION_EXISTS",
        message: "This organization already has an active SCIM connection. Revoke it before creating another.",
        statusCode: 409,
      });
    }

    const issued = generateScimToken();
    const expiresAt = input.options?.expiresInDays
      ? new Date(Date.now() + input.options.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const record: CreateScimConnectionInput = {
      orgId: input.orgId,
      name: input.name,
      tokenHash: issued.tokenHash,
      tokenHint: issued.tokenHint,
      createdByUserId: input.createdByUserId ?? null,
      expiresAt,
    };

    try {
      const created = await this.connections.create(record);
      await emit({
        type: "scim_connection_created",
        payload: { orgId: input.orgId, connectionId: created.id, name: created.name },
      });
      return ok({
        connectionId: created.id,
        token: issued.token,
        tokenHint: issued.tokenHint,
        expiresAt,
      });
    } catch (error) {
      return err({
        code: "SCIM_CONNECTION_CREATE_FAILED",
        message: "Could not create the SCIM connection.",
        statusCode: 400,
        details: { reason: error instanceof Error ? error.message : "unknown" },
      });
    }
  }

  /**
   * Issue a new token. The previous token keeps working for the grace period so
   * an IdM does not lose provisioning mid-rotation.
   */
  async rotate(
    connectionId: string,
    options?: ScimCredentialOptions
  ): Promise<Result<{ token: string; tokenHint: string; previousTokenValidUntil: Date }>> {
    const connection = await this.connections.findById(connectionId);
    if (!connection) {
      return err({ code: "NOT_FOUND", message: "SCIM connection not found.", statusCode: 404 });
    }
    if (connection.revokedAt) {
      return err({ code: "SCIM_CONNECTION_REVOKED", message: "This SCIM connection is revoked.", statusCode: 409 });
    }

    const graceSeconds = options?.rotationGraceSeconds ?? config.SCIM_ROTATION_GRACE_SECONDS;
    const issued = generateScimToken();

    const rotated = await this.connections.rotate(connectionId, {
      tokenHash: issued.tokenHash,
      tokenHint: issued.tokenHint,
      graceSeconds,
    });
    if (!rotated) {
      return err({ code: "SCIM_ROTATION_FAILED", message: "Could not rotate the SCIM connection.", statusCode: 409 });
    }

    await emit({
      type: "scim_connection_rotated",
      payload: {
        orgId: connection.orgId,
        connectionId,
        graceSeconds,
        previousTokenValidUntil: rotated.previousTokenValidUntil?.toISOString(),
      },
    });

    return ok({
      token: issued.token,
      tokenHint: issued.tokenHint,
      previousTokenValidUntil: rotated.previousTokenValidUntil!,
    });
  }

  async revoke(connectionId: string): Promise<Result<{ orgId: string }>> {
    const revoked = await this.connections.revoke(connectionId);
    if (!revoked) {
      return err({ code: "NOT_FOUND", message: "No active SCIM connection with that id.", statusCode: 404 });
    }
    await emit({
      type: "scim_connection_revoked",
      payload: { orgId: revoked.orgId, connectionId },
    });
    return ok({ orgId: revoked.orgId });
  }
}
