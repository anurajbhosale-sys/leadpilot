# LeadPilot

[![CI](https://github.com/anurajbhosale-sys/leadpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/anurajbhosale-sys/leadpilot/actions/workflows/ci.yml)

AI lead, call and attribution platform for multi-location service businesses.

LeadPilot connects a service business's website, phone system and CRM:
- It captures leads from the web form and phone calls, and structures them with an LLM.
- It creates CRM records safely, so repeats never create duplicates.
- It turns the data into attribution reporting: ad spend → leads → bookings → revenue → retention, by channel and branch.

The LLM only handles the fuzzy parts: free-text requests, call transcripts and message drafts. Triggers, rules and data movement are plain, tested code, and a person approves anything risky before it reaches a customer. It fits any multi-location, subscription-style service business: pest control, lawn care, HVAC, cleaning, clinics and similar.

![LeadPilot dashboard: KPIs, leads per day, results by channel, CAC and retention by month, and AI quality](docs/images/dashboard.png)

*The dashboard on 90 days of synthetic history, with the latest real eval run on Claude Haiku 5.5.*

## Features

- **Smart lead form.** Customers describe their need in plain language.
  - Captures UTM parameters and `gclid`, and assigns the branch from the ZIP code.
  - The LLM extracts the service category, urgency, preferred contact method and a summary, as JSON validated against a schema.
  - It drafts a follow-up SMS that has to pass guardrails, then creates the CRM record. Duplicate submissions never create a second record.
- **Call intelligence.** Signed `call.ended` webhooks are analyzed into a summary, an intent and a cancellation risk, and a note is written to the customer's CRM record.
- **Win-back automation.** An hourly job drafts personal win-back messages for newly cancelled customers who agreed to contact. A person approves or rejects each one before anything is sent.
- **Attribution and funnel reporting.** Spend, leads, bookings, revenue, cost per lead, CAC, booking rate and retention, by channel and branch. The dashboard also shows how fresh the data is.
- **Data pipeline and quality checks.**
  - Extraction is incremental, using watermarks.
  - SQL layers go raw → staging → marts.
  - After every load, checks run for freshness, uniqueness, not-null, accepted values, volume and reconciliation, and every run is logged.
- **AI quality and cost tracking.**
  - Golden-set evals report accuracy per field and record each run with its prompt versions.
  - Every LLM call logs its model, tokens, cost and latency.
  - A deterministic mock LLM lets the whole project run without an API key.
- **Public demo mode.** A banner says the data is synthetic, and the LLM is forced to mock so visitors can't spend API credits. The public routes are rate-limited.

## Architecture

```mermaid
flowchart LR
  visitor["Visitor<br/>(UTM, gclid)"] --> form["/api/leads"]
  center["Contact center"] -- "signed call.ended" --> hook["/api/webhooks/calls"]
  cron["Vercel Cron"] -- "daily" --> pipe["/api/cron/pipeline"]
  cron -- "hourly" --> wb["/api/cron/winback"]

  form --> rl{{"Rate limit<br/>(Postgres)"}}
  hook --> rl
  rl --> llm["LLM tasks<br/>extract · analyze · draft<br/>Zod schemas + guardrails"]
  wb --> llm
  llm --> crm["CRM adapter<br/>(idempotent)"]
  wb --> queue["Approval queue"]

  subgraph db["PostgreSQL"]
    app["App tables<br/>leads, calls, approvals,<br/>ai_logs, eval_runs"]
    raw["raw_*"] --> stg["stg_*"] --> mart["mart_*"]
  end

  llm --> app
  pipe -- "extract (watermarks)" --> sources["CRM, call and<br/>ad platform APIs"]
  sources --> raw
  pipe -- "quality checks" --> mart
  mart --> dash["Dashboard"]
  app --> dash
```

Providers (CRM, contact center, ad platforms, SMS) sit behind adapter interfaces. This repo ships mock implementations, so it runs end to end with no accounts.

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router), React 19, TypeScript, Tailwind |
| AI | Vercel AI SDK; Claude Haiku 5.5 by default (or OpenAI); Zod structured output; mock mode |
| Database | PostgreSQL (Docker locally, Neon in production), Drizzle ORM and migrations |
| Jobs | Scripts you can run locally; Vercel Cron routes in production |
| Tests | Vitest, with PGlite (in-process Postgres) for the SQL |
| CI | GitHub Actions: typecheck, lint, tests |

## Run locally

Requirements: Node.js 20+ (CI uses 24) and Docker.

```bash
npm ci
cp .env.example .env    # then fill in DATABASE_URL, WEBHOOK_SECRET and CRON_SECRET (see below)
docker compose up -d    # Postgres on :5432; if that port is taken, use POSTGRES_PORT=5434
npm run setup           # migrate, seed branches, seed 90 days of history, run the pipeline
npm run dev             # http://localhost:3000
```

Values for `.env`:
- `DATABASE_URL`: `postgres://leadpilot:leadpilot@localhost:5432/leadpilot`
- `WEBHOOK_SECRET` and `CRON_SECRET`: random strings, for example from `openssl rand -hex 32`
- `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`): optional. Without either, the LLM runs in mock mode.

