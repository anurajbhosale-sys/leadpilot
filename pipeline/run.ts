// The nightly pipeline (SPEC A4): extract -> load raw -> transform -> quality checks -> record the run.
//
// Every step is safe to rerun: raw loads are upserts on source IDs, staging and marts are rebuilt
// from raw, and watermarks only advance when the whole run succeeded (checks included), so a
// failed run is simply re-read by the next one.
import { and, eq, lt } from "drizzle-orm";
import { pipelineRuns, type CheckResult } from "@/db/schema";
import type { Db } from "@/db/types";
import type { CrmExportProvider } from "@/lib/providers/crm-export";
import { watermarkStore, type WatermarkStore } from "@/lib/watermark-store";
import { runChecks, type Check } from "./checks";
import { DEFAULT_RETRY, extractSource, watermarkKey, type Extracted, type RetryOptions, type Source } from "./extract";
import { loadRaw } from "./load";
import { runTransforms } from "./transforms";

export type PipelineDeps = {
  db: Db;
  sources: Source[];
  crm: CrmExportProvider; // for reconciliation
  watermarks?: WatermarkStore; // defaults to the watermarks table in `db`
  checks?: Check[];
  retry?: RetryOptions;
  now?: () => Date;
  log?: (message: string) => void;
};

export type PipelineSummary = {
  runId: number;
  status: "succeeded" | "failed";
  durationMs: number;
  rowCounts: Record<string, number>;
  checks: CheckResult[];
  error?: string;
};

export class PipelineBusyError extends Error {}

// A run still "running" after this long crashed without recording it; don't let it block forever.
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

export async function runPipeline(deps: PipelineDeps): Promise<PipelineSummary> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const watermarks = deps.watermarks ?? watermarkStore(db);
  const startedAt = now();

  const runId = await startRun(db, startedAt);
  const rowCounts: Record<string, number> = {};
  let checks: CheckResult[] = [];
  try {
    // 1. Extract + load raw, one source at a time. Each load commits on its own.
    const extracted: Extracted[] = [];
    let retries = 0;
    for (const source of deps.sources) {
      const result = await extractSource(source, watermarks, deps.retry ?? DEFAULT_RETRY);
      const loaded = await loadRaw(db, source.table, source.system, result.records, runId, now());
      extracted.push(result);
      retries += result.retries;
      rowCounts[`extracted_${source.name}`] = loaded;
      log(`${source.name}: ${loaded} rows since ${result.since.toISOString()} (${result.pages} pages, ${result.retries} retries)`);
    }
    rowCounts.retries = retries;

    // 2. Transform raw -> staging -> marts (one transaction).
    Object.assign(rowCounts, await runTransforms(db, now()));
    log("transforms done");

    // 3. Quality checks.
    checks = await runChecks({ db, asOf: now(), crm: deps.crm, retry: deps.retry }, deps.checks);
    const failed = checks.filter((c) => !c.passed);
    for (const c of failed) log(`CHECK FAILED ${c.name}: ${c.detail ?? ""}`);

    // 4. Only a fully successful run moves the watermarks forward.
    if (failed.length === 0) {
      for (const e of extracted) if (e.newWatermark) await watermarks.set(watermarkKey(e.source), e.newWatermark);
    }
    const error = failed.length ? `${failed.length} quality check(s) failed: ${failed.map((c) => c.name).join(", ")}` : undefined;
    return await finishRun(db, runId, startedAt, now(), failed.length ? "failed" : "succeeded", rowCounts, checks, error);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`run failed: ${message}`);
    return await finishRun(db, runId, startedAt, now(), "failed", rowCounts, checks, message);
  }
}

/** Record a new run. Fails with PipelineBusyError if another run is in progress. */
async function startRun(db: Db, startedAt: Date): Promise<number> {
  await db
    .update(pipelineRuns)
    .set({ status: "failed", finishedAt: startedAt, error: "abandoned: never finished" })
    .where(and(eq(pipelineRuns.status, "running"), lt(pipelineRuns.startedAt, new Date(startedAt.getTime() - ABANDONED_AFTER_MS))));
  try {
    const [run] = await db.insert(pipelineRuns).values({ status: "running", startedAt }).returning({ id: pipelineRuns.id });
    return run.id;
  } catch (err) {
    // The unique index on running runs rejected us: someone else is mid-run.
    const [running] = await db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(eq(pipelineRuns.status, "running"));
    if (running) throw new PipelineBusyError(`Pipeline run #${running.id} is already in progress`);
    throw err;
  }
}

async function finishRun(
  db: Db,
  runId: number,
  startedAt: Date,
  finishedAt: Date,
  status: PipelineSummary["status"],
  rowCounts: Record<string, number>,
  checks: CheckResult[],
  error?: string,
): Promise<PipelineSummary> {
  await db
    .update(pipelineRuns)
    .set({ status, finishedAt, rowCounts, checkResults: checks, error: error ?? null })
    .where(eq(pipelineRuns.id, runId));
  return { runId, status, durationMs: finishedAt.getTime() - startedAt.getTime(), rowCounts, checks, error };
}

