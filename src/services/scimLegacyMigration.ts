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
    // Adopt at most once, in any state. Checking only for an *active*
    // connection would re-create the credential after an operator revoked it,
    // silently undoing the incident response on the next deploy.
    const existing = await connections.listByOrg(orgId);
    if (existing.length > 0) {
      if (existing.every((connection) => connection.revokedAt !== null)) {
        console.warn(
          `[scim] SCIM_BEARER_TOKEN/SCIM_ORG_ID are still set for org ${orgId} but its connection was revoked. ` +
            "The legacy variables are ignored; remove them to clear this warning."
        );
      }
      return;
    }

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
