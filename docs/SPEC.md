# LeadPilot – AI Lead, Call & Attribution Platform

LeadPilot connects a service business's website, phone system, and CRM, then turns that data into reliable marketing attribution and funnel reporting. It uses AI for the fuzzy parts (understanding free-text requests and call transcripts) and plain, testable code for everything else.

It fits any multi-location, subscription-style service business: home services, cleaning, lawn care, HVAC, clinics, and similar.

> Design principle: plain code for triggers, rules, and data movement; the LLM only for the fuzzy parts; a human for anything that reaches a customer.

---

## 1. Goals

- Capture leads from the web and phone, structure them with AI, and push them into the CRM **safely and idempotently**.
- Connect **ad spend → leads → bookings → revenue → retention** by source and branch, so leaders can see acquisition cost and channel performance.
- Keep data **trustworthy**: incremental pipelines, layered models, and quality checks that fail loudly.
- Measure AI quality and cost continuously with evals and logging.

---

## 2. Features

### Feature 1 – Smart lead form
A customer describes their need in plain language, e.g. *"water leaking under the kitchen sink, need someone this week."*

- UTM parameters and `gclid` are captured from the landing URL and stored with the lead.
- The lead is tagged with a **branch** (from ZIP code → branch lookup).
- LLM extracts structured data as validated JSON: service category, urgency, preferred contact method, short summary.
- LLM drafts a follow-up SMS; guardrails check it (section 6).
- The lead is created in the CRM through a **provider adapter** (mock CRM by default) with an idempotency key.

### Feature 2 – Call intelligence
A contact-center `call.ended` webhook delivers a transcript, which is analyzed into:

- Summary
- Intent: `new_quote` | `reschedule` | `complaint` | `cancellation` | `other`
- Cancellation risk: `low` | `medium` | `high`
- A note written to the customer record in the CRM

### Feature 3 – Win-back automation
An hourly job finds newly cancelled subscriptions, checks SMS consent, drafts a personalized win-back message within approved rules, and puts it in a **human approval queue**.

### Feature 4 – Attribution & funnel reporting
Reporting that connects marketing spend to business results by **source, channel, and branch**:

- Ad spend (mock daily spend by channel and branch)
- Leads, bookings, revenue, and cancellations
- Cost per lead, cost per booking (CAC), booking rate, and retention
- A dashboard page showing these metrics, with data freshness shown on the page

### Feature 5 – Data pipeline & data quality
- **Extract:** pull leads, customers, subscriptions, calls, and ad spend **incrementally**, using a watermark per source, with pagination, rate-limit handling, and retries.
- **Load (raw layer):** land records unchanged in `raw_*` tables with `source` and `ingested_at`, using upserts on source IDs so reruns are idempotent.
- **Transform:** SQL from raw → staging (cleaned, normalized, deduplicated) → marts (business-ready).
- **Quality checks:** freshness, uniqueness, not-null, accepted values, volume anomalies, and reconciliation against the source, after every load.
- **Run log:** every run recorded with status, row counts, duration, and check results.

### Feature 6 – AI quality & cost tracking
- Golden set of 15–20 labeled examples and an eval script that reports accuracy per field.
- Results stored per run in `eval_runs` (prompt version, pass rate, cost) to track drift over time.
- Every AI call logged: model, tokens, cost, latency, pass/fail.
- **Mock LLM mode:** deterministic fake responses when no API key is set, so anyone can clone and run the project.

---

## 3. Automations

| # | Automation | Trigger |
|---|---|---|
| A1 | Call ended → analysis → note in CRM | Event (contact-center webhook) |
| A2 | Cancellation win-back → approval queue | Schedule (hourly, polls CRM) |
| A3 | Lead follow-up SMS, respecting quiet hours | Event (lead created) |
| A4 | Nightly pipeline + quality checks + evals | Schedule (nightly) |

### A1 – Call ended
1. Contact center sends `call.ended` with the transcript to `/api/webhooks/calls`.
2. Verify the webhook signature.
3. Check the idempotency key (`callId`); if already processed, return 200 and stop.
4. Analyze the call (Feature 2) and write the note to the CRM.
5. Flag `high` cancellation risk for the retention team.

