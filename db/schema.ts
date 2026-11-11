import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Business hours per weekday (0 = Sunday). Days missing from the map are closed.
export type BusinessHours = Record<string, { open: string; close: string }>;

// A physical location. Every lead, customer, call and spend row points at one.
export const branches = pgTable("branches", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  region: text("region").notNull(),
  timeZone: text("time_zone").notNull(), // IANA zone, e.g. "America/Chicago"
  zipCodes: text("zip_codes").array().notNull(),
  businessHours: jsonb("business_hours").$type<BusinessHours>().notNull(),
  // Exact offer wording an SMS may quote. Anything else price-like is blocked by guardrails.
  approvedOffers: text("approved_offers").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull().default("web"), // "web" (lead form) or "phone" (unknown caller)
  branchId: integer("branch_id").references(() => branches.id),
  name: text("name"),
  phone: text("phone"),
  email: text("email"),
  zipCode: text("zip_code"),
  message: text("message").notNull(), // the customer's free-text request
  // Fields extracted by the LLM
  serviceCategory: text("service_category"),
  urgency: text("urgency"),
  preferredContact: text("preferred_contact"),
  summary: text("summary"),
  // Attribution captured from the landing URL
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),
  gclid: text("gclid"),
  crmCustomerId: text("crm_customer_id"),
  // Follow-up SMS draft: "ready" passed guardrails; "needs_review" went to the approval queue
  followupSms: text("followup_sms"),
  followupStatus: text("followup_status"),
  // Same key on a retry means "same lead", so the CRM never gets duplicates
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per analyzed call from the contact center.
export const calls = pgTable("calls", {
  id: serial("id").primaryKey(),
  callId: text("call_id").notNull().unique(), // the contact center's ID
  phone: text("phone").notNull(), // normalized, 10 digits
  branchId: integer("branch_id").references(() => branches.id),
  transcript: text("transcript").notNull(),
  summary: text("summary").notNull(),
  intent: text("intent").notNull(),
  cancellationRisk: text("cancellation_risk").notNull(),
  crmCustomerId: text("crm_customer_id").notNull(),
  matchedExistingCustomer: boolean("matched_existing_customer").notNull(),
  leadId: uuid("lead_id").references(() => leads.id), // set when an unknown caller became a lead
  // High cancellation risk: the retention team should call this customer back
  retentionFlag: boolean("retention_flag").notNull().default(false),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Idempotency ledger: one row per external event we have already handled.
export const processedEvents = pgTable(
  "processed_events",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(), // e.g. "calls"
    eventId: text("event_id").notNull(), // e.g. the callId
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("processed_events_source_event_idx").on(t.source, t.eventId)],
);

export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected", "sent"]);

// Customer-facing drafts wait here until a person approves, edits, or rejects them.
export const approvalQueue = pgTable("approval_queue", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // e.g. "winback_sms"
  branchId: integer("branch_id").references(() => branches.id),
  customerId: text("customer_id").notNull(),
  draft: text("draft").notNull(),
  finalText: text("final_text"), // set when a reviewer edits the draft
  status: approvalStatus("status").notNull().default("pending"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per LLM call: what it cost, how long it took, and whether it passed checks.
export const aiLogs = pgTable("ai_logs", {
  id: serial("id").primaryKey(),
  task: text("task").notNull(), // e.g. "extract_lead"
  model: text("model").notNull(),
  mocked: boolean("mocked").notNull(),
  promptVersion: text("prompt_version"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  latencyMs: integer("latency_ms").notNull(),
  passed: boolean("passed").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// High-water mark per source, so incremental jobs only fetch what's new.
export const watermarks = pgTable("watermarks", {
  source: text("source").primaryKey(), // e.g. "crm_cancellations"
  value: timestamp("value", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runStatus = pgEnum("run_status", ["running", "succeeded", "failed"]);

export const pipelineRuns = pgTable("pipeline_runs", {
  id: serial("id").primaryKey(),
  status: runStatus("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  rowCounts: jsonb("row_counts").$type<Record<string, number>>(),
  checkResults: jsonb("check_results").$type<{ name: string; passed: boolean; detail?: string }[]>(),
  error: text("error"),
});

export const evalRuns = pgTable("eval_runs", {
  id: serial("id").primaryKey(),
  promptVersion: text("prompt_version").notNull(),
  model: text("model").notNull(),
  total: integer("total").notNull(),
  passed: integer("passed").notNull(),
  passRate: numeric("pass_rate", { precision: 5, scale: 4 }).notNull(),
  perField: jsonb("per_field").$type<Record<string, number>>(), // accuracy per extracted field
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
