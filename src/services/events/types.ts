export interface EventContext {
  requestId?: string;
  ip?: string;
  userAgent?: string;
  appId?: string;
}

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
  | "oauth2_refresh"
  | "oauth2_refresh_failed"
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
  | "permission_role_updated"
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
  | "workflow_blocked"
  | "platform_user_updated"
  | "platform_role_changed"
  | "platform_user_deactivated"
  | "platform_account_reviewed"
  | "platform_signing_key_rotated"
  | "platform_plugin_unregistered"
  | "platform_feature_flag_updated"
  | "platform_feature_flag_deleted"
  | "profile_updated"
  | "email_verification_sent"
  | "email_verified"
  | "platform_webhook_created"
  | "platform_webhook_updated"
  | "platform_webhook_deleted"
  | "platform_webhook_secret_rotated"
  | "federation_identity_linked"
  | "user_token_login"
  | "session_revoked"
  | "sessions_revoked_all"
  | "mfa_challenge_created"
  | "mfa_challenge_failed"
  | "mfa_challenge_expired"
  | "mfa_challenge_rejected"
  | "mfa_verified"
  | "mfa_bypass_blocked"
  | "mfa_backup_code_regenerated"
  | "scim_connection_created"
  | "scim_connection_rotated"
  | "scim_connection_revoked"
  | "scim_authentication_failed"
  | "scim_access_denied"
  | "scim_group_created"
  | "scim_group_updated"
  | "scim_group_deleted";
