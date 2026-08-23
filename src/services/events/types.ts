export interface EventPayload {
  userId?: string;
  orgId?: string;
  appId?: string;
  requestId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface KeystoneEvent {
  type: string;
  version: number;
  timestamp: Date;
  payload: EventPayload;
}

export type EventHandler = (event: KeystoneEvent) => void | Promise<void>;

export const EVENT_VERSIONS: Record<string, number> = {
  // Default version for all existing events.
  default: 1,
};

export function eventVersion(type: string): number {
  return EVENT_VERSIONS[type] ?? EVENT_VERSIONS.default;
}

export type AuditEventType =
  | "user_registered"
  | "user_login"
  | "user_login_failed"
  | "user_logout"
  | "token_refresh"
  | "token_refresh_failed"
  | "oauth_callback"
  | "oauth2_authorize"
  | "oauth2_token"
  | "oauth2_client_credentials"
  | "oauth2_revoke"
  | "oauth2_consent"
  | "password_reset_requested"
  | "password_reset_completed"
  | "api_key_created"
  | "api_key_revoked"
  | "api_key_used"
  | "service_account_created"
  | "service_account_updated"
  | "unauthorized_access"
  | "organization_created"
  | "organization_updated"
  | "organization_plan_updated"
  | "billing_customer_provisioned"
  | "organization_member_invited"
  | "organization_member_removed"
  | "organization_member_role_updated"
  | "permission_created"
  | "permission_deleted"
  | "application_created"
  | "application_updated"
  | "magic_link_sent"
  | "magic_link_verified"
  | "totp_enrolled"
  | "totp_verify_failed"
  | "totp_enabled"
  | "totp_disable_failed"
  | "totp_disabled"
  | "webauthn_registered"
  | "webauthn_authenticated"
  | "new_device_detected"
  | "sms_otp_sent"
  | "sms_otp_verify_failed"
  | "sms_otp_verified"
  | "authz_check"
  | "saml_sso_login"
  | "oidc_enterprise_login"
  | "saml_connection_created"
  | "saml_connection_deleted"
  | "oidc_connection_created"
  | "oidc_connection_deleted"
  | "scim_user_created"
  | "scim_user_updated"
  | "scim_user_deleted"
  | "federation_login"
  | "workflow_triggered"
  | "workflow_step_executed"
  | "workflow_created"
  | "workflow_deleted"
  | "platform_user_updated"
  | "platform_user_deactivated"
  | "platform_signing_key_rotated"
  | "platform_plugin_unregistered"
  | "platform_feature_flag_updated"
  | "platform_feature_flag_deleted"
  | "profile_updated"
  | "email_verification_sent"
  | "email_verified"
  | "platform_webhook_created"
  | "platform_webhook_deleted";
