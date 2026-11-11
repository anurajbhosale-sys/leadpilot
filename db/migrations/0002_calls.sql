CREATE TABLE "calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"phone" text NOT NULL,
	"branch_id" integer,
	"transcript" text NOT NULL,
	"summary" text NOT NULL,
	"intent" text NOT NULL,
	"cancellation_risk" text NOT NULL,
	"crm_customer_id" text NOT NULL,
	"matched_existing_customer" boolean NOT NULL,
	"lead_id" uuid,
	"retention_flag" boolean DEFAULT false NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_call_id_unique" UNIQUE("call_id")
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "source" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;