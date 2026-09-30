ALTER TABLE "webhook_deliveries" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "locked_by" text;