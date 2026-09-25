import { config } from "../config.js";
import { hashScimToken } from "./scimCredentials.js";
import type { ScimConnectionRepository } from "../repositories/types.js";

/**
 * One-time migration from the pre-1.9 single-tenant SCIM configuration.
 *
 * Before 1.9.0 SCIM was a pair of environment variables, which allowed exactly
 * one organization in a deployment to be provisioned and stored the bearer
 * token in plaintext. If those variables are still set and the organization has
 * no connection yet, adopt the token into a per-organization connection so an
 * upgrade does not break an existing IdM, and tell the operator to rotate.
 */
export async function migrateLegacyScimEnv(
  connections: ScimConnectionRepository
): Promise<void> {
  const token = config.SCIM_BEARER_TOKEN?.trim();
  const orgId = config.SCIM_ORG_ID?.trim();
  if (!token || !orgId) return;

  try {
    const existing = await connections.findActiveByOrg(orgId);
    if (existing) return;

    await connections.create({
      orgId,
      name: "Migrated from SCIM_BEARER_TOKEN",
      tokenHash: hashScimToken(token),
      tokenHint: token.slice(-4),
    });

    console.warn(
      `[scim] Adopted SCIM_BEARER_TOKEN/SCIM_ORG_ID into a per-organization connection for org ${orgId}. ` +
        "These variables are deprecated: rotate the token and remove them, then manage the connection through the API."
    );
  } catch (error) {
    // A failed adoption must not stop the server from booting; the SCIM routes
    // report "not configured" until an operator creates a connection.
    console.error("[scim] Failed to adopt the legacy SCIM configuration:", error);
  }
}
