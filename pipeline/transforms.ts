// SQL transforms: raw -> staging -> marts (SPEC section 8). Staging and marts are rebuilt from
// raw on every run inside one transaction: simple, idempotent, and the dashboard never sees a
// half-built table. Metric definitions are documented in docs/METRICS.md; keep the two in sync.
//
// Dates are UTC calendar dates. `asOf` stands in for now(), so results are reproducible in tests.
import { sql, type SQL } from "drizzle-orm";
import { queryRows, type Db } from "@/db/types";

/** Lead channels the staging layer can produce (also the accepted-values check). */
export const LEAD_CHANNELS = ["google_ads", "local_services_ads", "meta", "organic", "referral", "direct"] as const;

// ---------------------------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------------------------

const stgLeads = sql`
insert into stg_leads (lead_id, source, created_at, lead_date, branch_id, phone, email, contact_key, channel,
                       utm_source, utm_medium, utm_campaign, crm_customer_id, service_category)
with parsed as (
  select
    payload->>'id' as lead_id,
    coalesce(nullif(payload->>'source', ''), 'web') as source,
    (payload->>'createdAt')::timestamptz as created_at,
    (payload->>'branchId')::int as branch_id,
    regexp_replace(coalesce(payload->>'phone', ''), '[^0-9]', '', 'g') as phone_digits,
    nullif(lower(trim(payload->>'email')), '') as email,
    nullif(lower(trim(payload->>'utmSource')), '') as utm_source,
    nullif(lower(trim(payload->>'utmMedium')), '') as utm_medium,
    nullif(trim(payload->>'utmCampaign'), '') as utm_campaign,
    nullif(trim(payload->>'gclid'), '') as gclid,
    payload->>'crmCustomerId' as crm_customer_id,
    payload->>'serviceCategory' as service_category
  from raw_leads
),
normalized as (
  select *,
    -- US numbers: drop a leading country code; anything that isn't 10 digits isn't a usable phone
    case
      when length(phone_digits) = 11 and left(phone_digits, 1) = '1' then right(phone_digits, 10)
      when length(phone_digits) = 10 then phone_digits
    end as phone
  from parsed
),
classified as (
  select *,
    coalesce(phone, email) as contact_key,
    case
      when utm_medium in ('lsa', 'local_services') or utm_source in ('lsa', 'google_lsa', 'localservices')
        then 'local_services_ads'
      when gclid is not null or (utm_source in ('google', 'adwords') and utm_medium in ('cpc', 'ppc', 'paid', 'paid_search', 'sem'))
        then 'google_ads'
      when utm_source in ('facebook', 'fb', 'instagram', 'ig', 'meta') and utm_medium in ('cpc', 'cpm', 'paid', 'paid_social', 'social_paid')
        then 'meta'
      when utm_medium in ('organic', 'seo', 'social', 'organic_social')
        or utm_source in ('google', 'bing', 'yahoo', 'duckduckgo', 'facebook', 'fb', 'instagram', 'ig')
        then 'organic'
      when utm_source is not null or utm_medium = 'referral' then 'referral'
      else 'direct'
    end as channel,
    row_number() over (partition by coalesce(phone, email) order by created_at, lead_id) as nth_for_contact
  from normalized
)
-- A lead is a unique contact: keep each phone/email's first lead. Leads with neither are kept
-- (they can't be deduplicated) so the not-null check reports them.
select lead_id, source, created_at, (created_at at time zone 'UTC')::date, branch_id, phone, email, contact_key, channel,
       utm_source, utm_medium, utm_campaign, crm_customer_id, service_category
from classified
where contact_key is null or nth_for_contact = 1`;

const stgCustomers = sql`
insert into stg_customers (customer_id, branch_id, created_at, booked_at, first_service_date, sms_consent)
select
  payload->>'id',
  (payload->>'branchId')::int,
  (payload->>'createdAt')::timestamptz,
  (payload->>'bookedAt')::timestamptz,
  (payload->>'firstServiceDate')::date,
  coalesce((payload->>'smsConsent')::boolean, false)
from raw_customers`;

