// Ad platforms (Google Ads, Local Services Ads, Meta) sit behind this interface, so real
// adapters can replace the mock without changing the pipeline.
import { addDays, isoDate, PAID_CHANNELS, spendFor, type HistoryBranch, type PaidChannel } from "@/lib/history";
import type { Page } from "./crm";
import { MockFaults, type FaultOptions } from "./faults";

export type AdChannel = PaidChannel;
export const AD_CHANNELS = PAID_CHANNELS;

/** One day of spend for one channel in one branch. Amounts in USD. */
export type SpendRow = {
  id: string; // stable per (date, channel, branch): reruns and restatements update the same row
  date: string; // YYYY-MM-DD (UTC)
  channel: AdChannel;
  branchId: number;
  spend: number;
  clicks: number;
  impressions: number;
  currency: "USD";
  updatedAt: Date; // when the platform last restated this day
};

export interface AdSpendProvider {
  /** Daily spend for every date on or after `since` (by calendar date), oldest first, one page at a time. */
  getDailySpend(since: Date, cursor?: string): Promise<Page<SpendRow>>;
}

export type MockAdSpendOptions = {
  branches: HistoryBranch[]; // ad accounts are set up per branch
  now?: () => Date;
  historyDays?: number; // how far back the accounts have data
  pageSize?: number;
  faults?: FaultOptions;
};

/**
 * Mock ad platforms with 90 days of history. Spend is a deterministic function of the date
 * (lib/history.ts), so every process sees the same numbers and new days appear as time passes.
 * Only complete days are reported (through yesterday, UTC), like a nightly export.
 */
export class MockAdSpend implements AdSpendProvider {
  private faults: MockFaults;

  constructor(private opts: MockAdSpendOptions) {
    this.faults = new MockFaults(opts.faults);
  }

  async getDailySpend(since: Date, cursor?: string): Promise<Page<SpendRow>> {
    this.faults.check("adspend.getDailySpend");
    const now = this.opts.now?.() ?? new Date();
    const pageSize = this.opts.pageSize ?? 100;
    const firstDay = addDays(now, -((this.opts.historyDays ?? 90) - 1));
    const start = isoDate(since > firstDay ? since : firstDay);
    const yesterday = isoDate(addDays(now, -1));

    const rows: SpendRow[] = [];
    for (let d = new Date(`${start}T00:00:00Z`); isoDate(d) <= yesterday; d = addDays(d, 1)) {
      const date = isoDate(d);
      // The platform finalizes a day the next morning.
      const finalized = new Date(addDays(d, 1).getTime() + 6 * 3_600_000);
      for (const channel of AD_CHANNELS) {
        for (const branch of this.opts.branches) {
          rows.push({
            id: `${date}:${channel}:${branch.id}`,
            date,
            channel,
            branchId: branch.id,
            ...spendFor(date, branch, channel),
            currency: "USD",
            updatedAt: finalized < now ? finalized : now,
          });
        }
      }
    }

    const offset = cursor ? Number(cursor) : 0;
    const next = offset + pageSize;
    return { items: rows.slice(offset, next), nextCursor: next < rows.length ? String(next) : undefined };
  }
}
