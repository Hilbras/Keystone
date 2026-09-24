ALTER TABLE "users" ADD COLUMN "account_review_required" boolean DEFAULT false NOT NULL;

UPDATE "users" SET "is_active" = true WHERE "is_active" IS NULL;
ALTER TABLE "users" ALTER COLUMN "is_active" SET DEFAULT true;
ALTER TABLE "users" ALTER COLUMN "is_active" SET NOT NULL;

-- Legacy deactivation only cleared email_verified. Preserve known deactivations,
-- and quarantine ambiguous unverified accounts instead of silently reactivating them.
UPDATE "users" AS u
SET "is_active" = false
WHERE EXISTS (
  SELECT 1
  FROM "audit_log" AS a
  WHERE a."event" LIKE 'platform_user_deactivated%'
    AND (
      a."metadata"->>'targetUserId' = u."id"::text
      OR a."user_id" = u."id"
    )
);

UPDATE "users" AS u
SET "is_active" = false,
    "account_review_required" = true
WHERE u."email_verified" = false
  AND u."is_active" = true
  AND NOT EXISTS (
    SELECT 1
    FROM "audit_log" AS a
    WHERE a."event" LIKE 'platform_user_deactivated%'
      AND (
        a."metadata"->>'targetUserId' = u."id"::text
        OR a."user_id" = u."id"
      )
  );