const stgSubscriptions = sql`
insert into stg_subscriptions (subscription_id, customer_id, branch_id, plan, monthly_price, status,
                               started_at, cancelled_at, cancel_reason)
select
  s.payload->>'id',
  s.payload->>'customerId',
  c.branch_id, -- a subscription belongs to its customer's branch
  s.payload->>'plan',
  (s.payload->>'monthlyPrice')::numeric,
  lower(trim(s.payload->>'status')),
  (s.payload->>'startedAt')::timestamptz,
  (s.payload->>'cancelledAt')::timestamptz,
  s.payload->>'cancelReason'
from raw_subscriptions s
left join stg_customers c on c.customer_id = s.payload->>'customerId'`;

const stgCalls = sql`
insert into stg_calls (call_id, branch_id, call_date, ended_at, intent, cancellation_risk, matched_existing_customer)
select
  payload->>'callId',
  (payload->>'branchId')::int,
  (coalesce((payload->>'endedAt')::timestamptz, (payload->>'createdAt')::timestamptz) at time zone 'UTC')::date,
  coalesce((payload->>'endedAt')::timestamptz, (payload->>'createdAt')::timestamptz),
  lower(trim(payload->>'intent')),
  lower(trim(payload->>'cancellationRisk')),
  coalesce((payload->>'matchedExistingCustomer')::boolean, false)
from raw_calls`;

// Platforms may report several rows per day (campaigns, restatements under new IDs): sum to the grain.
const stgAdSpend = sql`
insert into stg_ad_spend (spend_date, channel, branch_id, spend, clicks, impressions)
select
  (payload->>'date')::date,
  lower(trim(payload->>'channel')),
  (payload->>'branchId')::int,
  sum((payload->>'spend')::numeric),
  sum(coalesce((payload->>'clicks')::int, 0)),
  sum(coalesce((payload->>'impressions')::int, 0))
from raw_ad_spend
group by 1, 2, 3`;

// ---------------------------------------------------------------------------------------------
// Marts
// ---------------------------------------------------------------------------------------------

// A customer's channel is the channel of their first lead; customers with no lead in our data
// (signed up before tracking began) are "unattributed".
const leadAttribution = sql`
lead_attr as (
  select distinct on (crm_customer_id) crm_customer_id, channel
  from stg_leads
  where crm_customer_id is not null
  order by crm_customer_id, created_at, lead_id
)`;

// Rows without a branch are left out of the marts; the not-null check fails the run for them.
const martFunnelDaily = (asOf: string) => sql`
insert into mart_funnel_daily (date, channel, branch_id, spend, leads, bookings, revenue)
with ${leadAttribution},
spend as (
  select spend_date as date, channel, branch_id, sum(spend) as spend
  from stg_ad_spend where branch_id is not null
  group by 1, 2, 3
),
lead_counts as (
  select lead_date as date, channel, branch_id, count(*) as leads
  from stg_leads where branch_id is not null
  group by 1, 2, 3
),
booking_counts as (
  select (c.booked_at at time zone 'UTC')::date as date, coalesce(a.channel, 'unattributed') as channel,
         c.branch_id, count(*) as bookings
  from stg_customers c
  left join lead_attr a on a.crm_customer_id = c.customer_id
  where c.booked_at is not null and c.booked_at <= ${asOf}::timestamptz and c.branch_id is not null
  group by 1, 2, 3
),
-- Revenue: each subscription bills its monthly price on its start date and every month after,
-- until it is cancelled.
revenue as (
  select (charged_at at time zone 'UTC')::date as date, coalesce(a.channel, 'unattributed') as channel,
         s.branch_id, sum(s.monthly_price) as revenue
  from stg_subscriptions s
  cross join lateral generate_series(s.started_at, ${asOf}::timestamptz, interval '1 month') as charged_at
  left join lead_attr a on a.crm_customer_id = s.customer_id
  where s.branch_id is not null and (s.cancelled_at is null or charged_at < s.cancelled_at)
  group by 1, 2, 3
)
select date, channel, branch_id, sum(spend), sum(leads), sum(bookings), sum(revenue)
from (
  select date, channel, branch_id, spend, 0 as leads, 0 as bookings, 0 as revenue from spend
  union all select date, channel, branch_id, 0, leads, 0, 0 from lead_counts
  union all select date, channel, branch_id, 0, 0, bookings, 0 from booking_counts
  union all select date, channel, branch_id, 0, 0, 0, revenue from revenue
) facts
group by date, channel, branch_id`;

