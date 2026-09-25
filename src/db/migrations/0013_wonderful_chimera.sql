ALTER TABLE "oauth2_authorization_codes" ADD COLUMN "mfa_factor" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "mfa_factor" text;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth2_authorization_codes" ADD CONSTRAINT "oauth2_authorization_codes_mfa_factor_check" CHECK (mfa_factor is null or mfa_factor in ('totp', 'backup_code', 'webauthn', 'session'));--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_mfa_factor_check" CHECK (mfa_factor is null or mfa_factor in ('totp', 'backup_code', 'webauthn', 'session'));