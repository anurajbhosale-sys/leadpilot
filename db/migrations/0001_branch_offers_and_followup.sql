ALTER TABLE "branches" ADD COLUMN "approved_offers" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "followup_sms" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "followup_status" text;