// CAC = ad spend / new bookings, per paid channel, branch and calendar month.
const martCacByChannelMonthly = sql`
insert into mart_cac_by_channel_monthly (month, channel, branch_id, spend, new_bookings, cac)
select date_trunc('month', date)::date, channel, branch_id, sum(spend), sum(bookings),
       round(sum(spend) / nullif(sum(bookings), 0), 2)
from mart_funnel_daily
where channel in ('google_ads', 'local_services_ads', 'meta')
group by 1, 2, 3
having sum(spend) > 0 or sum(bookings) > 0`;

// Retention = of the subscriptions active when a month starts, the share still active when it
// ends. The current month is included as "retained so far" (is_complete = false).
const martRetentionMonthly = (asOf: string) => sql`
insert into mart_retention_monthly (month, branch_id, channel, active_at_start, retained_at_end, retention_rate, is_complete)
with ${leadAttribution},
months as (
  select m::date as month,
         (m::timestamp at time zone 'UTC') as starts_at,
         ((m + interval '1 month')::timestamp at time zone 'UTC') as ends_at
  from generate_series(
    (select date_trunc('month', min(lead_date)::timestamp) from stg_leads),
    date_trunc('month', (${asOf}::timestamptz at time zone 'UTC')),
    interval '1 month'
  ) as m
)
select m.month, s.branch_id, coalesce(a.channel, 'unattributed'),
       count(*),
       count(*) filter (where s.cancelled_at is null or s.cancelled_at >= least(m.ends_at, ${asOf}::timestamptz)),
       round(count(*) filter (where s.cancelled_at is null or s.cancelled_at >= least(m.ends_at, ${asOf}::timestamptz))::numeric
             / count(*), 4),
       m.ends_at <= ${asOf}::timestamptz
from months m
join stg_subscriptions s
  on s.started_at < m.starts_at and (s.cancelled_at is null or s.cancelled_at >= m.starts_at)
left join lead_attr a on a.crm_customer_id = s.customer_id
where s.branch_id is not null
group by m.month, s.branch_id, coalesce(a.channel, 'unattributed'), m.ends_at`;

const martCallIntentsDaily = sql`
insert into mart_call_intents_daily (date, branch_id, intent, calls, high_risk_calls)
select call_date, branch_id, intent, count(*), count(*) filter (where cancellation_risk = 'high')
from stg_calls
where branch_id is not null
group by 1, 2, 3`;

/** Every statement, in dependency order. Each table is emptied first, so a rerun rebuilds it. */
export function transformStatements(asOf: Date): { table: string; statements: SQL[] }[] {
  const at = asOf.toISOString();
  const rebuild = (table: string, insert: SQL) => ({ table, statements: [sql.raw(`delete from ${table}`), insert] });
  return [
    rebuild("stg_leads", stgLeads),
    rebuild("stg_customers", stgCustomers),
    rebuild("stg_subscriptions", stgSubscriptions), // after stg_customers: takes the branch from it
    rebuild("stg_calls", stgCalls),
    rebuild("stg_ad_spend", stgAdSpend),
    rebuild("mart_funnel_daily", martFunnelDaily(at)),
    rebuild("mart_cac_by_channel_monthly", martCacByChannelMonthly), // after mart_funnel_daily
    rebuild("mart_retention_monthly", martRetentionMonthly(at)),
    rebuild("mart_call_intents_daily", martCallIntentsDaily),
  ];
}

/** Rebuild staging and marts in one transaction. Returns the row count of each table. */
export async function runTransforms(db: Db, asOf: Date): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local time zone 'UTC'`); // month arithmetic in UTC, whatever the server's zone
    for (const { table, statements } of transformStatements(asOf)) {
      for (const statement of statements) await tx.execute(statement);
      const [{ n }] = await queryRows<{ n: number }>(tx, sql.raw(`select count(*)::int as n from ${table}`));
      counts[table] = n;
    }
  });
  return counts;
}