The default model is `claude-haiku-5-5`. To use another one, set `ANTHROPIC_MODEL`.

Things to try once the app is running:

```bash
npm run webhook:send -- --all   # send five sample calls, then open /calls
npm run winback:run             # draft win-back messages, then review them at /approvals
npm run sms:send-due            # send follow-up SMS that were held until business hours
```

The lead form is at `/` and the reporting is at `/dashboard`. Metric definitions are in [docs/METRICS.md](docs/METRICS.md), and the full specification is in [docs/SPEC.md](docs/SPEC.md).

## Tests, pipeline and evals

```bash
npm run typecheck && npm run lint && npm test   # what CI runs on every push (mock LLM, no database needed)
npm run pipeline:run                            # extract -> raw_* -> stg_* -> mart_* -> quality checks; exits 1 on failure
npm run db:seed:history                         # add any days since the last seed (safe to rerun)
npm run evals                                   # score the golden sets and save the results to eval_runs
npm run evals -- --threshold 0.9                # exit 1 if any field is below 90% accuracy
```

The database tests run against PGlite, so `npm test` needs neither Docker nor an API key.

Without an API key, `npm run evals` runs in mock mode: its scores come from keyword rules, are labeled as not meaningful, and don't enforce the threshold unless you add `--strict`.

If you change a prompt in `lib/ai/prompts.ts`, bump its version. A test fails if you forget.

TypeScript note: `tsc` is TypeScript 7 (`@typescript/native`), while the `typescript` package is the TypeScript 6 API (`@typescript/typescript6`), because ESLint's TypeScript support and Next's build still need that API.

## Eval results

These are real runs on **Claude Haiku 5.5**, the default model, against the golden sets in [`evals/`](evals). The sets have 20 lead messages and 20 call transcripts, hand-labeled, and include vague, mixed-intent, discount-seeking and angry cases. Accuracy is the share of cases where a field matches the label. The SMS suite checks that drafts pass guardrails without human review.

| Suite | Field accuracy | Cases fully right | Cost (20 calls) | Latency avg / p95 |
|---|---|---|---|---|
| Lead extraction | category 100%, urgency 100%, contact 100% | 20/20, 20/20 | $0.0020, $0.0021 | 1.1–2.1 s / 1.3–3.6 s |
| Call analysis | intent 95–100%, cancellation risk 95% | 19/20, 18/20 | $0.0024, $0.0023 | 1.1–1.2 s / 1.6–2.1 s |
| SMS guardrails | passes guardrails 100% | 20/20, 20/20 | $0.0033, $0.0036 | 1.7–1.8 s / 2.5–2.6 s |

Each cell gives both runs, from November 11, 2026.
- **Total:** 59/60 and 58/60 cases fully right, at $0.0077 and $0.0080 per full run of 60 calls.
- **Call misses:**
  - `call-19-quote-competitor` was rated medium cancellation risk where the label is low, in both runs.
  - In one run, `call-17-pause-service` was read as a cancellation rather than a reschedule or other.

Both runs met the 80% per-field threshold. That accuracy at under a cent per 60 calls is why Haiku 5.5 is the default rather than a larger model.

## Deploy (Vercel + Neon)

