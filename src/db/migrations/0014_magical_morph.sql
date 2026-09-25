CREATE TABLE "scim_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"previous_token_hash" text,
	"previous_token_valid_until" timestamp with time zone,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_rotated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_group_members_group_user_unique" UNIQUE("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_groups_org_name_unique" UNIQUE("org_id","display_name")
);
--> statement-breakpoint
ALTER TABLE "scim_connections" ADD CONSTRAINT "scim_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_connections" ADD CONSTRAINT "scim_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scim_connections_org_idx" ON "scim_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "scim_connections_token_hash_idx" ON "scim_connections" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "scim_connections_previous_token_hash_idx" ON "scim_connections" USING btree ("previous_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_connections_active_org_unique" ON "scim_connections" USING btree ("org_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "scim_group_members_group_idx" ON "scim_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "scim_group_members_user_idx" ON "scim_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_groups_org_idx" ON "scim_groups" USING btree ("org_id");