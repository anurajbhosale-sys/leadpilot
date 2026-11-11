CREATE TYPE "public"."sms_status" AS ENUM('scheduled', 'sent');--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"kind" text NOT NULL,
	"to_phone" text NOT NULL,
	"body" text NOT NULL,
	"branch_id" integer,
	"lead_id" uuid,
	"approval_id" integer,
	"status" "sms_status" DEFAULT 'scheduled' NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_messages_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "to_phone" text;--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "guardrail_errors" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_queue" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_approval_id_approval_queue_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_queue" ADD CONSTRAINT "approval_queue_source_key_unique" UNIQUE("source_key");