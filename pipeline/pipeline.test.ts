// End-to-end pipeline runs against real Postgres (PGlite) with seeded history and the mock providers.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedHistory } from "@/db/history-seed";
import { leads, mockCrmSubscriptions, pipelineRuns, watermarks } from "@/db/schema";
import { queryRows, type Db } from "@/db/types";
import { MockAdSpend } from "@/lib/providers/adspend";
import { MockCrmExport } from "@/lib/providers/crm-export";
import { ProviderError } from "@/lib/providers/faults";
import type { Source } from "./extract";
import { PipelineBusyError, runPipeline, type PipelineDeps } from "./run";
import {
  adSpendSource,
  appCallsSource,
  appLeadsSource,
  branchList,
  crmCustomersSource,
  crmSubscriptionsSource,
} from "./sources";
import { createTestDb } from "./test-db";

let db: Db;
let close: () => Promise<void>;
let clock = new Date("2026-11-11T09:00:00Z");
const now = () => clock;

async function deps(overrides: Partial<PipelineDeps> = {}): Promise<PipelineDeps> {
  const crm = new MockCrmExport(db, { pageSize: 200 });
  const adspend = new MockAdSpend({ branches: await branchList(db), now, historyDays: 21, pageSize: 50 });
  return {
    db,
    crm,
    now,
    retry: { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
    sources: [
      appLeadsSource(db),
      appCallsSource(db),
      crmCustomersSource(crm),
      crmSubscriptionsSource(crm),
      adSpendSource(adspend),
    ],
    ...overrides,
  };
}

const count = async (table: string) => (await queryRows<{ n: number }>(db, sql.raw(`select count(*)::int as n from ${table}`)))[0].n;
const marts = () =>
  queryRows(
    db,
    sql`select json_build_object(
          'funnel', (select json_agg(f order by date, channel, branch_id) from mart_funnel_daily f),
          'cac', (select json_agg(c order by month, channel, branch_id) from mart_cac_by_channel_monthly c),
          'retention', (select json_agg(r order by month, branch_id, channel) from mart_retention_monthly r),
          'calls', (select json_agg(i order by date, branch_id, intent) from mart_call_intents_daily i)) as m`,
  );
const marks = async () => Object.fromEntries((await db.select().from(watermarks)).map((w) => [w.source, w.value.toISOString()]));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedHistory(db, { days: 21, now: clock });
});
afterAll(() => close());

