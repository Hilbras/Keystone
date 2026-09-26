DROP INDEX "scim_connections_token_hash_idx";--> statement-breakpoint
DROP INDEX "scim_connections_previous_token_hash_idx";--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "cert_fingerprint" text;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "scim_connections_token_hash_unique" ON "scim_connections" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_connections_previous_token_hash_unique" ON "scim_connections" USING btree ("previous_token_hash") WHERE previous_token_hash is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "service_accounts_cert_fingerprint_unique" ON "service_accounts" USING btree ("cert_fingerprint") WHERE cert_fingerprint is not null;