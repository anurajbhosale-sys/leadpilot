import { sql } from "drizzle-orm";
import { db } from "@/db";
import { queryRows } from "@/db/types";

// AI quality (SPEC Feature 6): golden-set eval results from eval_runs, and the cost/latency of
// real traffic from ai_logs (eval calls are tagged context = 'eval' and left out).

const SUITE_LABELS: Record<string, string> = {
  extract_lead: "Lead extraction",
  analyze_call: "Call analysis",
  draft_lead_sms: "SMS guardrails",
};
const SUITE_ORDER = ["extract_lead", "analyze_call", "draft_lead_sms"];
const FIELD_LABELS: Record<string, string> = {
  serviceCategory: "category",
  urgency: "urgency",
  contactPreference: "contact",
  intent: "intent",
  cancellationRisk: "risk",
  guardrails: "passes guardrails",
};

// jsonb doesn't keep key order: show fields in a fixed, readable order.
const fieldsInOrder = (perField: Record<string, number> | null) =>
  Object.entries(perField ?? {}).sort(
    ([a], [b]) => Object.keys(FIELD_LABELS).indexOf(a) - Object.keys(FIELD_LABELS).indexOf(b),
  );

const pct = (n: number | null) => (n === null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)}%`);
const usd = (n: number | null) => (n === null ? "—" : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);
const ms = (n: number | null) => (n === null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

type EvalRow = {
  batch_id: string;
  suite: string;
  prompt_version: string;
  model: string;
  mocked: boolean;
  total: number;
  passed: number;
  pass_rate: string;
  per_field: Record<string, number> | null;
  meets_threshold: boolean;
  threshold: string | null;
  cost_usd: string | null;
  avg_latency_ms: number | null;
  created_at: string;
};

export async function AiQuality({ days = 30 }: { days?: number }) {
  // The 10 most recent eval batches, every suite in each.
  const evals = await queryRows<EvalRow>(
    db,
    sql`with batches as (
          select batch_id, max(created_at) as at from eval_runs where suite <> 'legacy'
          group by batch_id order by at desc limit 10
        )
        select e.batch_id, e.suite, e.prompt_version, e.model, e.mocked, e.total, e.passed, e.pass_rate::text,
               e.per_field, e.meets_threshold, e.threshold::text, e.cost_usd::text, e.avg_latency_ms, b.at::text as created_at
        from eval_runs e join batches b using (batch_id)
        order by b.at desc, e.suite`,
  );
  const usage = await queryRows<{ task: string; calls: number; failed: number; cost: string | null; avg_ms: number; p95_ms: number; mocked: number }>(
    db,
    sql`select task, count(*)::int as calls, count(*) filter (where not passed)::int as failed,
               sum(cost_usd)::text as cost, avg(latency_ms)::float8 as avg_ms,
               percentile_cont(0.95) within group (order by latency_ms)::float8 as p95_ms,
               count(*) filter (where mocked)::int as mocked
        from ai_logs
        where context = 'app' and created_at >= now() - make_interval(days => ${days})
        group by task order by sum(cost_usd) desc nulls last, count(*) desc`,
  );

  const batches = [...new Map(evals.map((e) => [e.batch_id, e])).values()]; // newest first
  const latest = batches[0] ? evals.filter((e) => e.batch_id === batches[0].batch_id) : [];
  latest.sort((a, b) => SUITE_ORDER.indexOf(a.suite) - SUITE_ORDER.indexOf(b.suite));
  const totals = usage.reduce(
    (t, u) => ({ calls: t.calls + u.calls, failed: t.failed + u.failed, cost: t.cost + Number(u.cost ?? 0), mocked: t.mocked + u.mocked }),
    { calls: 0, failed: 0, cost: 0, mocked: 0 },
  );

  return (
    <section className="mt-12" aria-labelledby="ai-quality">
      <h2 id="ai-quality" className="text-2xl font-semibold">AI quality</h2>
      <p className="mt-1 text-sm text-slate-600">Golden-set evals and the cost of AI calls. Not affected by the filters above.</p>

      {latest.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">
          No eval runs yet. Run <code>npm run evals</code>.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-4 text-sm text-slate-600">
            <span>
              Latest run {latest[0].created_at.slice(0, 16)} UTC · model <code>{latest[0].model}</code>
            </span>
            {latest.some((e) => e.mocked) && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                ⚠ Mock mode: keyword rules, not a model. Scores are not meaningful.
              </span>
            )}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {latest.map((e) => (
              <div key={e.suite} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{SUITE_LABELS[e.suite] ?? e.suite}</span>
                  <span className={`text-xs font-medium ${e.meets_threshold ? "text-emerald-700" : "text-red-700"}`}>
                    {e.meets_threshold ? "✓ meets" : "✕ below"} {pct(Number(e.threshold))}
                  </span>
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">{pct(Number(e.pass_rate))}</div>
                <div className="text-xs text-slate-500">
                  {e.passed}/{e.total} cases fully right · <code>{e.prompt_version}</code>
                </div>
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                  {fieldsInOrder(e.per_field).map(([field, acc]) => (
                    <li key={field} className="flex justify-between">
                      <span>{FIELD_LABELS[field] ?? field}</span>
                      <span className="tabular-nums">{pct(acc)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 text-xs text-slate-500">
                  {usd(e.cost_usd === null ? null : Number(e.cost_usd))} · avg {ms(e.avg_latency_ms)}
                </div>
              </div>
            ))}
          </div>

          <h3 className="mt-8 text-lg font-semibold">Pass rate over the last {batches.length} runs</h3>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Run (UTC)</th>
                  <th className="px-3 py-2 font-medium">Model</th>
                  {SUITE_ORDER.map((s) => (
                    <th key={s} className="px-3 py-2 font-medium">{SUITE_LABELS[s]}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batches.map((b) => {
                  const rows = evals.filter((e) => e.batch_id === b.batch_id);
                  return (
                    <tr key={b.batch_id}>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-500">{b.created_at.slice(0, 16)}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <code>{b.model}</code>
                        {b.mocked && <span className="ml-1 text-xs text-amber-800">(mock)</span>}
                      </td>
                      {SUITE_ORDER.map((suite) => {
                        const r = rows.find((x) => x.suite === suite);
                        return (
                          <td key={suite} className="px-3 py-2">
                            {r ? <RateBar rate={Number(r.pass_rate)} ok={r.meets_threshold} version={r.prompt_version} /> : <span className="text-slate-400">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="mt-8 text-lg font-semibold">AI calls, last {days} days</h3>
      {usage.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No AI calls logged in this period.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-600">
            {totals.calls.toLocaleString("en-US")} calls · {usd(totals.cost)} total · {pct(totals.failed / totals.calls)} failed checks
            {totals.mocked > 0 && ` · ${totals.mocked.toLocaleString("en-US")} in mock mode (free)`}
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  {["Task", "Calls", "Failed checks", "Cost", "Avg latency", "p95 latency"].map((h, i) => (
                    <th key={h} className={`whitespace-nowrap px-3 py-2 font-medium ${i ? "text-right" : ""}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {usage.map((u) => (
                  <tr key={u.task}>
                    <td className="px-3 py-2"><code>{u.task}</code></td>
                    <td className="px-3 py-2 text-right">{u.calls.toLocaleString("en-US")}</td>
                    <td className="px-3 py-2 text-right">{pct(u.failed / u.calls)}</td>
                    <td className="px-3 py-2 text-right">{usd(u.cost === null ? null : Number(u.cost))}</td>
                    <td className="px-3 py-2 text-right">{ms(u.avg_ms)}</td>
                    <td className="px-3 py-2 text-right">{ms(u.p95_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// A pass rate as a number plus a thin bar; the prompt version shows on hover.
function RateBar({ rate, ok, version }: { rate: number; ok: boolean; version: string }) {
  return (
    <div className="flex items-center gap-2" title={`${pct(rate)} of cases fully right · ${version}`}>
      <span className="w-12 text-right tabular-nums">{pct(rate)}</span>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <span className={`block h-full rounded-full ${ok ? "bg-blue-600" : "bg-red-600"}`} style={{ width: `${Math.round(rate * 100)}%` }} />
      </span>
      {!ok && <span className="text-xs text-red-700">below</span>}
    </div>
  );
}
