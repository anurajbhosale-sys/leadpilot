// Runs the golden-set evals against the configured model and records the results in eval_runs.
//
//   npm run evals                      # all suites, default threshold 0.8
//   npm run evals -- --threshold 0.9   # or set EVAL_MIN_ACCURACY
//   npm run evals -- --suite analyze_call
//   npm run evals -- --no-save         # print only, don't write eval_runs
//
// Exit codes: 0 every suite met the threshold; 1 a suite fell below it; 2 the run itself failed.
// In mock mode (no API key, or LLM_MOCK=true) the "model" is keyword rules, so the scores say
// nothing about model quality and the threshold is not enforced (pass --strict to enforce it).
import "dotenv/config";
import { parseArgs } from "node:util";
import { llmMode } from "@/lib/ai/client";
import { runEvals, saveEvalBatch, SUITES, type Suite } from "@/evals/runner";

const { values } = parseArgs({
  options: {
    threshold: { type: "string", default: process.env.EVAL_MIN_ACCURACY ?? "0.8" },
    suite: { type: "string", multiple: true },
    "no-save": { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
  },
});

const threshold = Number(values.threshold);
if (!(threshold >= 0 && threshold <= 1)) throw new Error("--threshold must be between 0 and 1");
const suites = (values.suite ?? [...SUITES]) as Suite[];
const unknown = suites.filter((s) => !SUITES.includes(s));
if (unknown.length) throw new Error(`Unknown suite(s): ${unknown.join(", ")}. Choose from ${SUITES.join(", ")}.`);

const BAR = "!".repeat(78);
const MOCK_WARNING = [
  BAR,
  "!! MOCK MODE: no API key is set (or LLM_MOCK=true), so these 'answers' come from keyword",
  "!! rules in lib/ai/*.ts, not a language model. The scores below are NOT meaningful as a",
  "!! measure of AI quality. They only show that the eval pipeline itself works.",
  BAR,
].join("\n");

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function main(): Promise<number> {
  const mode = llmMode();
  if (mode === "mock") console.log(`${MOCK_WARNING}\n`);
  console.log(`Running ${suites.join(", ")} against ${mode} (threshold ${pct(threshold)} per field)...\n`);

  const batch = await runEvals({ threshold, suites });

  for (const s of batch.suites) {
    console.log(`${s.suite}  [${s.promptVersion}, ${s.model}]  ${s.meetsThreshold ? "PASS" : "BELOW THRESHOLD"}`);
    console.log(`  cases fully correct: ${s.score.passed}/${s.score.total} (${pct(s.score.passRate)})`);
    for (const [field, acc] of Object.entries(s.score.perField)) {
      console.log(`  ${field.padEnd(18)} ${pct(acc).padStart(6)}${acc < threshold ? "  <" : ""}`);
    }
    const cost = s.costUsd === null ? "unknown" : `$${s.costUsd.toFixed(4)}`;
    console.log(`  ${s.calls} AI calls, cost ${cost}, latency avg ${s.avgLatencyMs ?? "-"} ms / p95 ${s.p95LatencyMs ?? "-"} ms`);
    for (const f of s.score.failures) console.log(`    x ${f.caseId} ${f.field}: expected ${f.expected}, got ${f.actual}`);
    console.log();
  }

  if (!values["no-save"]) {
    if (!process.env.DATABASE_URL) {
      console.log("DATABASE_URL is not set: results were not saved (use --no-save to silence this).");
    } else {
      const { db, sql } = await import("@/db");
      try {
        await saveEvalBatch(db, batch);
        console.log(`Saved to eval_runs (batch ${batch.batchId}).`);
      } finally {
        await sql.end();
      }
    }
  }

  const failed = batch.suites.filter((s) => !s.meetsThreshold);
  if (batch.mocked) {
    console.log(`\n${MOCK_WARNING}`);
    if (!values.strict) {
      console.log(`Threshold not enforced in mock mode${failed.length ? ` (${failed.length} suite(s) below it)` : ""}.`);
      return 0;
    }
  }
  if (failed.length) {
    console.log(`\nFAILED: ${failed.map((s) => s.suite).join(", ")} below ${pct(threshold)} on at least one field.`);
    return 1;
  }
  console.log("\nAll suites met the threshold.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("Eval run failed:", err);
    process.exit(2);
  },
);
