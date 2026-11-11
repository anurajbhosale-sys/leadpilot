import { sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import type { CheckResult } from "@/db/schema";
import { queryRows } from "@/db/types";
import { LEAD_CHANNELS } from "@/pipeline/transforms";

// Attribution & funnel reporting (SPEC Feature 4), read from the marts the nightly pipeline builds.
// Every metric is defined in docs/METRICS.md.

const CHANNELS = [...LEAD_CHANNELS, "unattributed"] as const;
const CHANNEL_LABELS: Record<string, string> = {
  google_ads: "Google Ads",
  local_services_ads: "Local Services Ads",
  meta: "Meta",
  organic: "Organic",
  referral: "Referral",
  direct: "Direct",
  unattributed: "Unattributed",
};
const RANGES = [7, 30, 90] as const;

const usd = (n: number | null, digits = 0) =>
  n === null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits });
const pct = (n: number | null) => (n === null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)}%`);
const int = (n: number) => n.toLocaleString("en-US");
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

type Totals = { spend: number; leads: number; bookings: number; revenue: number };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams; // reading searchParams makes this page render per request
  const branches = await queryRows<{ id: number; name: string }>(db, sql`select id, name from branches order by id`);
  const branchId = branches.find((b) => String(b.id) === one(params.branch))?.id ?? null;
  const channel = CHANNELS.find((c) => c === one(params.channel)) ?? null;
  const days = RANGES.find((r) => String(r) === one(params.days)) ?? 30;

  // Complete days only: the range ends yesterday (UTC), when ad spend is final.
  const end = new Date(Date.now() - 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const [from, to] = [isoDate(start), isoDate(end)];

  const filters = (opts: { channel?: boolean } = {}): SQL => sql.join(
    [
      sql`true`,
      branchId !== null ? sql`branch_id = ${branchId}` : sql`true`,
      opts.channel !== false && channel ? sql`channel = ${channel}` : sql`true`,
    ],
    sql` and `,
  );

  const [totalsRow] = await queryRows<Record<keyof Totals, string>>(
    db,
    sql`select coalesce(sum(spend), 0) as spend, coalesce(sum(leads), 0) as leads,
               coalesce(sum(bookings), 0) as bookings, coalesce(sum(revenue), 0) as revenue
        from mart_funnel_daily where date between ${from} and ${to} and ${filters()}`,
  );
  const totals: Totals = {
    spend: Number(totalsRow.spend),
    leads: Number(totalsRow.leads),
    bookings: Number(totalsRow.bookings),
    revenue: Number(totalsRow.revenue),
  };

  const daily = await queryRows<{ date: string; leads: number; bookings: number }>(
    db,
    sql`select d::date::text as date, coalesce(sum(f.leads), 0)::int as leads, coalesce(sum(f.bookings), 0)::int as bookings
        from generate_series(${from}::date, ${to}::date, interval '1 day') d
        left join mart_funnel_daily f on f.date = d::date and ${filters()}
        group by 1 order by 1`,
  );

  // Per channel, so the branch filter applies but every channel shows.
  const byChannel = await queryRows<{ channel: string } & Record<keyof Totals, string>>(
    db,
    sql`select channel, sum(spend) as spend, sum(leads) as leads, sum(bookings) as bookings, sum(revenue) as revenue
        from mart_funnel_daily where date between ${from} and ${to} and ${filters({ channel: false })}
        group by channel having sum(spend) > 0 or sum(leads) > 0 or sum(bookings) > 0
        order by sum(spend) desc, sum(leads) desc`,
  );

  const cacMonthly = await queryRows<{ month: string; channel: string; spend: string; new_bookings: number }>(
    db,
    sql`select month::text, channel, sum(spend) as spend, sum(new_bookings)::int as new_bookings
        from mart_cac_by_channel_monthly where ${filters()}
        group by month, channel order by month desc, channel limit 24`,
  );

  const retention = await queryRows<{ month: string; active_at_start: number; retained_at_end: number; is_complete: boolean }>(
    db,
    sql`select month::text, sum(active_at_start)::int as active_at_start, sum(retained_at_end)::int as retained_at_end,
               bool_and(is_complete) as is_complete
        from mart_retention_monthly where ${filters()}
        group by month order by month desc limit 6`,
  );
  const lastComplete = retention.find((r) => r.is_complete);

  const [run] = await queryRows<{
    id: number;
    status: string;
    started_at: string;
    finished_at: string | null;
    check_results: CheckResult[] | null;
    error: string | null;
  }>(db, sql`select id, status, started_at::text, finished_at::text, check_results, error from pipeline_runs order by started_at desc limit 1`);
  const [lastGood] = await queryRows<{ finished_at: string }>(
    db,
    sql`select finished_at::text from pipeline_runs where status = 'succeeded' order by started_at desc limit 1`,
  );
  const [freshness] = await queryRows<{ loaded: string | null; newest_lead: string | null; newest_spend: string | null }>(
    db,
    sql`select (select max(ingested_at)::text from (
                  select ingested_at from raw_leads union all select ingested_at from raw_calls
                  union all select ingested_at from raw_customers union all select ingested_at from raw_subscriptions
                  union all select ingested_at from raw_ad_spend) r) as loaded,
               (select max(created_at)::text from stg_leads) as newest_lead,
               (select max(spend_date)::text from stg_ad_spend) as newest_spend`,
  );

  const hasData = totals.spend > 0 || totals.leads > 0 || byChannel.length > 0;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-slate-600">
        Ad spend to leads, bookings, revenue and retention, from the nightly pipeline. {from} to {to} (UTC, complete days).
      </p>

      <DataHealth run={run} lastGood={lastGood?.finished_at ?? null} freshness={freshness} />

      <form className="mt-6 flex flex-wrap items-end gap-3 text-sm" method="get">
        <Select name="branch" label="Branch" value={branchId === null ? "" : String(branchId)} options={[["", "All branches"], ...branches.map((b) => [String(b.id), b.name] as [string, string])]} />
        <Select name="channel" label="Channel" value={channel ?? ""} options={[["", "All channels"], ...CHANNELS.map((c) => [c, CHANNEL_LABELS[c]] as [string, string])]} />
        <Select name="days" label="Range" value={String(days)} options={RANGES.map((r) => [String(r), `Last ${r} days`] as [string, string])} />
        <button className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700">Apply</button>
        {(branchId !== null || channel || days !== 30) && (
          <Link href="/dashboard" className="py-2 text-slate-500 hover:text-slate-900">Reset</Link>
        )}
      </form>

      {!hasData ? (
        <p className="mt-8 rounded-lg border border-dashed border-slate-300 p-6 text-slate-500">
          No data for this selection yet. Seed history with <code>npm run db:seed:history</code>, then run{" "}
          <code>npm run pipeline:run</code>.
        </p>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Ad spend" value={usd(totals.spend)} />
            <Stat label="Leads" value={int(totals.leads)} />
            <Stat label="Bookings" value={int(totals.bookings)} />
            <Stat label="Revenue" value={usd(totals.revenue)} />
            <Stat label="Cost per lead" value={usd(ratio(totals.spend, totals.leads), 2)} hint={channel && totals.spend === 0 ? "no spend on this channel" : "spend ÷ leads"} />
            <Stat label="CAC" value={usd(ratio(totals.spend, totals.bookings), 2)} hint="spend ÷ bookings" />
            <Stat label="Booking rate" value={pct(ratio(totals.bookings, totals.leads))} hint="bookings ÷ leads" />
            <Stat
              label="Retention"
              value={pct(lastComplete ? ratio(lastComplete.retained_at_end, lastComplete.active_at_start) : null)}
              hint={lastComplete ? `${monthName(lastComplete.month)}, last full month` : "no full month yet"}
            />
          </section>

          <DailyLeads daily={daily} />

          <h2 className="mt-10 text-lg font-semibold">By channel</h2>
          <Table
            head={["Channel", "Spend", "Leads", "Bookings", "Cost per lead", "CAC", "Booking rate", "Revenue"]}
            rows={byChannel.map((r) => {
              const [s, l, b] = [Number(r.spend), Number(r.leads), Number(r.bookings)];
              return [
                <span key="c" className={channel === r.channel ? "font-semibold" : ""}>{CHANNEL_LABELS[r.channel] ?? r.channel}</span>,
                usd(s),
                int(l),
                int(b),
                s > 0 ? usd(ratio(s, l), 2) : "—",
                s > 0 ? usd(ratio(s, b), 2) : "—",
                pct(ratio(b, l)),
                usd(Number(r.revenue)),
              ];
            })}
          />

          <div className="mt-10 grid gap-8 md:grid-cols-2">
            <div>
              <h2 className="text-lg font-semibold">CAC by month (paid channels)</h2>
              <Table
                head={["Month", "Channel", "Spend", "Bookings", "CAC"]}
                rows={cacMonthly.map((r) => [
                  monthName(r.month),
                  CHANNEL_LABELS[r.channel] ?? r.channel,
                  usd(Number(r.spend)),
                  int(r.new_bookings),
                  usd(ratio(Number(r.spend), r.new_bookings), 2),
                ])}
              />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Retention by month</h2>
              <Table
                head={["Month", "Active at start", "Still active", "Retention"]}
                rows={retention.map((r) => [
                  `${monthName(r.month)}${r.is_complete ? "" : " (so far)"}`,
                  int(r.active_at_start),
                  int(r.retained_at_end),
                  pct(ratio(r.retained_at_end, r.active_at_start)),
                ])}
              />
            </div>
          </div>
        </>
      )}
      <p className="mt-10 text-xs text-slate-500">Metric definitions: docs/METRICS.md.</p>
    </main>
  );
}

const monthName = (month: string) => new Date(`${month}T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function ago(iso: string | null) {
  if (!iso) return "never";
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min ago` : hours < 48 ? `${hours.toFixed(1)} h ago` : `${Math.round(hours / 24)} days ago`;
}

function DataHealth(p: {
  run: { id: number; status: string; finished_at: string | null; started_at: string; check_results: CheckResult[] | null; error: string | null } | undefined;
  lastGood: string | null;
  freshness: { loaded: string | null; newest_lead: string | null; newest_spend: string | null };
}) {
  if (!p.run) {
    return (
      <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>⚠ No pipeline run yet.</strong> Run <code>npm run pipeline:run</code> to load data.
      </div>
    );
  }
  const checks = p.run.check_results ?? [];
  const failed = checks.filter((c) => !c.passed);
  const stale = !p.freshness.loaded || Date.now() - new Date(p.freshness.loaded).getTime() > 26 * 3_600_000;
  const state =
    p.run.status === "failed"
      ? { icon: "✕", label: "Last run failed", box: "border-red-300 bg-red-50 text-red-900" }
      : p.run.status === "running"
        ? { icon: "…", label: "Pipeline running", box: "border-slate-300 bg-white text-slate-800" }
        : stale
          ? { icon: "⚠", label: "Data is stale", box: "border-amber-300 bg-amber-50 text-amber-900" }
          : { icon: "✓", label: "Data healthy", box: "border-emerald-300 bg-emerald-50 text-emerald-900" };

  return (
    <section className={`mt-6 rounded-lg border p-4 text-sm ${state.box}`} aria-label="Data health">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <strong className="text-base">
          <span aria-hidden>{state.icon}</span> {state.label}
        </strong>
        <span>
          Run #{p.run.id} {p.run.status} {ago(p.run.finished_at ?? p.run.started_at)} · {checks.length - failed.length}/{checks.length} checks passed
        </span>
        <span>Data loaded {ago(p.freshness.loaded)}</span>
        <span>Last successful run {ago(p.lastGood)}</span>
        <span>
          Newest lead {p.freshness.newest_lead?.slice(0, 16) ?? "—"} · spend through {p.freshness.newest_spend ?? "—"}
        </span>
      </div>
      {p.run.status === "failed" && (
        <div className="mt-2">
          {failed.length > 0 ? (
            <ul className="list-disc pl-5">
              {failed.map((c) => (
                <li key={c.name}>
                  <code>{c.name}</code>
                  {c.detail ? `: ${c.detail}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p>{p.run.error}</p>
          )}
          <p className="mt-1 opacity-80">The numbers below may be incomplete until a run succeeds.</p>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

