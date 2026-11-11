// Runs the nightly pipeline once, directly (no HTTP), against the database in DATABASE_URL.
//
//   npm run pipeline:run
//
// Exits with code 1 if the run failed (an error, or any quality check), so cron/CI notice.
import "dotenv/config";
import { sql } from "@/db";
import { runPipelineJob } from "@/pipeline/deps";

try {
  const summary = await runPipelineJob((m) => console.log(`[pipeline] ${m}`));
  console.log(`\nRun #${summary.runId} ${summary.status.toUpperCase()} in ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log("Row counts:", summary.rowCounts);
  for (const c of summary.checks) console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  if (summary.error) console.log(`\n${summary.error}`);
  process.exitCode = summary.status === "succeeded" ? 0 : 1;
} finally {
  await sql.end();
}
