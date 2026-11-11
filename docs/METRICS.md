# Metric definitions

One definition per metric. The SQL that implements them is in [`pipeline/transforms.ts`](../pipeline/transforms.ts), and [`pipeline/metrics.test.ts`](../pipeline/metrics.test.ts) checks it against hand-worked examples. If you change a definition here, change the SQL and the tests with it.

**Conventions**
- All dates are **UTC calendar dates**. A lead at 8 pm in Denver on the 3rd counts on the 4th.
- Every metric can be filtered by **branch** and **channel**. Ratios are always computed from summed parts (total spend ÷ total leads). They are never averages of daily or per-branch ratios.
- The dashboard covers complete days only, ending yesterday (UTC), because ad platforms finalize a day's spend the next morning.
- Rows with no branch are left out of the marts. The `not_null` quality check fails the run when they exist.

## Channel

The marketing channel a lead came from. It is derived from the lead's UTM parameters and `gclid`, checked in this order:

| Channel | Rule |
|---|---|
| `local_services_ads` | `utm_medium` is `lsa`/`local_services`, or `utm_source` is `lsa`/`google_lsa`/`localservices` |
| `google_ads` | has a `gclid`, or `utm_source` google/adwords with a paid medium (`cpc`, `ppc`, `paid`, `paid_search`, `sem`) |
| `meta` | `utm_source` facebook/fb/instagram/ig/meta with a paid medium (`cpc`, `cpm`, `paid`, `paid_social`, `social_paid`) |
| `organic` | `utm_medium` organic/seo/social, or a search engine or social `utm_source` with no paid medium |
| `referral` | any other `utm_source`, or `utm_medium=referral` |
| `direct` | no UTM parameters and no `gclid` (including phone leads from unknown callers) |

A customer's channel is the channel of **their first lead**. Customers with no lead in our data (they signed up before tracking began) are `unattributed`.

## Ad spend
Money spent on paid channels (`google_ads`, `local_services_ads`, `meta`), from the ad platforms' daily reports, by date, channel and branch. Platforms restate recent days, so the pipeline re-reads the last 3 days on every run.

## Lead
A **unique contact** (deduplicated by phone, else email) created from the web form or a phone call. A contact's first lead counts, on the day it was created. Later submissions from the same phone or email are not new leads. Phone numbers are compared as 10 digits, ignoring formatting and a leading `+1`, and emails are compared in lower case.

## Booking
A lead that became a CRM customer with a **scheduled first service**. It counts on the day the service was booked (`booked_at`), under the customer's channel.

## Revenue
Subscription billing. Each subscription bills its monthly price on its start date and every month after that, until it is cancelled. Revenue counts on the billing date, under the customer's channel and branch.

## Cost per lead (CPL)
**Ad spend ÷ leads** over the same dates, branches and channels. When unpaid channels are included (organic, referral, direct, or "all channels"), this is a *blended* CPL, because those leads have no spend.

## CAC (customer acquisition cost)
**Ad spend ÷ new bookings**, by channel and calendar month (`mart_cac_by_channel_monthly`, paid channels only). On the dashboard it is total spend ÷ total bookings for the selected filters, which is blended when unpaid channels are included. CAC is undefined (shown as —) when there are no bookings. Spend and bookings in the same month are compared directly, with no lag between a click and the booking it leads to.

## Booking rate
**Bookings ÷ leads**, each counted on its own date within the selected period. A lead from the last few days of the period may still book later, so the most recent period's rate tends to read low.

## Retention
**The share of subscriptions active at the start of a month that are still active at its end** (`mart_retention_monthly`). "Active at the start" means the subscription started before the month began and was not cancelled before then. Subscriptions that start during the month are not counted until the next month. The current month shows retention *so far* and is marked incomplete. The dashboard's headline figure is the last complete month. Months start at the first month that has lead data.

## Call intents
Calls per day, branch and intent (`new_quote`, `reschedule`, `complaint`, `cancellation`, `other`), with the number of high cancellation-risk calls (`mart_call_intents_daily`).

## Data quality checks

These run after every load. Any failure marks the run `failed`. The dashboard shows a failed run, and watermarks don't advance, so the next run re-reads the same data.

| Check | Rule |
|---|---|
| Freshness | Each `raw_*` table was last loaded within 26 hours |
| Uniqueness | No duplicate keys in `stg_customers`, `stg_leads`, `stg_subscriptions`, `stg_calls`, or `stg_ad_spend` (date × channel × branch) |
| Not null | Every lead has a phone or email **and** a branch. Every subscription has a customer and a branch. Every spend row has a branch |
| Accepted values | Call `intent` and `cancellation_risk`, lead `channel`, subscription `status`, and spend `channel` only hold allowed values |
| Volume | Yesterday's rows in `stg_leads`, `stg_calls`, and `stg_ad_spend` are within ±50% of the previous 7 days' daily average. The check is skipped when that average is below 5 rows/day |
| Reconciliation | Active subscriptions in `stg_subscriptions` equal the CRM's own active count |

## AI quality

These come from `npm run evals` (stored in `eval_runs`) and from `ai_logs`. The scoring is in [`evals/score.ts`](../evals/score.ts).

| Metric | Definition |
|---|---|
| Field accuracy | Share of golden cases where the model's value for that field matches the expected label. Matching ignores case and surrounding spaces. Ambiguous cases list several acceptable labels, and any of them counts. A failed model call counts as wrong on every field |
| Eval pass rate | Share of golden cases where **every** scored field is right. Lead extraction scores category, urgency and contact preference. Call analysis scores intent and cancellation risk. Summaries are not scored |
| SMS guardrail pass rate | Share of lead cases whose follow-up SMS draft passes guardrails without human review, allowing the one automatic retry. The draft is written from the case's *expected* extraction, so drafting is measured on its own |
| Meets threshold | Every field accuracy in a suite is at least the threshold (default 0.8, `EVAL_MIN_ACCURACY`) |
| AI cost | Sum of the estimated cost of logged calls: tokens × the price in `lib/ai/pricing.ts`. Models without a known price are left out, never guessed |
| AI latency | Time per AI call, as average and 95th percentile (nearest rank) |

Eval runs record the prompt version of each task, so runs on different prompts are never compared as if they were the same. Dashboard cost and latency cover real traffic only (`ai_logs.context = 'app'`); eval calls are tagged `eval` and reported with their run. Mock-mode results are labeled and don't measure model quality.