### A2 – Cancellation win-back
1. Poll the CRM for cancellations since the last **watermark**.
2. Skip customers without SMS consent.
3. LLM drafts a message within approved rules (no invented discounts).
4. Draft goes to the approval queue; a person approves, edits, or rejects.
5. Approved messages are "sent" (logged only).
6. Advance the watermark only after the batch succeeds.

### A3 – Lead follow-up
Send immediately during business hours in the branch's time zone; otherwise hold until the next morning.

### A4 – Nightly pipeline
Extract → load raw → transform → quality checks → evals → record the run. Watermarks advance only on success, and every step is safe to rerun.

---

## 4. Multi-Branch & Configuration

- Every lead, customer, call, and spend row carries a `branch_id`.
- `branches` table: name, region, time zone, ZIP codes served, business hours.
- Business rules (quiet hours, approved offers, message templates) are configured per branch in the database, not hard-coded.
- Reports can be filtered by branch, region, and channel.

---

## 5. Provider Adapters

Integrations sit behind interfaces so real systems can replace the mocks without changing business logic:

```ts
interface CrmProvider {
  createCustomer(input: NewCustomer, idempotencyKey: string): Promise<CrmCustomer>;
  searchCustomers(query: CustomerQuery): Promise<CrmCustomer[]>;
  addNote(customerId: string, note: string): Promise<void>;
  listCancellations(since: Date, cursor?: string): Promise<Page<Cancellation>>;
}

interface CallProvider {
  verifyWebhook(rawBody: string, signature: string): boolean;
}

interface AdSpendProvider {
  getDailySpend(since: Date): Promise<SpendRow[]>;
}
```

The default implementations are mock APIs inside the app, with realistic behavior: auth checks, rate limits, pagination, and occasional simulated failures to exercise retries. Real adapters (e.g. FieldRoutes, HubSpot, Salesforce, Talkdesk, Google Ads) are listed as next steps.

---

## 6. Guardrails

Applied to every customer-facing draft before it can be queued or sent:

- No prices, discounts, or guarantees unless they come from the branch's approved list.
- No health, safety, or legal claims.
- Must include opt-out text ("Reply STOP to opt out").
- Length limit (320 characters).
- No other customers' data; minimal PII in prompts.
- Code checks first (regex, length, banned phrases); on failure, retry once with the error, then route to human review.

---

## 7. Architecture

```
 Visitor (UTM/gclid) ─► Next.js app (App Router)
                         ├─ /api/leads ─────────► LLM (extract + draft) ─► guardrails
                         ├─ /api/webhooks/calls ► LLM (call analysis)
                         ├─ /api/cron/winback ──► LLM (win-back draft) ─► approval queue
                         └─ /api/cron/pipeline
                                 │
             Provider adapters (CRM, calls, ad spend) ── mock APIs by default
                                 │
                          PostgreSQL (Drizzle ORM)
     app tables: leads, branches, processed_events, approval_queue, ai_logs
     raw_* ──► stg_* ──► mart_*      pipeline_runs, eval_runs, watermarks
                                 │
             Dashboard: spend, leads, bookings, CAC, retention, data health, AI quality
```

---

## 8. Data Model

**App tables:** `branches`, `leads`, `processed_events` (idempotency keys), `approval_queue`, `ai_logs`, `watermarks`, `pipeline_runs`, `eval_runs`.

**Layers**

| Layer | Tables |
|---|---|
| Raw | `raw_leads`, `raw_customers`, `raw_subscriptions`, `raw_calls`, `raw_ad_spend` |
| Staging | `stg_leads`, `stg_customers`, `stg_subscriptions`, `stg_calls`, `stg_ad_spend` |
| Marts | `mart_funnel_daily` (spend, leads, bookings, revenue by date × source × branch), `mart_cac_by_channel_monthly`, `mart_retention_monthly`, `mart_call_intents_daily`, `mart_ai_quality` |

**Key metric definitions** (one definition per metric, documented in the repo):

