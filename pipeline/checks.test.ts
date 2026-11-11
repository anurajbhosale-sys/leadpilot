// Each quality check, passing and failing, against real Postgres (PGlite).
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rawCalls, stgAdSpend, stgCalls, stgCustomers, stgLeads, stgSubscriptions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { CrmExportProvider } from "@/lib/providers/crm-export";
import { ProviderError } from "@/lib/providers/faults";
import {
  acceptedValues,
  CHECKS,
  freshness,
  notNull,
  reconcileActiveSubscriptions,
  runChecks,
  uniqueness,
  volume,
  type Check,
} from "./checks";
import { createTestDb } from "./test-db";

let db: Db;
let close: () => Promise<void>;
const AS_OF = new Date("2026-11-11T09:00:00Z");
const HOUR = 3_600_000;

const crmWith = (active: number): CrmExportProvider => ({
  listCustomers: async () => ({ items: [] }),
  listSubscriptions: async () => ({ items: [] }),
  countActiveSubscriptions: async () => active,
});
const run = (check: Check, crm = crmWith(0)) => check.run({ db, asOf: AS_OF, crm });
const named = (name: string) => CHECKS.find((c) => c.name === name)!;

const leadRow = (id: string, overrides: Partial<typeof stgLeads.$inferInsert> = {}): typeof stgLeads.$inferInsert => ({
  leadId: id,
  source: "web",
  createdAt: new Date("2026-11-10T12:00:00Z"),
  leadDate: "2026-11-10",
  branchId: 1,
  phone: "5125550100",
  channel: "google_ads",
  ...overrides,
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());
beforeEach(async () => {
  for (const t of ["raw_calls", "stg_leads", "stg_customers", "stg_subscriptions", "stg_calls", "stg_ad_spend"]) {
    await db.execute(sql.raw(`delete from ${t}`));
  }
});

describe("freshness", () => {
  const loadCall = (ingestedAt: Date) =>
    db.insert(rawCalls).values({ sourceId: "call_1", source: "test", payload: {}, sourceUpdatedAt: ingestedAt, ingestedAt });

  it("passes when the table was loaded within 26 hours", async () => {
    await loadCall(new Date(AS_OF.getTime() - 25 * HOUR));
    expect(await run(freshness("raw_calls"))).toMatchObject({ passed: true });
  });

  it("fails when the newest load is older than 26 hours", async () => {
    await loadCall(new Date(AS_OF.getTime() - 27 * HOUR));
    expect(await run(freshness("raw_calls"))).toMatchObject({ passed: false, detail: expect.stringContaining("27.0h ago") });
  });

  it("fails when nothing was ever loaded", async () => {
    expect(await run(freshness("raw_calls"))).toEqual({ passed: false, detail: "no rows loaded yet" });
  });
});

describe("uniqueness", () => {
  const customer = (id: string) => ({ customerId: id, branchId: 1, createdAt: AS_OF, smsConsent: false });
  const check = named("unique:stg_customers(customer_id)");

  it("passes when every customer ID is unique", async () => {
    await db.insert(stgCustomers).values([customer("c1"), customer("c2")]);
    expect(await run(check)).toEqual({ passed: true });
  });

  it("fails and names the duplicated IDs", async () => {
    await db.insert(stgCustomers).values([customer("c1"), customer("c2"), customer("c2")]);
    expect(await run(check)).toEqual({ passed: false, detail: "duplicate keys: c2" });
  });

  it("checks composite keys", async () => {
    const row = { spendDate: "2026-11-10", channel: "meta", branchId: 1, spend: "10", clicks: 1, impressions: 1 };
    await db.insert(stgAdSpend).values([row, row]);
    expect(await run(uniqueness("stg_ad_spend", ["spend_date", "channel", "branch_id"]))).toMatchObject({ passed: false });
  });
});

describe("not null", () => {
  const check = named("not_null:stg_leads");

  it("passes when every lead has a contact and a branch", async () => {
    await db.insert(stgLeads).values([leadRow("l1"), leadRow("l2", { phone: null, email: "a@example.com" })]);
    expect(await run(check)).toEqual({ passed: true });
  });

  it("fails for a lead without a branch", async () => {
    await db.insert(stgLeads).values([leadRow("l1"), leadRow("l2", { branchId: null })]);
    expect(await run(check)).toMatchObject({ passed: false, detail: expect.stringContaining("failing: l2") });
  });

  it("fails for a lead with neither phone nor email", async () => {
    await db.insert(stgLeads).values(leadRow("l3", { phone: null, email: null }));
    expect(await run(check)).toMatchObject({ passed: false, detail: expect.stringContaining("failing: l3") });
  });

  it("works for any rule expressed as a query", async () => {
    await db.insert(stgSubscriptions).values({
      subscriptionId: "s1",
      customerId: null,
      branchId: 1,
      plan: "Plan",
      monthlyPrice: "10",
      status: "active",
      startedAt: AS_OF,
    });
    const subs = notNull("subs", sql`select subscription_id as id from stg_subscriptions where customer_id is null`, "needs a customer");
    expect(await run(subs)).toEqual({ passed: false, detail: "needs a customer; failing: s1" });
  });
});

describe("accepted values", () => {
  const call = (id: string, intent: string) => ({
    callId: id,
    branchId: 1,
    callDate: "2026-11-10",
    endedAt: AS_OF,
    intent,
    cancellationRisk: "low",
    matchedExistingCustomer: true,
  });
  const check = named("accepted_values:stg_calls.intent");

  it("passes when every intent is an allowed value", async () => {
    await db.insert(stgCalls).values([call("1", "new_quote"), call("2", "cancellation")]);
    expect(await run(check)).toEqual({ passed: true });
  });

  it("fails and lists the unexpected values with counts", async () => {
    await db.insert(stgCalls).values([call("1", "new_quote"), call("2", "refund"), call("3", "refund")]);
    expect(await run(check)).toEqual({ passed: false, detail: "unexpected values: refund (2)" });
  });

  it("works on any table and column", async () => {
    await db.insert(stgLeads).values(leadRow("l1"));
    await db.execute(sql`update stg_leads set channel = 'tv'`);
    expect(await run(acceptedValues("stg_leads", "channel", ["google_ads"]))).toMatchObject({ passed: false, detail: "unexpected values: tv (1)" });
  });
});

describe("volume", () => {
  // Yesterday (relative to AS_OF) is 2026-11-10; the 7 days before it are Nov 3-9.
  async function leadsPerDay(yesterday: number, perPriorDay: number) {
    const rows: (typeof stgLeads.$inferInsert)[] = [];
    for (let d = 3; d <= 10; d++) {
      const date = `2026-11-${String(d).padStart(2, "0")}`;
      for (let i = 0; i < (d === 10 ? yesterday : perPriorDay); i++) rows.push(leadRow(`${date}-${i}`, { leadDate: date }));
    }
    if (rows.length) await db.insert(stgLeads).values(rows);
  }
  const check = volume("stg_leads", "lead_date");

  it("passes within ±50% of the 7-day average", async () => {
    await leadsPerDay(14, 10);
    expect(await run(check)).toEqual({ passed: true, detail: "yesterday 14 rows vs 7-day average 10.0 (+40%, limit ±50%)" });
  });

  it("fails on a drop of more than 50%", async () => {
    await leadsPerDay(4, 10);
    expect(await run(check)).toMatchObject({ passed: false, detail: expect.stringContaining("-60%") });
  });

  it("fails on a spike of more than 50%", async () => {
    await leadsPerDay(16, 10);
    expect(await run(check)).toMatchObject({ passed: false, detail: expect.stringContaining("+60%") });
  });

  it("fails when yesterday has no rows at all", async () => {
    await leadsPerDay(0, 10);
    expect(await run(check)).toMatchObject({ passed: false });
  });

  it("is skipped while there is too little history to compare", async () => {
    await leadsPerDay(0, 2);
    expect(await run(check)).toMatchObject({ passed: true, detail: expect.stringMatching(/^skipped/) });
  });
});

describe("reconciliation", () => {
  beforeEach(async () => {
    const sub = (id: string, status: string) => ({
      subscriptionId: id,
      customerId: "c",
      branchId: 1,
      plan: "Plan",
      monthlyPrice: "10",
      status,
      startedAt: AS_OF,
    });
    await db.insert(stgSubscriptions).values([sub("s1", "active"), sub("s2", "active"), sub("s3", "cancelled")]);
  });

  it("passes when active subscriptions match the CRM's count", async () => {
    expect(await run(reconcileActiveSubscriptions, crmWith(2))).toEqual({ passed: true, detail: "pipeline 2 vs CRM 2" });
  });

  it("retries the CRM when it is briefly unavailable", async () => {
    let calls = 0;
    const flaky = { ...crmWith(2), countActiveSubscriptions: async () => (calls++ === 0 ? Promise.reject(new ProviderError("429", 429)) : 2) };
    const result = await reconcileActiveSubscriptions.run({ db, asOf: AS_OF, crm: flaky, retry: { attempts: 3, baseDelayMs: 1, sleep: async () => {} } });
    expect(result).toEqual({ passed: true, detail: "pipeline 2 vs CRM 2" });
    expect(calls).toBe(2);
  });

  it("fails when they don't", async () => {
    expect(await run(reconcileActiveSubscriptions, crmWith(3))).toEqual({ passed: false, detail: "pipeline 2 vs CRM 3" });
  });
});

describe("runChecks", () => {
  it("records a check that errors as failed and keeps running the rest", async () => {
    const broken: Check = { name: "broken", run: async () => Promise.reject(new Error("boom")) };
    const fine: Check = { name: "fine", run: async () => ({ passed: true }) };
    expect(await runChecks({ db, asOf: AS_OF, crm: crmWith(0) }, [broken, fine])).toEqual([
      { name: "broken", passed: false, detail: "check errored: boom" },
      { name: "fine", passed: true },
    ]);
  });
});
