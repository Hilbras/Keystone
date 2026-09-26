ALTER TABLE "applications" ALTER COLUMN "client_secret_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "client_type" text DEFAULT 'confidential' NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "allowed_scopes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_client_type_check" CHECK ("applications"."client_type" in ('confidential', 'public'));--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_public_client_no_secret_check" CHECK (("applications"."client_type" = 'public' and "applications"."client_secret_hash" is null) or "applications"."client_type" <> 'public');