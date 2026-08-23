import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  varchar,
  unique,
  smallint,
  integer,
} from "drizzle-orm/pg-core";

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    plan: text("plan").default("free").notNull(),
    branding: jsonb("branding").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index("organizations_slug_idx").on(table.slug),
  })
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    zitadelUserId: text("zitadel_user_id").unique(),
    email: text("email").notNull().unique(),
    username: text("username").notNull().unique(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    emailVerified: boolean("email_verified").default(false).notNull(),
    emailVerifiedToken: text("email_verified_token"),
    provider: text("provider").default("password").notNull(),
    plan: text("plan").default("free").notNull(),
    role: text("role").default("user").notNull(),
    defaultOrgId: uuid("default_org_id").references(() => organizations.id, { onDelete: "set null" }),
    phoneNumber: text("phone_number"),
    phoneVerified: boolean("phone_verified").default(false).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    passwordHash: text("password_hash"),
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").default(false).notNull(),
    totpVerifiedAt: timestamp("totp_verified_at", { withTimezone: true }),
    failedLoginAttempts: integer("failed_login_attempts").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    emailIdx: index("users_email_idx").on(table.email),
    zitadelIdx: index("users_zitadel_idx").on(table.zitadelUserId),
    defaultOrgIdx: index("users_default_org_idx").on(table.defaultOrgId),
  })
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenId: text("refresh_token_id").notNull(),
    deviceFingerprint: text("device_fingerprint"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("user_sessions_user_idx").on(table.userId),
    refreshTokenIdx: index("user_sessions_refresh_token_idx").on(table.refreshTokenId),
  })
);

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull().unique(),
    clientSecretHash: text("client_secret_hash").notNull(),
    name: text("name").notNull(),
    redirectUris: text("redirect_uris").array().default(sql`'{}'::text[]`).notNull(),
    allowedOrigins: text("allowed_origins").array().default(sql`'{}'::text[]`).notNull(),
    allowedIps: text("allowed_ips").array().default(sql`'{}'::text[]`).notNull(),
    blockedIps: text("blocked_ips").array().default(sql`'{}'::text[]`).notNull(),
    branding: jsonb("branding").default({}).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("applications_org_idx").on(table.orgId),
    clientIdIdx: index("applications_client_id_idx").on(table.clientId),
  })
);

export const orgMemberships = pgTable(
  "org_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("org_memberships_org_idx").on(table.orgId),
    userIdx: index("org_memberships_user_idx").on(table.userId),
    uniqueMembership: unique("org_memberships_unique").on(table.orgId, table.userId),
  })
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    appId: uuid("app_id").references(() => applications.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    deviceFingerprint: text("device_fingerprint"),
  },
  (table) => ({
    userIdx: index("refresh_tokens_user_idx").on(table.userId),
    appIdx: index("refresh_tokens_app_idx").on(table.appId),
    hashIdx: index("refresh_tokens_hash_idx").on(table.tokenHash),
  })
);

export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("service_accounts_org_idx").on(table.orgId),
  })
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    serviceAccountId: uuid("service_account_id").references(() => serviceAccounts.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    appId: uuid("app_id").references(() => applications.id, { onDelete: "set null" }),
    name: text("name"),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().default(sql`'{"api:read"}'::text[]`).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("api_keys_user_idx").on(table.userId),
    serviceAccountIdx: index("api_keys_service_account_idx").on(table.serviceAccountId),
    prefixIdx: index("api_keys_prefix_idx").on(table.prefix),
  })
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    appId: uuid("app_id").references(() => applications.id, { onDelete: "set null" }),
    requestId: text("request_id"),
    event: varchar("event", { length: 64 }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("audit_log_user_idx").on(table.userId),
    eventIdx: index("audit_log_event_idx").on(table.event),
    createdAtIdx: index("audit_log_created_at_idx").on(table.createdAt),
    orgIdx: index("audit_log_org_idx").on(table.orgId),
    appIdx: index("audit_log_app_idx").on(table.appId),
  })
);

