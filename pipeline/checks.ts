// Data quality checks, run after every load (SPEC section 8). Any failed check fails the run,
// which the dashboard shows. Each check is a SQL query that returns the offending rows/values.
import { sql, type SQL } from "drizzle-orm";
import type { CheckResult } from "@/db/schema";
import { queryRows, type Db } from "@/db/types";
import { AD_CHANNELS } from "@/lib/providers/adspend";
import type { CrmExportProvider } from "@/lib/providers/crm-export";
import { callIntents } from "@/lib/schemas";
import { DEFAULT_RETRY, withRetry, type RetryOptions } from "./extract";
import { LEAD_CHANNELS } from "./transforms";

export type CheckContext = { db: Db; asOf: Date; crm: CrmExportProvider; retry?: RetryOptions };
export type Check = { name: string; run(ctx: CheckContext): Promise<Omit<CheckResult, "name">> };

export const FRESHNESS_HOURS = 26; // a nightly run plus slack
export const VOLUME_TOLERANCE = 0.5; // +/- 50% of the 7-day average
export const VOLUME_MIN_AVERAGE = 5; // below this many rows/day, the comparison is noise

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
const sample = (values: unknown[]) => values.slice(0, 5).join(", ") + (values.length > 5 ? `, ... (${values.length} total)` : "");

/** Freshness: the newest row in a raw table was loaded within the last 26 hours. */
export function freshness(table: string): Check {
  return {
    name: `freshness:${table}`,
    async run({ db, asOf }) {
      const [row] = await queryRows<{ latest: string | null }>(db, sql.raw(`select max(ingested_at)::text as latest from ${table}`));
      if (!row.latest) return { passed: false, detail: "no rows loaded yet" };
      const ageHours = (asOf.getTime() - new Date(row.latest).getTime()) / 3_600_000;
      return {
        passed: ageHours <= FRESHNESS_HOURS,
        detail: `last loaded ${ageHours.toFixed(1)}h ago (limit ${FRESHNESS_HOURS}h)`,
      };
    },
  };
}

/** Uniqueness: no key appears twice. */
export function uniqueness(table: string, columns: string[]): Check {
  const key = columns.join(", ");
  return {
    name: `unique:${table}(${key})`,
    async run({ db }) {
      const dupes = await queryRows<{ k: string }>(
        db,
        sql.raw(`select concat_ws('/', ${key}) as k from ${table} group by ${key} having count(*) > 1`),
      );
      return dupes.length ? { passed: false, detail: `duplicate keys: ${sample(dupes.map((d) => d.k))}` } : { passed: true };
    },
  };
}

/** Not null: no row breaks the rule. `badRows` selects an identifier for each offending row. */
export function notNull(name: string, badRows: SQL, rule: string): Check {
  return {
    name: `not_null:${name}`,
    async run({ db }) {
      const bad = await queryRows<{ id: string }>(db, badRows);
      return bad.length ? { passed: false, detail: `${rule}; failing: ${sample(bad.map((b) => b.id))}` } : { passed: true };
    },
  };
}

/** Accepted values: a column only holds values from an allowed list. */
export function acceptedValues(table: string, column: string, allowed: readonly string[]): Check {
  return {
    name: `accepted_values:${table}.${column}`,
    async run({ db }) {
      const bad = await queryRows<{ v: string | null; n: number }>(
        db,
        sql`select ${sql.identifier(column)} as v, count(*)::int as n from ${sql.identifier(table)}
            where ${sql.identifier(column)} is null or ${sql.identifier(column)} not in (${list(allowed)})
            group by 1`,
      );
      return bad.length
        ? { passed: false, detail: `unexpected values: ${bad.map((b) => `${b.v ?? "NULL"} (${b.n})`).join(", ")}` }
        : { passed: true };
    },
  };
}

/**
 * Volume: rows dated yesterday (the last complete UTC day) are within +/-50% of the daily
 * average of the 7 days before it. Skipped while there's too little history to compare.
 */
