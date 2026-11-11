// Runs the golden sets against the configured model and records the results in eval_runs.
//
// Three suites:
//   extract_lead   - lead messages -> serviceCategory, urgency, contactPreference
//   analyze_call   - transcripts -> intent, cancellationRisk
//   draft_lead_sms - a follow-up SMS for each lead case (from its expected extraction and branch
//                    offers); passes when the final draft clears guardrails without human review
import { randomUUID } from "node:crypto";
import { evalRuns, type EvalFailure } from "@/db/schema";
import type { Db } from "@/db/types";
import { llmMode } from "@/lib/ai/client";
import { draftLeadSms, type SmsDraftInput, type SmsDraftResult } from "@/lib/ai/draft";
import { analyzeCall } from "@/lib/ai/analyze-call";
import { extractLead } from "@/lib/ai/extract";
import { PROMPT_VERSIONS } from "@/lib/ai/prompts";
import { withAiLogScope, type LoggedAiCall } from "@/lib/logging";
import type { CallAnalysis, LeadExtraction } from "@/lib/schemas";
import { loadGoldenSets, type GoldenSets } from "./golden";
import { latencyStats, meetsThreshold, scoreCase, scoreSuite, totalCost, type CaseResult, type SuiteScore } from "./score";

export const SUITES = ["extract_lead", "analyze_call", "draft_lead_sms"] as const;
export type Suite = (typeof SUITES)[number];

/** The model-backed functions under test. Swappable so tests don't need a model. */
export type EvalTasks = {
  extract(message: string): Promise<LeadExtraction>;
  analyze(transcript: string): Promise<CallAnalysis>;
  draftSms(input: SmsDraftInput): Promise<SmsDraftResult>;
};

export const realTasks: EvalTasks = { extract: extractLead, analyze: analyzeCall, draftSms: draftLeadSms };

export type SuiteResult = {
  suite: Suite;
  promptVersion: string;
  model: string;
  mocked: boolean;
  score: SuiteScore;
  threshold: number;
  meetsThreshold: boolean;
  costUsd: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  calls: number; // AI calls made (an SMS draft can take two)
};

export type EvalBatch = { batchId: string; mocked: boolean; suites: SuiteResult[] };

export type RunEvalsOptions = {
  threshold: number; // minimum per-field accuracy, 0-1
  tasks?: EvalTasks;
  sets?: GoldenSets;
  suites?: readonly Suite[];
  concurrency?: number;
  onCase?: (suite: Suite, result: CaseResult) => void;
};

export async function runEvals(opts: RunEvalsOptions): Promise<EvalBatch> {
  const tasks = opts.tasks ?? realTasks;
  const sets = opts.sets ?? loadGoldenSets();
  const suites: SuiteResult[] = [];

  for (const suite of opts.suites ?? SUITES) {
    const calls: LoggedAiCall[] = [];
    const run = (fn: () => Promise<CaseResult[]>) => withAiLogScope({ context: "eval", onCall: (c) => calls.push(c) }, fn);

    let results: CaseResult[];
    if (suite === "extract_lead") {
      results = await run(() =>
        pool(sets.leads, opts.concurrency, async (c) =>
          attempt(c.id, c.expected, () => tasks.extract(c.message)),
        ),
      );
    } else if (suite === "analyze_call") {
      results = await run(() =>
        pool(sets.calls, opts.concurrency, async (c) =>
          attempt(c.id, c.expected, () => tasks.analyze(c.transcript)),
        ),
      );
    } else {
      results = await run(() =>
        pool(sets.leads, opts.concurrency, async (c) =>
          attempt(c.id, { guardrails: "passed" }, async () => {
            // Draft from the expected extraction, so drafting is measured on its own.
            const first = (v: string | readonly string[]) => (typeof v === "string" ? v : v[0]);
            const draft = await tasks.draftSms({
              firstName: c.firstName,
              message: c.message,
              extraction: {
                serviceCategory: first(c.expected.serviceCategory) as LeadExtraction["serviceCategory"],
                urgency: first(c.expected.urgency) as LeadExtraction["urgency"],
                contactPreference: first(c.expected.contactPreference) as LeadExtraction["contactPreference"],
                summary: c.message.slice(0, 200),
              },
              branchName: c.branch.name,
              approvedOffers: c.branch.approvedOffers,
            });
            return { guardrails: draft.status === "ready" ? "passed" : `needs_review: ${draft.errors.join("; ")}` };
          }),
        ),
      );
    }
    for (const r of results) opts.onCase?.(suite, r);

    const score = scoreSuite(results);
    const latency = latencyStats(calls.map((c) => c.latencyMs));
    suites.push({
      suite,
      promptVersion: PROMPT_VERSIONS[suite],
      model: [...new Set(calls.map((c) => c.model))].join(",") || (llmMode() === "mock" ? "mock" : "unknown"),
      mocked: calls.length > 0 ? calls.every((c) => c.mocked) : llmMode() === "mock",
      score,
      threshold: opts.threshold,
      meetsThreshold: meetsThreshold(score, opts.threshold),
      costUsd: totalCost(calls.map((c) => c.costUsd)),
      avgLatencyMs: latency.avg,
      p95LatencyMs: latency.p95,
      calls: calls.length,
    });
  }

  return { batchId: randomUUID(), mocked: suites.some((s) => s.mocked), suites };
}

/** One eval_runs row per suite, sharing the batch ID. */
export async function saveEvalBatch(db: Db, batch: EvalBatch): Promise<void> {
  if (batch.suites.length === 0) return;
  await db.insert(evalRuns).values(
    batch.suites.map((s) => ({
      batchId: batch.batchId,
      suite: s.suite,
      promptVersion: s.promptVersion,
      model: s.model,
      mocked: s.mocked,
      total: s.score.total,
      passed: s.score.passed,
      passRate: s.score.passRate.toFixed(4),
      perField: s.score.perField,
      threshold: s.threshold.toFixed(4),
      meetsThreshold: s.meetsThreshold,
      costUsd: s.costUsd === null ? null : s.costUsd.toFixed(6),
      avgLatencyMs: s.avgLatencyMs,
      p95LatencyMs: s.p95LatencyMs,
      failures: s.score.failures satisfies EvalFailure[],
    })),
  );
}

/** Run one case; a thrown error (model down, invalid JSON) scores as wrong on every field. */
async function attempt(caseId: string, expected: Record<string, string | readonly string[]>, fn: () => Promise<Record<string, unknown>>) {
  try {
    return scoreCase(caseId, expected, await fn());
  } catch (err) {
    return scoreCase(caseId, expected, null, err instanceof Error ? err.message : String(err));
  }
}

/** Map with at most `limit` cases in flight, keeping input order. */
async function pool<T, R>(items: T[], limit = 4, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
