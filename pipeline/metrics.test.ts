// Metric SQL (pipeline/transforms.ts) on a small hand-built dataset, with answers worked out by hand.
// See docs/METRICS.md for the definitions under test.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawAdSpend, rawCustomers, rawLeads, rawSubscriptions, type RawTable } from "@/db/schema";
import { queryRows, type Db } from "@/db/types";
import { loadRaw } from "./load";
import { runTransforms } from "./transforms";
import { createTestDb } from "./test-db";

let db: Db;
let close: () => Promise<void>;
const AS_OF = new Date("2026-11-15T12:00:00Z");

const load = (table: RawTable, rows: Record<string, unknown>[]) =>
  loadRaw(db, table, "test", rows.map((p) => ({ sourceId: String(p.id), cursorAt: AS_OF, payload: p })), null);

const lead = (id: string, createdAt: string, customer: string, extra: Record<string, unknown>) => ({
  id,
  source: "web",
  branchId: 1,
  phone: null,
  email: `${id}@example.com`,
  crmCustomerId: customer,
  createdAt,
  ...extra,
});
const customer = (id: string, bookedAt: string | null) => ({ id, branchId: 1, createdAt: "2026-10-01T00:00:00Z", bookedAt, smsConsent: true });
const sub = (id: string, customerId: string, monthlyPrice: number, startedAt: string, cancelledAt: string | null = null) => ({
  id,
  customerId,
  plan: "Plan",
  monthlyPrice,
  status: cancelledAt ? "cancelled" : "active",
  startedAt,
  cancelledAt,
});
const spend = (date: string, channel: string, amount: number) => ({ id: `${date}:${channel}:1`, date, channel, branchId: 1, spend: amount, clicks: 1, impressions: 10 });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await load(rawLeads, [
    lead("L1", "2026-10-05T15:00:00Z", "C1", { phone: "(512) 555-0001", gclid: "abc" }), // google_ads (gclid)
    lead("L2", "2026-10-06T15:00:00Z", "C2", { utmSource: "Google", utmMedium: "CPC" }), // google_ads
    lead("L3", "2026-10-07T15:00:00Z", "C3", { utmSource: "facebook", utmMedium: "paid_social" }), // meta
    lead("L4", "2026-10-08T15:00:00Z", "C4", { utmSource: "google", utmMedium: "organic" }), // organic, never books
    lead("L5", "2026-10-09T15:00:00Z", "C1", { phone: "+1 512 555 0001" }), // same person as L1: not a new lead
    lead("L6", "2026-10-09T16:00:00Z", "C6", { utmSource: "google", utmMedium: "lsa" }), // local_services_ads
    lead("L7", "2026-10-09T17:00:00Z", "C7", { utmSource: "nextdoor" }), // referral
    lead("L8", "2026-10-09T18:00:00Z", "C8", {}), // direct
  ]);
  await load(rawCustomers, [
    customer("C1", "2026-10-06T12:00:00Z"),
    customer("C2", "2026-10-10T12:00:00Z"),
    customer("C3", "2026-11-02T12:00:00Z"),
    customer("C4", null),
    customer("C9", "2024-12-20T12:00:00Z"), // signed up before tracking: no lead
  ]);
  await load(rawSubscriptions, [
    sub("S1", "C1", 50, "2026-09-01T12:00:00Z"), // active throughout
    sub("S2", "C2", 100, "2026-09-15T12:00:00Z", "2026-10-20T12:00:00Z"), // cancels during October
    sub("S3", "C3", 80, "2026-10-25T12:00:00Z", "2026-11-05T12:00:00Z"), // starts late October, cancels in November
    sub("S9", "C9", 40, "2025-01-01T12:00:00Z"), // legacy, active
  ]);
  await load(rawAdSpend, [
    spend("2026-10-05", "google_ads", 300),
    spend("2026-10-20", "google_ads", 300),
    spend("2026-10-12", "meta", 200),
    spend("2026-11-03", "google_ads", 100),
  ]);
  await runTransforms(db, AS_OF);
});
afterAll(() => close());

const num = (v: unknown) => (v === null ? null : Number(v));

