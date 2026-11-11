# LeadPilot

AI lead, call & attribution platform for multi-location service businesses.

**Status: in active development**

LeadPilot connects a service business's website, phone system, and CRM, then turns that data into reliable marketing attribution and funnel reporting. It captures leads from the web and phone, structures them with AI, pushes them into the CRM safely and idempotently, and connects ad spend → leads → bookings → revenue → retention by source and branch. AI handles only the fuzzy parts (free-text requests and call transcripts); triggers, rules, and data movement are plain, testable code, and anything that reaches a customer goes through a human. It fits any multi-location, subscription-style service business: home services, cleaning, lawn care, HVAC, clinics, and similar.

See [docs/SPEC.md](docs/SPEC.md) for the full specification.

## Features

- **Smart lead form**: customers describe their need in plain language. UTM/`gclid` capture, ZIP → branch tagging, LLM extraction to validated JSON (service category, urgency, contact method, summary), a guardrailed follow-up SMS draft, and idempotent CRM creation.
- **Call intelligence**: `call.ended` webhooks are analyzed into a summary, intent, and cancellation risk, with a note written to the customer record.
- **Win-back automation**: an hourly job drafts personalized win-back messages for consenting, newly cancelled customers and routes them to a human approval queue.
- **Attribution & funnel reporting**: spend, leads, bookings, revenue, CAC, booking rate, and retention by source, channel, and branch, with data freshness on the dashboard.
- **Data pipeline & quality**: incremental, watermark-based extraction; raw → staging → marts SQL layers; freshness, uniqueness, not-null, accepted-values, volume, and reconciliation checks after every load; a run log for every run.
- **AI quality & cost tracking**: a golden-set eval script, per-run eval history, per-call logging of model/tokens/cost/latency, and a deterministic mock LLM mode so the project runs without an API key.

## Architecture

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

## Tech stack

| Layer | Choice |
|---|---|
| App | Next.js (App Router), React, TypeScript, Tailwind |
| AI | Vercel AI SDK, Claude or OpenAI, Zod structured output, mock mode |
| Database | PostgreSQL via Docker Compose, Drizzle ORM + migrations |
| Jobs | Scripts runnable locally; Vercel Cron routes in production |
| Testing | Vitest (guardrails, idempotency, quality checks, metric SQL) |
| CI | GitHub Actions: typecheck, lint, tests |

## Tradeoffs

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

## Getting started

> Placeholder steps. These will be finalized as the project is built out.

1. **Clone the repo**
   ```bash
   git clone https://github.com/anurajbhosale-sys/leadpilot.git
   cd leadpilot
   ```
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Fill in the values. API keys are optional: without them, LeadPilot runs in mock LLM mode.
4. **Start PostgreSQL**
   ```bash
   docker compose up -d
   ```
5. **Run migrations and seed data**
   ```bash
   npm run db:migrate
   npm run db:seed
   ```
6. **Start the app**
   ```bash
   npm run dev
   ```
