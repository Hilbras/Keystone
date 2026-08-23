import type { KeystoneEvent } from "./types.js";
import { eventVersion } from "./types.js";
import type { EmittableEvent } from "./bus.js";

export interface EventValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_EVENT_TYPES = new Set([
  "user_registered",
  "user_login",
  "user_login_failed",
  "user_logout",
  "token_refresh",
  "token_refresh_failed",
  "oauth_callback",
  "oauth2_authorize",
  "oauth2_token",
  "oauth2_client_credentials",
  "oauth2_revoke",
  "oauth2_consent",
  "password_reset_requested",
  "password_reset_completed",
  "api_key_created",
  "api_key_revoked",
  "api_key_used",
  "service_account_created",
  "service_account_updated",
  "unauthorized_access",
  "organization_created",
  "organization_updated",
  "organization_plan_updated",
  "billing_customer_provisioned",
  "organization_member_invited",
  "organization_member_removed",
  "organization_member_role_updated",
  "permission_created",
  "permission_deleted",
  "application_created",
  "application_updated",
  "magic_link_sent",
  "magic_link_verified",
  "totp_enrolled",
  "totp_verify_failed",
  "totp_enabled",
  "totp_disable_failed",
  "totp_disabled",
  "webauthn_registered",
  "webauthn_authenticated",
  "new_device_detected",
  "sms_otp_sent",
  "sms_otp_verify_failed",
  "sms_otp_verified",
  "authz_check",
  "saml_sso_login",
  "saml_connection_created",
  "saml_connection_deleted",
  "oidc_enterprise_login",
  "oidc_connection_created",
  "oidc_connection_deleted",
  "scim_user_created",
  "scim_user_updated",
  "scim_user_deleted",
  "federation_login",
  "workflow_triggered",
  "workflow_step_executed",
  "workflow_created",
  "workflow_deleted",
  "platform_user_updated",
  "platform_user_deactivated",
  "platform_signing_key_rotated",
  "platform_plugin_unregistered",
  "platform_feature_flag_updated",
  "platform_feature_flag_deleted",
  "profile_updated",
  "email_verification_sent",
  "email_verified",
  "platform_webhook_created",
  "platform_webhook_deleted",
]);

export function validateEvent(event: EmittableEvent): EventValidationResult {
  const errors: string[] = [];

  if (!event.type || typeof event.type !== "string") {
    errors.push("Event type is required and must be a string");
    return { valid: false, errors };
  }

  if (!VALID_EVENT_TYPES.has(event.type)) {
    errors.push(`Unknown event type: ${event.type}`);
  }

  if (event.version !== undefined && (typeof event.version !== "number" || event.version < 1)) {
    errors.push("Event version must be a positive integer");
  }

  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    errors.push("Event payload must be an object");
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeEvent(event: EmittableEvent): KeystoneEvent {
  const validation = validateEvent(event);
  if (!validation.valid) {
    throw new Error(`Invalid event: ${validation.errors.join("; ")}`);
  }

  return {
    type: event.type,
    version: event.version ?? eventVersion(event.type),
    timestamp: new Date(),
    payload: event.payload,
  };
}
