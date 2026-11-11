// Incremental extraction: each source is read from (its watermark - a lookback window) onward,
// page by page, with retries. The watermark itself only moves after the whole run succeeds
// (pipeline/run.ts), so a failed run is simply re-read next time; loads are upserts, so that's safe.
import type { RawTable } from "@/db/schema";
import { ProviderError } from "@/lib/providers/faults";
import type { WatermarkStore } from "@/lib/watermark-store";

/** One record as it lands in a raw_* table. */
export type RawRecord = {
  sourceId: string; // the record's ID in the source: the upsert key
  cursorAt: Date; // the field the watermark tracks (updated_at, created_at, or spend date)
  payload: Record<string, unknown>; // the record exactly as the source returned it
};

export type Source = {
  name: string; // e.g. "leads"; the watermark key is `pipeline_<name>`
  system: string; // stored in raw.source, e.g. "app_db", "mock_crm", "mock_adspend"
  table: RawTable;
  // Re-read this far behind the watermark, for late-arriving rows and restated ad spend.
  lookbackMs: number;
  fetchPage(since: Date, cursor?: string): Promise<{ items: RawRecord[]; nextCursor?: string }>;
};

export type RetryOptions = {
  attempts: number; // total tries per request, including the first
  baseDelayMs: number; // doubled after every failure, plus jitter
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_RETRY: RetryOptions = { attempts: 4, baseDelayMs: 250 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry rate limits (honoring Retry-After), server errors, and unexpected errors such as dropped
 * connections. Errors the source marks as not retryable (bad auth, bad request) fail immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions, onRetry?: (err: unknown) => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = !(err instanceof ProviderError) || err.retryable;
      if (!retryable || attempt >= opts.attempts) throw err;
      onRetry?.(err);
      const backoff = opts.baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.2);
      const retryAfter = err instanceof ProviderError ? (err.retryAfterMs ?? 0) : 0;
      await (opts.sleep ?? sleep)(Math.max(backoff, retryAfter));
    }
  }
}

export const watermarkKey = (source: Source) => `pipeline_${source.name}`;

export type Extracted = {
  source: Source;
  since: Date; // what we asked the source for
  records: RawRecord[];
  pages: number;
  retries: number;
  newWatermark: Date | null; // newest cursorAt seen, never behind the current watermark
};

/** Read every page of one source since its watermark (minus the lookback). Nothing is written. */
export async function extractSource(source: Source, watermarks: WatermarkStore, retry: RetryOptions = DEFAULT_RETRY): Promise<Extracted> {
  const current = await watermarks.get(watermarkKey(source));
  const since = current ? new Date(current.getTime() - source.lookbackMs) : new Date(0);

  const out: Extracted = { source, since, records: [], pages: 0, retries: 0, newWatermark: current };
  let cursor: string | undefined;
  do {
    const page = await withRetry(() => source.fetchPage(since, cursor), retry, () => out.retries++);
    out.records.push(...page.items);
    out.pages++;
    cursor = page.nextCursor;
  } while (cursor);

  for (const r of out.records) {
    if (!out.newWatermark || r.cursorAt > out.newWatermark) out.newWatermark = r.cursorAt;
  }
  return out;
}
