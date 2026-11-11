// Scoring for eval runs. Pure functions: no model, no database.
import type { EvalFailure } from "@/db/schema";

export type Expected = Record<string, string | readonly string[]>;
export type FieldResult = { field: string; accepted: string[]; actual: string; correct: boolean };
export type CaseResult = { caseId: string; fields: FieldResult[]; error?: string };

export type SuiteScore = {
  total: number; // cases
  passed: number; // cases with every field correct
  passRate: number;
  perField: Record<string, number>; // share of cases with that field correct
  failures: EvalFailure[];
};

const normalize = (v: unknown) => String(v ?? "").trim().toLowerCase();

/**
 * Compare a model's answer with the expected labels, field by field. A field is correct when the
 * answer matches the label, or any label in a list (ignoring case and surrounding spaces).
 * `actual` is null when the model call failed: every field then counts as wrong.
 */
export function scoreCase(caseId: string, expected: Expected, actual: Record<string, unknown> | null, error?: string): CaseResult {
  const fields = Object.entries(expected).map(([field, want]) => {
    const accepted = (typeof want === "string" ? [want] : [...want]).map(normalize);
    const got = actual ? normalize(actual[field]) : `error: ${error ?? "no answer"}`;
    return { field, accepted, actual: got, correct: actual !== null && accepted.includes(got) };
  });
  return { caseId, fields, ...(error ? { error } : {}) };
}

export function scoreSuite(results: CaseResult[]): SuiteScore {
  const total = results.length;
  const passed = results.filter((r) => r.fields.every((f) => f.correct)).length;
  const fieldNames = [...new Set(results.flatMap((r) => r.fields.map((f) => f.field)))];
  const perField = Object.fromEntries(
    fieldNames.map((name) => {
      const scored = results.flatMap((r) => r.fields.filter((f) => f.field === name));
      return [name, round4(scored.filter((f) => f.correct).length / Math.max(1, scored.length))];
    }),
  );
  const failures = results.flatMap((r) =>
    r.fields.filter((f) => !f.correct).map((f) => ({ caseId: r.caseId, field: f.field, expected: f.accepted.join(" | "), actual: f.actual })),
  );
  return { total, passed, passRate: round4(total ? passed / total : 0), perField, failures };
}

/** A suite meets the bar when every scored field is at least `threshold` accurate. */
export function meetsThreshold(score: SuiteScore, threshold: number): boolean {
  return score.total > 0 && Object.values(score.perField).every((accuracy) => accuracy >= threshold);
}

/** Average and 95th percentile (nearest rank) of a list of latencies, in whole milliseconds. */
export function latencyStats(ms: number[]): { avg: number | null; p95: number | null } {
  if (ms.length === 0) return { avg: null, p95: null };
  const sorted = [...ms].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  return { avg: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length), p95: Math.round(p95) };
}

/** Total cost of the calls whose cost is known; null when none is (e.g. a model without a price). */
export function totalCost(costs: (number | null)[]): number | null {
  const known = costs.filter((c): c is number => c !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
