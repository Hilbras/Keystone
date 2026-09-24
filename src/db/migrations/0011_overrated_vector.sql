CREATE TABLE "sso_identity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_type" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"external_sub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_identity_links_connection_sub_unique" UNIQUE("connection_type","connection_id","external_sub"),
	CONSTRAINT "sso_identity_links_user_connection_unique" UNIQUE("org_id","user_id","connection_type","connection_id")
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_app_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "sso_identity_links" ADD CONSTRAINT "sso_identity_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identity_links" ADD CONSTRAINT "sso_identity_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sso_identity_links_user_idx" ON "sso_identity_links" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_app_id_applications_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;