- **Lead:** a unique contact (deduplicated by phone/email) created from web or phone.
- **Booking:** a lead that became a customer with a scheduled first service.
- **CAC:** ad spend ÷ new bookings, by channel and month.
- **Retention:** share of subscriptions active at the start of a month that remain active at its end.

**Quality checks**

| Check | Example |
|---|---|
| Freshness | Latest `raw_calls.ingested_at` under 26 hours old |
| Uniqueness | No duplicate customer IDs in `stg_customers` |
| Not null | Every lead has a phone or email and a branch |
| Accepted values | `intent` is one of the allowed values |
| Volume | Today's row count within ±50% of the 7-day average |
| Reconciliation | Active subscription count matches the source CRM |

---

## 9. Tech Stack

| Layer | Choice |
|---|---|
| App | Next.js (App Router), React, TypeScript, Tailwind |
| AI | Vercel AI SDK, Claude or OpenAI, Zod structured output, mock mode |
| Database | PostgreSQL via Docker Compose, Drizzle ORM + migrations |
| Jobs | Scripts runnable locally; Vercel Cron routes in production |
| Testing | Vitest (guardrails, idempotency, quality checks, metric SQL) |
| CI | GitHub Actions: typecheck, lint, tests |

---

## 10. Folder Structure

```
leadpilot/
├── app/
│   ├── page.tsx                  # lead form
│   ├── calls/page.tsx            # call analysis viewer
│   ├── approvals/page.tsx        # approval queue
│   ├── dashboard/page.tsx        # funnel, CAC, retention, data health, AI quality
│   └── api/
│       ├── leads/route.ts
│       ├── webhooks/calls/route.ts
│       ├── cron/winback/route.ts
│       ├── cron/pipeline/route.ts
│       └── mock/[provider]/[...path]/route.ts
├── lib/
│   ├── ai/                       # client (real + mock), prompts, extract, analyze, draft
│   ├── providers/                # crm.ts, calls.ts, adspend.ts (interfaces + mocks)
│   ├── guardrails.ts
│   ├── idempotency.ts
│   ├── schemas.ts
│   └── logging.ts
├── db/                           # Drizzle schema, migrations, seed data
├── pipeline/
│   ├── extract/  load.ts  transforms/  checks.ts  run.ts
├── evals/
│   ├── golden.json
│   └── run-evals.ts
├── scripts/                      # send-mock-webhook.ts, run-pipeline.ts, run-winback.ts, seed.ts
├── docs/                         # METRICS.md (metric definitions), SPEC.md
├── docker-compose.yml
└── README.md
```

---

## 11. Tradeoffs

| Decision | Choice | Reasoning |
|---|---|---|
| Agent vs. fixed pipeline | Fixed pipeline | Predictable, cheaper, easier to test |
| Model size | Small for extraction/intent, larger for customer copy | Cost vs. quality |
| Webhooks vs. polling | Webhooks for calls, polling for the CRM | Matches what each provider typically supports |
| Auto-send vs. approval | Approval for win-back messages | Customer-facing offers need a human check |
| Custom extractors vs. Fivetran/Airbyte | Custom for niche CRMs, buy for common sources | Niche APIs often lack solid connectors |
| Postgres vs. warehouse | Postgres | Small volume; move to Snowflake/BigQuery as data grows |
| Batch vs. streaming | Nightly batch | Reporting doesn't need real-time; streaming adds cost |
| Full reload vs. incremental | Incremental with watermarks | Respects rate limits; full reload kept for backfills |
| Hard-coded vs. configured rules | Per-branch configuration in the database | Scales to new branches without code changes |

---

## 12. Next Steps

- Real adapters: FieldRoutes or HubSpot/Salesforce (CRM), Talkdesk (calls), Google Ads and Local Services Ads (spend), Twilio (SMS).
- Offline conversion upload to Google Ads from `mart_funnel_daily`.
- Move transforms to dbt and the warehouse to Snowflake or BigQuery.
- RAG over service policies so the lead form can answer customer questions.
- A/B test AI-drafted vs. human-written win-back messages.
- Role-based access (admin, marketing, branch manager) for the dashboard and approval queue.
