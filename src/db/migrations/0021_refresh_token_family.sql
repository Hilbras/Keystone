-- §8.3 / SEC-104. The credential family a refresh token belongs to.
--
-- Drizzle would generate this as a single `ADD COLUMN ... NOT NULL`, which fails
-- on any populated table: Postgres refuses to add a not-null column without a
-- default to rows that already exist. So this is written as expand, backfill,
-- contract — the same shape §6.5 prescribes for a dangerous migration.
--
-- The backfill gives every existing token a family of its own. A pre-existing
-- token has no rotation history to inherit a family from, so its own id is the
-- only id that is guaranteed unique to it. The alternative — one family per
-- user — would mean that revoking one leaked family revoked every session the
-- user has, which is exactly the over-revocation the family exists to prevent.
ALTER TABLE "refresh_tokens" ADD COLUMN "family_id" uuid;--> statement-breakpoint
UPDATE "refresh_tokens" SET "family_id" = "id" WHERE "family_id" IS NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "family_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");
