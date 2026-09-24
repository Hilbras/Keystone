-- Normalize legacy values before enforcing the two role namespaces.
UPDATE "org_memberships" SET "role" = 'member' WHERE "role" NOT IN ('owner', 'admin', 'member');--> statement-breakpoint
UPDATE "users" SET "role" = 'user' WHERE "role" NOT IN ('owner', 'user');--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_role_check" CHECK (role in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_platform_role_check" CHECK (role in ('owner', 'user'));