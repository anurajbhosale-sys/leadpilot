CREATE TABLE "mart_cac_by_channel_monthly" (
	"month" date NOT NULL,
	"channel" text NOT NULL,
	"branch_id" integer NOT NULL,
	"spend" numeric(12, 2) NOT NULL,
	"new_bookings" integer NOT NULL,
	"cac" numeric(12, 2),
	CONSTRAINT "mart_cac_by_channel_monthly_month_channel_branch_id_pk" PRIMARY KEY("month","channel","branch_id")
);
--> statement-breakpoint
CREATE TABLE "mart_call_intents_daily" (
	"date" date NOT NULL,
	"branch_id" integer NOT NULL,
	"intent" text NOT NULL,
	"calls" integer NOT NULL,
	"high_risk_calls" integer NOT NULL,
	CONSTRAINT "mart_call_intents_daily_date_branch_id_intent_pk" PRIMARY KEY("date","branch_id","intent")
);
--> statement-breakpoint
CREATE TABLE "mart_funnel_daily" (
	"date" date NOT NULL,
	"channel" text NOT NULL,
	"branch_id" integer NOT NULL,
	"spend" numeric(12, 2) NOT NULL,
	"leads" integer NOT NULL,
	"bookings" integer NOT NULL,
	"revenue" numeric(12, 2) NOT NULL,
	CONSTRAINT "mart_funnel_daily_date_channel_branch_id_pk" PRIMARY KEY("date","channel","branch_id")
);
--> statement-breakpoint
CREATE TABLE "mart_retention_monthly" (
	"month" date NOT NULL,
	"branch_id" integer NOT NULL,
	"channel" text NOT NULL,
	"active_at_start" integer NOT NULL,
	"retained_at_end" integer NOT NULL,
	"retention_rate" numeric(6, 4),
	"is_complete" boolean NOT NULL,
	CONSTRAINT "mart_retention_monthly_month_branch_id_channel_pk" PRIMARY KEY("month","branch_id","channel")
);
--> statement-breakpoint
CREATE TABLE "mock_crm_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"zip" text,
	"branch_id" integer,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"booked_at" timestamp with time zone,
	"first_service_date" date,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_crm_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"plan" text NOT NULL,
	"monthly_price" numeric(10, 2) NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_ad_spend" (
	"source_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" integer
);
--> statement-breakpoint
CREATE TABLE "raw_calls" (
	"source_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" integer
);
--> statement-breakpoint
CREATE TABLE "raw_customers" (
	"source_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" integer
);
--> statement-breakpoint
CREATE TABLE "raw_leads" (
	"source_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" integer
);
--> statement-breakpoint
CREATE TABLE "raw_subscriptions" (
	"source_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" integer
);
--> statement-breakpoint
CREATE TABLE "stg_ad_spend" (
	"spend_date" date NOT NULL,
	"channel" text NOT NULL,
	"branch_id" integer,
	"spend" numeric(12, 2) NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stg_calls" (
	"call_id" text NOT NULL,
	"branch_id" integer,
	"call_date" date NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"intent" text NOT NULL,
	"cancellation_risk" text NOT NULL,
	"matched_existing_customer" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stg_customers" (
	"customer_id" text NOT NULL,
	"branch_id" integer,
	"created_at" timestamp with time zone NOT NULL,
	"booked_at" timestamp with time zone,
	"first_service_date" date,
	"sms_consent" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stg_leads" (
	"lead_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"lead_date" date NOT NULL,
	"branch_id" integer,
	"phone" text,
	"email" text,
	"contact_key" text,
	"channel" text NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"crm_customer_id" text,
	"service_category" text
);
--> statement-breakpoint
CREATE TABLE "stg_subscriptions" (
	"subscription_id" text NOT NULL,
	"customer_id" text,
	"branch_id" integer,
	"plan" text NOT NULL,
	"monthly_price" numeric(10, 2) NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
CREATE INDEX "stg_ad_spend_grain_idx" ON "stg_ad_spend" USING btree ("spend_date","channel","branch_id");--> statement-breakpoint
CREATE INDEX "stg_customers_customer_id_idx" ON "stg_customers" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "stg_leads_lead_id_idx" ON "stg_leads" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "stg_leads_crm_customer_idx" ON "stg_leads" USING btree ("crm_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_one_running_idx" ON "pipeline_runs" USING btree ("status") WHERE "pipeline_runs"."status" = 'running';