export const oauth2AuthorizationCodes = pgTable(
  "oauth2_authorization_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    challenge: text("challenge"),
    challengeMethod: text("challenge_method"),
    redirectUri: text("redirect_uri"),
    scopes: text("scopes").array().default(sql`'{}'::text[]`).notNull(),
    nonce: text("nonce"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    appIdx: index("oauth2_authorization_codes_app_idx").on(table.appId),
    userIdx: index("oauth2_authorization_codes_user_idx").on(table.userId),
    hashIdx: index("oauth2_authorization_codes_hash_idx").on(table.codeHash),
  })
);

export const oauth2Consents = pgTable(
  "oauth2_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().default(sql`'{}'::text[]`).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    appIdx: index("oauth2_consents_app_idx").on(table.appId),
    userIdx: index("oauth2_consents_user_idx").on(table.userId),
    uniqueConsent: unique("oauth2_consents_unique").on(table.appId, table.userId),
  })
);

export const magicLinks = pgTable(
  "magic_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("magic_links_user_idx").on(table.userId),
    hashIdx: index("magic_links_hash_idx").on(table.tokenHash),
  })
);

export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("email_verification_user_idx").on(table.userId),
    hashIdx: index("email_verification_hash_idx").on(table.tokenHash),
  })
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("password_reset_tokens_user_idx").on(table.userId),
    hashIdx: index("password_reset_tokens_hash_idx").on(table.tokenHash),
  })
);

export const userDevices = pgTable(
  "user_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fingerprintHash: text("fingerprint_hash").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    trustScore: smallint("trust_score").default(50).notNull(),
    newDeviceAlertSent: boolean("new_device_alert_sent").default(false).notNull(),
  },
  (table) => ({
    userIdx: index("user_devices_user_idx").on(table.userId),
    uniqueDevice: unique("user_devices_unique").on(table.userId, table.fingerprintHash),
  })
);

export const totpBackupCodes = pgTable(
  "totp_backup_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("totp_backup_codes_user_idx").on(table.userId),
    hashIdx: index("totp_backup_codes_hash_idx").on(table.codeHash),
  })
);

export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").default(0).notNull(),
    transports: text("transports").array().default(sql`'{}'::text[]`).notNull(),
    aaguid: text("aaguid"),
    deviceName: text("device_name"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("webauthn_credentials_user_idx").on(table.userId),
  })
);

export const smsOtpCodes = pgTable(
  "sms_otp_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    phoneNumber: text("phone_number").notNull(),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("sms_otp_codes_user_idx").on(table.userId),
  })
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type OrgMembership = typeof orgMemberships.$inferSelect;
export type NewOrgMembership = typeof orgMemberships.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type AuditEvent = typeof auditLog.$inferSelect;
export type OAuth2AuthorizationCode = typeof oauth2AuthorizationCodes.$inferSelect;
export type OAuth2Consent = typeof oauth2Consents.$inferSelect;
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    resourceActionIdx: unique("permissions_resource_action_idx").on(table.resource, table.action),
  })
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: text("role").notNull(),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    rolePermissionIdx: unique("role_permissions_idx").on(table.role, table.permissionId),
  })
);

export type MagicLink = typeof magicLinks.$inferSelect;
export type UserDevice = typeof userDevices.$inferSelect;
export type TOTPBackupCode = typeof totpBackupCodes.$inferSelect;
export type WebAuthnCredential = typeof webauthnCredentials.$inferSelect;
export type SmsOtpCode = typeof smsOtpCodes.$inferSelect;
export const samlConnections = pgTable(
  "saml_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    idpEntityId: text("idp_entity_id"),
    idpSsoUrl: text("idp_sso_url"),
    idpCertificate: text("idp_certificate"),
    spEntityId: text("sp_entity_id").notNull(),
    spAcsUrl: text("sp_acs_url").notNull(),
    attributeMapping: jsonb("attribute_mapping").default({}).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("saml_connections_org_idx").on(table.orgId),
  })
);

