// The five sources the nightly pipeline reads (SPEC Feature 5), each mapped to its raw_* table.
import { sql } from "drizzle-orm";
import { branches, calls, leads, rawAdSpend, rawCalls, rawCustomers, rawLeads, rawSubscriptions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { AdSpendProvider } from "@/lib/providers/adspend";
import type { CrmExportProvider } from "@/lib/providers/crm-export";
import type { RawRecord, Source } from "./extract";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PAGE_SIZE = 500;

const json = (o: object) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>; // Dates -> ISO strings

/**
 * An app table read with keyset pagination on (created_at, id). created_at is truncated to
 * milliseconds because that's all a JS Date (and so the cursor) can hold.
 */
function appTableSource(db: Db, name: string, table: typeof leads | typeof calls, rawTable: Source["table"]): Source {
  const createdMs = sql`date_trunc('milliseconds', ${table.createdAt})`;
  const idText = sql`${table.id}::text`;
  return {
    name,
    system: "app_db",
    table: rawTable,
    lookbackMs: DAY,
    async fetchPage(since, cursor) {
      const [at, id] = cursor ? [cursor.slice(0, 24), cursor.slice(25)] : [null, null];
      const page = await db
        .select()
        .from(table)
        .where(
          sql`${createdMs} >= ${since.toISOString()}::timestamptz
              ${at ? sql`and (${createdMs}, ${idText}) > (${at}::timestamptz, ${id})` : sql``}`,
        )
        .orderBy(createdMs, idText)
        .limit(PAGE_SIZE);
      const items: RawRecord[] = page.map((row) => ({
        sourceId: String(row.id),
        cursorAt: row.createdAt,
        payload: json(row),
      }));
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: items.length === PAGE_SIZE ? `${last.cursorAt.toISOString()}|${last.sourceId}` : undefined,
      };
    },
  };
}

export const appLeadsSource = (db: Db) => appTableSource(db, "leads", leads, rawLeads);
export const appCallsSource = (db: Db) => appTableSource(db, "calls", calls, rawCalls);

export function crmCustomersSource(crm: CrmExportProvider): Source {
  return {
    name: "customers",
    system: "mock_crm",
    table: rawCustomers,
    lookbackMs: DAY,
    async fetchPage(since, cursor) {
      const page = await crm.listCustomers(since, cursor);
      return { ...page, items: page.items.map((c) => ({ sourceId: c.id, cursorAt: c.updatedAt, payload: json(c) })) };
    },
  };
}

export function crmSubscriptionsSource(crm: CrmExportProvider): Source {
  return {
    name: "subscriptions",
    system: "mock_crm",
    table: rawSubscriptions,
    lookbackMs: DAY,
    async fetchPage(since, cursor) {
      const page = await crm.listSubscriptions(since, cursor);
      return { ...page, items: page.items.map((s) => ({ sourceId: s.id, cursorAt: s.updatedAt, payload: json(s) })) };
    },
  };
}

export function adSpendSource(adspend: AdSpendProvider): Source {
  return {
    name: "ad_spend",
    system: "mock_adspend",
    table: rawAdSpend,
    // Ad platforms restate recent days (late conversions, invalid-click credits): re-read 3 days.
    lookbackMs: 3 * DAY,
    async fetchPage(since, cursor) {
      const page = await adspend.getDailySpend(since, cursor);
      return {
        ...page,
        // The watermark tracks the spend date, so the next run starts from the newest day we have.
        items: page.items.map((r) => ({ sourceId: r.id, cursorAt: new Date(`${r.date}T00:00:00Z`), payload: json(r) })),
      };
    },
  };
}

/** Branches as the mock ad platforms know them (one account per branch). */
export function branchList(db: Db) {
  return db.select({ id: branches.id, name: branches.name, zipCodes: branches.zipCodes }).from(branches).orderBy(branches.id);
}