describe("runPipeline", () => {
  let first: Awaited<ReturnType<typeof runPipeline>>;

  it("loads every source into raw, builds staging and marts, and passes every check", async () => {
    first = await runPipeline(await deps());
    expect(first.checks.filter((c) => !c.passed)).toEqual([]);
    expect(first.status).toBe("succeeded");

    expect(first.rowCounts.extracted_leads).toBe(await count("leads"));
    expect(first.rowCounts.extracted_ad_spend).toBe(20 * 3 * 3); // 20 complete days x 3 channels x 3 branches
    expect(first.rowCounts.mart_funnel_daily).toBeGreaterThan(0);
    expect(first.rowCounts.stg_leads).toBeLessThan(first.rowCounts.extracted_leads); // resubmissions deduplicated

    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, first.runId));
    expect(run.status).toBe("succeeded");
    expect(run.finishedAt).not.toBeNull();
    expect(run.checkResults).toHaveLength(first.checks.length);

    expect(Object.keys(await marks()).sort()).toEqual([
      "pipeline_ad_spend",
      "pipeline_calls",
      "pipeline_customers",
      "pipeline_leads",
      "pipeline_subscriptions",
    ]);
  });

  it("is idempotent: a rerun re-reads only the lookback window and changes nothing", async () => {
    const rawBefore = await Promise.all(["raw_leads", "raw_customers", "raw_subscriptions", "raw_calls", "raw_ad_spend"].map(count));
    const martsBefore = await marts();
    const marksBefore = await marks();

    const second = await runPipeline(await deps());
    expect(second.status).toBe("succeeded");
    expect(second.rowCounts.extracted_leads).toBeLessThan(first.rowCounts.extracted_leads);
    expect(second.rowCounts.extracted_ad_spend).toBe(4 * 3 * 3); // newest day + 3 days of restatements

    expect(await Promise.all(["raw_leads", "raw_customers", "raw_subscriptions", "raw_calls", "raw_ad_spend"].map(count))).toEqual(rawBefore);
    expect(await marts()).toEqual(martsBefore);
    expect(await marks()).toEqual(marksBefore);
  });

  it("picks up new and changed source rows incrementally", async () => {
    clock = new Date("2026-11-11T10:00:00Z");
    await db.insert(leads).values({
      branchId: 1,
      name: "New Person",
      phone: "512-555-7777",
      message: "Need lawn care",
      utmSource: "google",
      utmMedium: "cpc",
      idempotencyKey: "test_new_lead",
      crmCustomerId: "cus_new",
      createdAt: clock,
    });
    // A subscription cancels in the CRM
    const [sub] = await db.select().from(mockCrmSubscriptions).where(eq(mockCrmSubscriptions.status, "active")).limit(1);
    await db
      .update(mockCrmSubscriptions)
      .set({ status: "cancelled", cancelledAt: clock, cancelReason: "moving", updatedAt: clock })
      .where(eq(mockCrmSubscriptions.id, sub.id));

    const run = await runPipeline(await deps());
    expect(run.status).toBe("succeeded"); // reconciliation still matches after the cancellation
    const [stgLead] = await queryRows<{ channel: string }>(db, sql`select channel from stg_leads where lead_id in (select id::text from leads where idempotency_key = 'test_new_lead')`);
    expect(stgLead.channel).toBe("google_ads");
    const [stgSub] = await queryRows<{ status: string }>(db, sql`select status from stg_subscriptions where subscription_id = ${sub.id}`);
    expect(stgSub.status).toBe("cancelled");
    expect((await marks()).pipeline_leads).toBe(clock.toISOString());
  });

  it("fails the run on a failed quality check, records it, and holds the watermarks", async () => {
    clock = new Date("2026-11-11T11:00:00Z");
    const marksBefore = await marks();
    await db.insert(leads).values({
      branchId: null, // unknown ZIP: no branch
      name: "No Branch",
      email: "nobranch@example.com",
      message: "Somewhere we don't serve",
      idempotencyKey: "test_no_branch",
      createdAt: clock,
    });

    const run = await runPipeline(await deps());
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/not_null:stg_leads/);
    const failed = run.checks.find((c) => c.name === "not_null:stg_leads")!;
    expect(failed.passed).toBe(false);

    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.runId));
    expect(row.status).toBe("failed");
    expect(row.checkResults?.find((c) => c.name === "not_null:stg_leads")?.passed).toBe(false);
    expect(await marks()).toEqual(marksBefore); // the next run re-reads this batch

    // Fix the data and rerun: the lead is re-read (it's inside the re-read window), and the run passes.
    await db.update(leads).set({ branchId: 2 }).where(eq(leads.idempotencyKey, "test_no_branch"));
    const rerun = await runPipeline(await deps());
    expect(rerun.status).toBe("succeeded");
  });

  it("records a source outage as a failed run with the error, without moving watermarks", async () => {
    const marksBefore = await marks();
    const broken: Source = {
      ...appLeadsSource(db),
      fetchPage: async () => {
        throw new ProviderError("leads: 401 Unauthorized", 401);
      },
    };
    const base = await deps();
    const run = await runPipeline({ ...base, sources: [broken, ...base.sources.slice(1)] });
    expect(run.status).toBe("failed");
    expect(run.error).toBe("leads: 401 Unauthorized");
    expect(await marks()).toEqual(marksBefore);
  });

  it("refuses to start while another run is in progress", async () => {
    const [running] = await db.insert(pipelineRuns).values({ status: "running", startedAt: clock }).returning();
    await expect(runPipeline(await deps())).rejects.toBeInstanceOf(PipelineBusyError);
    await db.delete(pipelineRuns).where(eq(pipelineRuns.id, running.id));
  });
});