describe("staging", () => {
  it("maps UTM parameters and gclid to channels", async () => {
    const rows = await queryRows<{ lead_id: string; channel: string }>(db, sql`select lead_id, channel from stg_leads order by lead_id`);
    expect(Object.fromEntries(rows.map((r) => [r.lead_id, r.channel]))).toEqual({
      L1: "google_ads",
      L2: "google_ads",
      L3: "meta",
      L4: "organic",
      L6: "local_services_ads",
      L7: "referral",
      L8: "direct",
    });
  });

  it("counts a repeat contact (same phone, any format) as one lead", async () => {
    const [{ n }] = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from stg_leads where phone = '5125550001'`);
    expect(n).toBe(1);
  });
});

describe("mart_cac_by_channel_monthly", () => {
  const cac = () =>
    queryRows<{ month: string; channel: string; spend: string; new_bookings: number; cac: string | null }>(
      db,
      sql`select month::text, channel, spend, new_bookings, cac from mart_cac_by_channel_monthly order by month, channel`,
    );

  it("divides a month's spend by that month's new bookings, per channel", async () => {
    const rows = (await cac()).map((r) => ({ ...r, spend: num(r.spend), cac: num(r.cac) }));
    expect(rows).toEqual([
      // October: $600 Google spend, bookings C1 (Oct 6) + C2 (Oct 10) -> $300
      { month: "2026-10-01", channel: "google_ads", spend: 600, new_bookings: 2, cac: 300 },
      // October Meta: $200 spent, C3 booked in November -> no bookings, CAC undefined
      { month: "2026-10-01", channel: "meta", spend: 200, new_bookings: 0, cac: null },
      { month: "2026-11-01", channel: "google_ads", spend: 100, new_bookings: 0, cac: null },
      // November Meta: the C3 booking, no spend that month
      { month: "2026-11-01", channel: "meta", spend: 0, new_bookings: 1, cac: 0 },
    ]);
  });

  it("leaves unpaid channels out", async () => {
    expect((await cac()).map((r) => r.channel)).not.toContain("organic");
  });
});

describe("mart_funnel_daily", () => {
  it("attributes leads, bookings and revenue to the first lead's channel", async () => {
    const rows = await queryRows<{ channel: string; leads: number; bookings: number; revenue: string; spend: string }>(
      db,
      sql`select channel, sum(leads)::int as leads, sum(bookings)::int as bookings, sum(revenue) as revenue, sum(spend) as spend
          from mart_funnel_daily where date between '2026-10-01' and '2026-10-31' group by channel order by channel`,
    );
    const byChannel = Object.fromEntries(rows.map((r) => [r.channel, { ...r, revenue: num(r.revenue), spend: num(r.spend) }]));
    // Revenue: S1 bills Oct 1 ($50); S2 bills Oct 15 ($100), cancelled Oct 20.
    expect(byChannel.google_ads).toMatchObject({ leads: 2, bookings: 2, revenue: 150, spend: 600 });
    // S3 bills Oct 25 ($80)
    expect(byChannel.meta).toMatchObject({ leads: 1, bookings: 0, revenue: 80, spend: 200 });
    expect(byChannel.organic).toMatchObject({ leads: 1, bookings: 0, revenue: 0, spend: 0 });
    // S9 has no lead: billed Oct 1 ($40) as unattributed
    expect(byChannel.unattributed).toMatchObject({ leads: 0, revenue: 40 });
  });

  it("stops billing once a subscription is cancelled", async () => {
    const [{ revenue }] = await queryRows<{ revenue: string }>(
      db,
      sql`select coalesce(sum(revenue), 0) as revenue from mart_funnel_daily where date >= '2026-11-01' and channel = 'meta'`,
    );
    expect(num(revenue)).toBe(0); // S3 cancelled Nov 5, before its Nov 25 charge
  });
});

describe("mart_retention_monthly", () => {
  const retention = async (month: string) =>
    Object.fromEntries(
      (
        await queryRows<{ channel: string; active_at_start: number; retained_at_end: number; retention_rate: string; is_complete: boolean }>(
          db,
          sql`select channel, active_at_start, retained_at_end, retention_rate, is_complete from mart_retention_monthly
              where month = ${month}::date order by channel`,
        )
      ).map((r) => [r.channel, { start: r.active_at_start, end: r.retained_at_end, rate: num(r.retention_rate), complete: r.is_complete }]),
    );

  it("October: of subscriptions active on Oct 1, the share still active on Nov 1", async () => {
    // Active Oct 1: S1, S2 (google), S9 (unattributed). S2 cancelled Oct 20. S3 started mid-month: excluded.
    expect(await retention("2026-10-01")).toEqual({
      google_ads: { start: 2, end: 1, rate: 0.5, complete: true },
      unattributed: { start: 1, end: 1, rate: 1, complete: true },
    });
  });

  it("the current month is retention so far, flagged incomplete", async () => {
    // Active Nov 1: S1, S3 (meta), S9. S3 cancelled Nov 5.
    expect(await retention("2026-11-01")).toEqual({
      google_ads: { start: 1, end: 1, rate: 1, complete: false },
      meta: { start: 1, end: 0, rate: 0, complete: false },
      unattributed: { start: 1, end: 1, rate: 1, complete: false },
    });
  });

  it("starts at the first month with lead data", async () => {
    const [{ first }] = await queryRows<{ first: string }>(db, sql`select min(month)::text as first from mart_retention_monthly`);
    expect(first).toBe("2026-10-01");
  });
});

describe("runTransforms", () => {
  it("is idempotent: rebuilding gives identical tables", async () => {
    const snapshot = () =>
      queryRows(
        db,
        sql`select (select json_agg(f order by date, channel, branch_id) from mart_funnel_daily f) as f,
                   (select json_agg(r order by month, branch_id, channel) from mart_retention_monthly r) as r,
                   (select json_agg(s order by lead_id) from stg_leads s) as s`,
      );
    const before = await snapshot();
    await runTransforms(db, AS_OF);
    expect(await snapshot()).toEqual(before);
  });
});