export const oidcConnections = pgTable(
  "oidc_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    issuer: text("issuer").notNull(),
    authorizationEndpoint: text("authorization_endpoint").notNull(),
    tokenEndpoint: text("token_endpoint").notNull(),
    userinfoEndpoint: text("userinfo_endpoint"),
    jwksUri: text("jwks_uri"),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret").notNull(),
    scopes: text("scopes").array().default(sql`'{"openid","profile","email"}'::text[]`).notNull(),
    attributeMapping: jsonb("attribute_mapping").default({}).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("oidc_connections_org_idx").on(table.orgId),
  })
);

export const identityProviders = pgTable(
  "identity_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerType: text("provider_type").notNull(),
    name: text("name").notNull(),
    issuer: text("issuer"),
    authorizationEndpoint: text("authorization_endpoint"),
    tokenEndpoint: text("token_endpoint"),
    userinfoEndpoint: text("userinfo_endpoint"),
    jwksUri: text("jwks_uri"),
    clientId: text("client_id"),
    clientSecretEncrypted: text("client_secret_encrypted"),
    scopes: text("scopes").array().default(sql`'{"openid","profile","email"}'::text[]`).notNull(),
    attributeMapping: jsonb("attribute_mapping").default({}).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    isFederation: boolean("is_federation").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("identity_providers_org_idx").on(table.orgId),
    typeIdx: index("identity_providers_type_idx").on(table.providerType),
  })
);

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => identityProviders.id, { onDelete: "cascade" }),
    providerType: text("provider_type").notNull(),
    externalSub: text("external_sub").notNull(),
    email: text("email"),
    profile: jsonb("profile").default({}).notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("user_identities_user_idx").on(table.userId),
    providerSubIdx: index("user_identities_provider_sub_idx").on(table.providerId, table.externalSub),
  })
);

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyId: text("key_id").notNull().unique(),
    type: text("type").notNull(),
    value: text("value").notNull(),
    algorithm: text("algorithm"),
    isActive: boolean("is_active").default(true).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    typeActiveIdx: index("secrets_type_active_idx").on(table.type, table.isActive),
  })
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    enabled: boolean("enabled").default(false).notNull(),
    description: text("description"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    keyIdx: index("feature_flags_key_idx").on(table.key),
  })
);

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    definition: jsonb("definition").default({}).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    triggerIdx: index("workflows_trigger_idx").on(table.trigger),
  })
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    triggerEvent: text("trigger_event").notNull(),
    payload: jsonb("payload").default({}).notNull(),
    status: text("status").default("pending").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    log: jsonb("log").default(sql.raw("'[]'::jsonb")).notNull(),
  },
  (table) => ({
    workflowIdx: index("workflow_runs_workflow_idx").on(table.workflowId),
  })
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").references(() => applications.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description"),
    // Event types to deliver, e.g. ["user_login", "user_registered"]. Empty = all.
    events: text("events").array().default(sql`'{}'::text[]`).notNull(),
    secret: text("secret").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    appIdx: index("webhook_endpoints_app_idx").on(table.appId),
  })
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").default({}).notNull(),
    status: text("status").default("pending").notNull(), // pending | success | failed
    attempts: integer("attempts").default(0).notNull(),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    endpointIdx: index("webhook_deliveries_endpoint_idx").on(table.endpointId),
    statusIdx: index("webhook_deliveries_status_idx").on(table.status),
  })
);

export type Permission = typeof permissions.$inferSelect;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type ServiceAccount = typeof serviceAccounts.$inferSelect;
export type SamlConnection = typeof samlConnections.$inferSelect;
export type OidcConnection = typeof oidcConnections.$inferSelect;
export type IdentityProvider = typeof identityProviders.$inferSelect;
export type NewIdentityProvider = typeof identityProviders.$inferInsert;
export type UserIdentity = typeof userIdentities.$inferSelect;
export type NewUserIdentity = typeof userIdentities.$inferInsert;
export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
export type FeatureFlag = typeof featureFlags.$inferSelect;
export type NewFeatureFlag = typeof featureFlags.$inferInsert;
export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