1. **Create the database.**
   - In the [Neon console](https://console.neon.tech), create a project on Postgres 17, in AWS `us-east-1`, which is closest to Vercel's default function region `iad1`.
   - Open **Connect** and copy two connection strings: the **pooled** one (its host contains `-pooler`) and the **direct** one (turn "Connection pooling" off).
2. **Load the data once** from your machine, using the direct string:
   ```bash
   DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require&channel_binding=require' npm run setup
   ```
   It shows the host it's about to write to and asks for `y` before it changes anything. A `DATABASE_URL` on the command line overrides the one in your `.env`.
3. **Create the Vercel project.** In Vercel, choose **Add New → Project** and import this GitHub repo. Next.js is detected automatically. Then go to **Settings → Build and Deployment** and set **Node.js Version** to 24.x.
4. **Set the environment variables** under **Settings → Environment Variables**, for Production:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon's **pooled** connection string |
   | `CRON_SECRET` | `openssl rand -hex 32` (letters and digits only; Vercel Cron sends it as a header) |
   | `WEBHOOK_SECRET` | `openssl rand -hex 32` |
   | `DEMO_MODE` | `true` |

   Leave `ANTHROPIC_API_KEY` unset on a public demo. Even if you do set it, demo mode won't call the model unless you also set `DEMO_LLM=true`.
5. **Choose the cron plan.** [`vercel.json`](vercel.json) runs the pipeline daily at 07:00 UTC and win-back hourly. **The Hobby plan only allows daily cron jobs, and a deploy with the hourly schedule fails.** On Hobby, change the win-back schedule to `"0 8 * * *"`. On Pro, keep it hourly.
6. **Deploy**: click **Deploy**, or push to `main`.
7. **Check it.**
   - Open `/dashboard`. You should see the demo banner and data that's "healthy".
   - Run the pipeline by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/cron/pipeline`.
   - The scheduled runs and their logs are under **Schedules → Cron Jobs**.
8. **Optional: show real eval results** in "AI quality". Run them locally against Neon. This uses your own key and costs under $0.01:
   ```bash
   DATABASE_URL='<direct string>' npm run evals
   ```

## Design tradeoffs

| Decision | Choice | Reasoning |
|---|---|---|
| Agent vs. fixed pipeline | Fixed pipeline, LLM per step | Predictable, cheaper and testable. Each LLM output is validated against a schema |
| Model | Claude Haiku 5.5 by default, overridable | 58–59/60 on the golden sets at under $0.01 per 60 calls; a larger model costs much more for at most a case or two |
| Auto-send vs. approval | Approval for win-back messages and for SMS that fail guardrails | Customer-facing offers need a person's check |
| Webhooks vs. polling | Webhooks for calls, polling for the CRM | Matches what each kind of provider usually supports |
| Batch vs. streaming | Nightly batch | Reporting doesn't need real time, and streaming adds cost |
| Full reload vs. incremental | Incremental, with watermarks and lookback windows | Respects API rate limits and picks up late changes such as ad-spend restatements |
| Postgres vs. warehouse | Postgres for raw, staging and marts | The volume is small. Move to BigQuery or Snowflake as data grows |
| Custom extractors vs. Fivetran/Airbyte | Custom for niche CRMs | Niche APIs rarely have solid connectors. Buy them for common sources |
| Rules in code vs. configuration | Per-branch configuration in the database (ZIP codes, hours, approved offers) | New branches need no code change |
| Rate limiting | Fixed window per IP, stored in Postgres | No extra service such as Redis. One upsert per request is fine at this scale |
| Public demo | Mock LLM unless `DEMO_LLM=true` | A public URL can't spend the owner's API credits |

## Known limitations

- **Integrations are mocks.** The CRM, contact center, ad platforms and SMS sender are mock adapters, and all data is synthetic. Ad spend comes from a deterministic generator.
- **There is no authentication.** Anyone who can open the app can approve or reject queued messages and see the dashboard. That's fine for a synthetic demo, but a real deployment needs sign-in.
- **The evals are small.** There are 20 cases per suite, labeled by one person, and each run is a single sample. Scores move by a case or two between runs (59 vs. 58 of 60), so treat a difference of one case as noise. Summaries aren't scored.
- **Mock-mode scores are meaningless.** They come from keyword rules, not a model, and are labeled as such.
- **Cron on Vercel Hobby runs at most daily.** Hourly win-back needs Pro. The send-due-SMS job isn't scheduled; run it by hand or add a cron entry.
- **The pipeline runs in one function call.** It finishes in seconds on the demo data and is allowed up to 300 s. Much larger data would need chunked runs or a queue.
- **The rate limiter is simple.** A fixed window allows a burst of up to twice the limit at a window boundary. Clients behind one shared IP share a limit. If the database is unavailable, the limiter lets requests through.
- **Some metric definitions are simplified.** Dates are UTC, CAC has no click-to-booking lag, and the latest period's booking rate reads low. See [docs/METRICS.md](docs/METRICS.md).
- **Model prices are kept by hand** in `lib/ai/pricing.ts`. Models without a known price log no cost rather than a guess.
