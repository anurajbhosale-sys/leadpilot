// Tables for the nightly pipeline (SPEC section 8): raw_* -> stg_* -> mart_*, plus the mock CRM's
// own storage. Analytics tables have no foreign keys on purpose: like a warehouse, they must accept
// whatever the sources send, and quality checks (pipeline/checks.ts) report problems instead.
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------------------------
// Raw layer: records land unchanged (as JSON), keyed by the source's own ID, so a rerun upserts
// the same rows instead of duplicating them.
// ---------------------------------------------------------------------------------------------
const rawTable = (name: string) =>
  pgTable(name, {
    sourceId: text("source_id").primaryKey(), // the record's ID in the source system
    source: text("source").notNull(), // which system it came from, e.g. "app_db", "mock_crm"
    payload: jsonb("payload").notNull(),
    sourceUpdatedAt: ts("source_updated_at").notNull(), // the field the watermark tracks
    ingestedAt: ts("ingested_at").notNull().defaultNow(),
    runId: integer("run_id"), // pipeline_runs.id that last wrote the row
  });

export const rawLeads = rawTable("raw_leads");
export const rawCustomers = rawTable("raw_customers");
export const rawSubscriptions = rawTable("raw_subscriptions");
export const rawCalls = rawTable("raw_calls");
export const rawAdSpend = rawTable("raw_ad_spend");

export type RawTable = typeof rawLeads;

// ---------------------------------------------------------------------------------------------
// Staging layer: typed, cleaned, normalized, deduplicated. Rebuilt from raw on every run.
// All dates are UTC calendar dates. No primary keys: a duplicate must reach the uniqueness check
// (and fail the run loudly) rather than crash the transform.
// ---------------------------------------------------------------------------------------------
export const stgLeads = pgTable(
  "stg_leads",
  {
    leadId: text("lead_id").notNull(),
    source: text("source").notNull(), // "web" | "phone"
    createdAt: ts("created_at").notNull(),
    leadDate: date("lead_date", { mode: "string" }).notNull(),
    branchId: integer("branch_id"),
    phone: text("phone"), // digits only
    email: text("email"), // lower-cased
    contactKey: text("contact_key"), // phone, else email: what "unique contact" means
    channel: text("channel").notNull(),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    crmCustomerId: text("crm_customer_id"),
    serviceCategory: text("service_category"),
  },
  (t) => [index("stg_leads_lead_id_idx").on(t.leadId), index("stg_leads_crm_customer_idx").on(t.crmCustomerId)],
);

export const stgCustomers = pgTable(
  "stg_customers",
  {
    customerId: text("customer_id").notNull(),
    branchId: integer("branch_id"),
    createdAt: ts("created_at").notNull(),
    bookedAt: ts("booked_at"), // when the first service was scheduled; null = never booked
    firstServiceDate: date("first_service_date", { mode: "string" }),
    smsConsent: boolean("sms_consent").notNull(),
  },
  (t) => [index("stg_customers_customer_id_idx").on(t.customerId)],
);

export const stgSubscriptions = pgTable("stg_subscriptions", {
  subscriptionId: text("subscription_id").notNull(),
  customerId: text("customer_id"),
  branchId: integer("branch_id"),
  plan: text("plan").notNull(),
  monthlyPrice: numeric("monthly_price", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull(), // "active" | "cancelled"
  startedAt: ts("started_at").notNull(),
  cancelledAt: ts("cancelled_at"),
  cancelReason: text("cancel_reason"),
});

export const stgCalls = pgTable("stg_calls", {
  callId: text("call_id").notNull(),
  branchId: integer("branch_id"),
  callDate: date("call_date", { mode: "string" }).notNull(),
  endedAt: ts("ended_at").notNull(),
  intent: text("intent").notNull(),
  cancellationRisk: text("cancellation_risk").notNull(),
  matchedExistingCustomer: boolean("matched_existing_customer").notNull(),
});

export const stgAdSpend = pgTable(
  "stg_ad_spend",
  {
    spendDate: date("spend_date", { mode: "string" }).notNull(),
    channel: text("channel").notNull(),
    branchId: integer("branch_id"),
    spend: numeric("spend", { precision: 12, scale: 2 }).notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
  },
  (t) => [index("stg_ad_spend_grain_idx").on(t.spendDate, t.channel, t.branchId)],
);

// ---------------------------------------------------------------------------------------------
// Marts: business-ready tables the dashboard reads. Definitions live in docs/METRICS.md.
// ---------------------------------------------------------------------------------------------
export const martFunnelDaily = pgTable(
  "mart_funnel_daily",
  {
    date: date("date", { mode: "string" }).notNull(),
    channel: text("channel").notNull(),
    branchId: integer("branch_id").notNull(),
    spend: numeric("spend", { precision: 12, scale: 2 }).notNull(),
    leads: integer("leads").notNull(),
    bookings: integer("bookings").notNull(),
    revenue: numeric("revenue", { precision: 12, scale: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.channel, t.branchId] })],
);

export const martCacByChannelMonthly = pgTable(
  "mart_cac_by_channel_monthly",
  {
    month: date("month", { mode: "string" }).notNull(), // first day of the month
    channel: text("channel").notNull(),
    branchId: integer("branch_id").notNull(),
    spend: numeric("spend", { precision: 12, scale: 2 }).notNull(),
    newBookings: integer("new_bookings").notNull(),
    cac: numeric("cac", { precision: 12, scale: 2 }), // null when there were no bookings
  },
  (t) => [primaryKey({ columns: [t.month, t.channel, t.branchId] })],
);

export const martRetentionMonthly = pgTable(
  "mart_retention_monthly",
  {
    month: date("month", { mode: "string" }).notNull(),
    branchId: integer("branch_id").notNull(),
    channel: text("channel").notNull(), // the channel that acquired the customer
    activeAtStart: integer("active_at_start").notNull(),
    retainedAtEnd: integer("retained_at_end").notNull(),
    retentionRate: numeric("retention_rate", { precision: 6, scale: 4 }), // null when active_at_start = 0
    isComplete: boolean("is_complete").notNull(), // false for the current month (retained so far)
  },
  (t) => [primaryKey({ columns: [t.month, t.branchId, t.channel] })],
);

export const martCallIntentsDaily = pgTable(
  "mart_call_intents_daily",
  {
    date: date("date", { mode: "string" }).notNull(),
    branchId: integer("branch_id").notNull(),
    intent: text("intent").notNull(),
    calls: integer("calls").notNull(),
    highRiskCalls: integer("high_risk_calls").notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.branchId, t.intent] })],
);

// ---------------------------------------------------------------------------------------------
// Mock CRM storage. Stands in for the CRM vendor's database so the pipeline can export a durable
// history (filled by `npm run db:seed:history`). Not app data: a real CRM replaces these tables.
// ---------------------------------------------------------------------------------------------
export const mockCrmCustomers = pgTable("mock_crm_customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  zip: text("zip"),
  branchId: integer("branch_id"),
  smsConsent: boolean("sms_consent").notNull().default(false),
  bookedAt: ts("booked_at"),
  firstServiceDate: date("first_service_date", { mode: "string" }),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const mockCrmSubscriptions = pgTable("mock_crm_subscriptions", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull(),
  plan: text("plan").notNull(),
  monthlyPrice: numeric("monthly_price", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull(),
  startedAt: ts("started_at").notNull(),
  cancelledAt: ts("cancelled_at"),
  cancelReason: text("cancel_reason"),
  updatedAt: ts("updated_at").notNull(),
});
