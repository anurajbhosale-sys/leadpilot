ALTER TABLE "ai_logs" ADD COLUMN "context" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
-- Existing rows (if any) predate suites and batches: label them, then require the columns from now on.
ALTER TABLE "eval_runs" ADD COLUMN "batch_id" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ALTER COLUMN "batch_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "suite" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ALTER COLUMN "suite" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "mocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "threshold" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "meets_threshold" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "avg_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "p95_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "failures" jsonb;--> statement-breakpoint
CREATE INDEX "eval_runs_suite_created_idx" ON "eval_runs" USING btree ("suite","created_at");