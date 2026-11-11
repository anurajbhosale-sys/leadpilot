// The CRM's bulk-export API, used by the nightly pipeline (SPEC Feature 5). Kept separate from
// CrmProvider, which serves the live lead/call/win-back flows one record at a time.
import { and, asc, eq, gt, gte, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { mockCrmCustomers, mockCrmSubscriptions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Page } from "./crm";
import { MockFaults, type FaultOptions } from "./faults";

export type CrmCustomerRecord = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  zip: string | null;
  branchId: number | null;
  smsConsent: boolean;
  bookedAt: Date | null; // when the first service was scheduled
  firstServiceDate: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CrmSubscriptionRecord = {
  id: string;
  customerId: string;
  plan: string;
  monthlyPrice: number;
  status: string;
  startedAt: Date;
  cancelledAt: Date | null;
  cancelReason: string | null;
  updatedAt: Date;
};

export interface CrmExportProvider {
  /** Customers changed at or after `updatedSince`, oldest change first, one page at a time. */
  listCustomers(updatedSince: Date, cursor?: string): Promise<Page<CrmCustomerRecord>>;
  /** Subscriptions changed at or after `updatedSince`, oldest change first, one page at a time. */
  listSubscriptions(updatedSince: Date, cursor?: string): Promise<Page<CrmSubscriptionRecord>>;
  /** The CRM's own count, used to reconcile what the pipeline loaded. */
  countActiveSubscriptions(): Promise<number>;
}

// Keyset pagination: the cursor is the (updated_at, id) of the last row on the previous page,
// so rows changing mid-export can't make a page skip or repeat records.
const encodeCursor = (row: { updatedAt: Date; id: string }) => `${row.updatedAt.toISOString()}|${row.id}`;
function afterCursor(updatedAt: PgColumn, id: PgColumn, cursor?: string): SQL | undefined {
  if (!cursor) return undefined;
  const [at, lastId] = [cursor.slice(0, cursor.indexOf("|")), cursor.slice(cursor.indexOf("|") + 1)];
  const t = new Date(at);
  return or(gt(updatedAt, t), and(eq(updatedAt, t), gt(id, lastId)));
}

/** Mock CRM export over the mock_crm_* tables (filled by `npm run db:seed:history`). */
export class MockCrmExport implements CrmExportProvider {
  private faults: MockFaults;

  constructor(
    private db: Db,
    private opts: { pageSize?: number; faults?: FaultOptions } = {},
  ) {
    this.faults = new MockFaults(opts.faults);
  }

  async listCustomers(updatedSince: Date, cursor?: string): Promise<Page<CrmCustomerRecord>> {
    this.faults.check("crm.listCustomers");
    const t = mockCrmCustomers;
    const items = await this.db
      .select()
      .from(t)
      .where(and(gte(t.updatedAt, updatedSince), afterCursor(t.updatedAt, t.id, cursor)))
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(this.pageSize());
    return this.page(items);
  }

  async listSubscriptions(updatedSince: Date, cursor?: string): Promise<Page<CrmSubscriptionRecord>> {
    this.faults.check("crm.listSubscriptions");
    const t = mockCrmSubscriptions;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(gte(t.updatedAt, updatedSince), afterCursor(t.updatedAt, t.id, cursor)))
      .orderBy(asc(t.updatedAt), asc(t.id))
      .limit(this.pageSize());
    return this.page(rows.map((r) => ({ ...r, monthlyPrice: Number(r.monthlyPrice) })));
  }

  async countActiveSubscriptions(): Promise<number> {
    this.faults.check("crm.countActiveSubscriptions");
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(mockCrmSubscriptions)
      .where(eq(mockCrmSubscriptions.status, "active"));
    return Number(row.n);
  }

  private pageSize() {
    return this.opts.pageSize ?? 250;
  }

  private page<T extends { updatedAt: Date; id: string }>(items: T[]): Page<T> {
    const full = items.length === this.pageSize();
    return { items, nextCursor: full ? encodeCursor(items[items.length - 1]) : undefined };
  }
}
