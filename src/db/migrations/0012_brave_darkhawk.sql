CREATE TABLE "mfa_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"flow" text NOT NULL,
	"client_id" text,
	"status" text DEFAULT 'requires_mfa' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_challenges_challenge_hash_unique" UNIQUE("challenge_hash"),
	CONSTRAINT "mfa_challenges_flow_check" CHECK (flow in ('login', 'token_login')),
	CONSTRAINT "mfa_challenges_status_check" CHECK (status in ('requires_mfa', 'consumed', 'failed', 'expired'))
);
--> statement-breakpoint
DROP INDEX "totp_backup_codes_hash_idx";--> statement-breakpoint
ALTER TABLE "totp_backup_codes" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "totp_backup_codes" SET "expires_at" = "created_at" + INTERVAL '90 days' WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "totp_backup_codes" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mfa_challenges_user_idx" ON "mfa_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mfa_challenges_status_idx" ON "mfa_challenges" USING btree ("status");--> statement-breakpoint
ALTER TABLE "totp_backup_codes" ADD CONSTRAINT "totp_backup_codes_user_code_unique" UNIQUE("user_id","code_hash");