export function volume(table: string, dateColumn: string): Check {
  return {
    name: `volume:${table}`,
    async run({ db, asOf }) {
      const [row] = await queryRows<{ latest: number; avg7: number }>(
        db,
        sql`with days as (
              select ${sql.identifier(dateColumn)} as d, count(*) as n from ${sql.identifier(table)} group by 1
            ), bounds as (select (${asOf.toISOString()}::timestamptz at time zone 'UTC')::date - 1 as yesterday)
            select coalesce((select n from days, bounds where d = yesterday), 0)::int as latest,
                   coalesce((select sum(n) from days, bounds where d between yesterday - 7 and yesterday - 1), 0)::float8 / 7 as avg7`,
      );
      const { latest, avg7 } = row;
      const summary = `yesterday ${latest} rows vs 7-day average ${avg7.toFixed(1)}`;
      if (avg7 < VOLUME_MIN_AVERAGE) return { passed: true, detail: `skipped: too little history (${summary})` };
      const change = latest / avg7 - 1;
      return {
        passed: Math.abs(change) <= VOLUME_TOLERANCE,
        detail: `${summary} (${change >= 0 ? "+" : ""}${(change * 100).toFixed(0)}%, limit ±${VOLUME_TOLERANCE * 100}%)`,
      };
    },
  };
}

/** Reconciliation: active subscriptions we loaded match the CRM's own count. */
export const reconcileActiveSubscriptions: Check = {
  name: "reconciliation:active_subscriptions",
  async run({ db, crm, retry }) {
    const [{ n }] = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from stg_subscriptions where status = 'active'`);
    // A live API call, so it gets the same retries as extraction.
    const source = await withRetry(() => crm.countActiveSubscriptions(), retry ?? DEFAULT_RETRY);
    return { passed: n === source, detail: `pipeline ${n} vs CRM ${source}` };
  },
};

export const CHECKS: Check[] = [
  ...["raw_leads", "raw_customers", "raw_subscriptions", "raw_calls", "raw_ad_spend"].map(freshness),
  uniqueness("stg_customers", ["customer_id"]),
  uniqueness("stg_leads", ["lead_id"]),
  uniqueness("stg_subscriptions", ["subscription_id"]),
  uniqueness("stg_calls", ["call_id"]),
  uniqueness("stg_ad_spend", ["spend_date", "channel", "branch_id"]),
  notNull(
    "stg_leads",
    sql`select lead_id as id from stg_leads where (phone is null and email is null) or branch_id is null`,
    "every lead needs a phone or email and a branch",
  ),
  notNull(
    "stg_subscriptions",
    sql`select subscription_id as id from stg_subscriptions where customer_id is null or branch_id is null`,
    "every subscription needs a customer and a branch",
  ),
  notNull(
    "stg_ad_spend",
    sql`select concat_ws('/', spend_date, channel) as id from stg_ad_spend where branch_id is null`,
    "every spend row needs a branch",
  ),
  acceptedValues("stg_calls", "intent", callIntents),
  acceptedValues("stg_calls", "cancellation_risk", ["low", "medium", "high"]),
  acceptedValues("stg_leads", "channel", LEAD_CHANNELS),
  acceptedValues("stg_subscriptions", "status", ["active", "cancelled"]),
  acceptedValues("stg_ad_spend", "channel", AD_CHANNELS),
  volume("stg_leads", "lead_date"),
  volume("stg_calls", "call_date"),
  volume("stg_ad_spend", "spend_date"),
  reconcileActiveSubscriptions,
];

/** Run every check. A check that errors counts as failed rather than stopping the others. */
export async function runChecks(ctx: CheckContext, checks: Check[] = CHECKS): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      results.push({ name: check.name, ...(await check.run(ctx)) });
    } catch (err) {
      results.push({ name: check.name, passed: false, detail: `check errored: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return results;
}