function Select({ name, label, value, options }: { name: string; label: string; value: string; options: [string, string][] }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <select name={name} defaultValue={value} className="rounded-md border border-slate-300 bg-white px-3 py-2">
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (rows.length === 0) return <p className="mt-3 text-sm text-slate-500">No rows for this selection.</p>;
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`whitespace-nowrap px-3 py-2 font-medium ${i > 0 ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((cells, r) => (
            <tr key={r}>
              {cells.map((c, i) => (
                <td key={i} className={`whitespace-nowrap px-3 py-2 tabular-nums ${i > 0 ? "text-right" : ""}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// One series (leads per day) as thin bars; hover a day for leads and bookings.
function DailyLeads({ daily }: { daily: { date: string; leads: number; bookings: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.leads));
  const W = 720;
  const H = 140;
  const slot = W / daily.length;
  const bar = Math.max(2, Math.min(14, slot - 2));
  return (
    <section className="mt-8 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Leads per day</h2>
        <span className="text-xs text-slate-500">peak {max} · hover a bar for details</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="mt-3 w-full" role="img" aria-label="Leads per day">
        <line x1={0} x2={W} y1={H} y2={H} stroke="#cbd5e1" strokeWidth={1} />
        {daily.map((d, i) => {
          const h = (d.leads / max) * (H - 4);
          const x = i * slot + (slot - bar) / 2;
          return (
            <g key={d.date}>
              <title>{`${d.date}: ${d.leads} leads, ${d.bookings} bookings`}</title>
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              <rect x={x} y={H - h} width={bar} height={h} rx={Math.min(2, bar / 2)} fill="#2563eb" />
            </g>
          );
        })}
        <text x={0} y={H + 14} fontSize={11} fill="#64748b">{daily[0]?.date}</text>
        <text x={W} y={H + 14} fontSize={11} fill="#64748b" textAnchor="end">{daily[daily.length - 1]?.date}</text>
      </svg>
    </section>
  );
}
