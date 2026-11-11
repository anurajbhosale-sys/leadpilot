import { beforeEach, describe, expect, it, vi } from "vitest";
import { rawLeads } from "@/db/schema";
import { ProviderError } from "@/lib/providers/faults";
import type { WatermarkStore } from "@/lib/watermark-store";
import { extractSource, watermarkKey, withRetry, type RawRecord, type RetryOptions, type Source } from "./extract";

const HOUR = 3_600_000;
const at = (iso: string) => new Date(iso);
const record = (id: string, iso: string): RawRecord => ({ sourceId: id, cursorAt: at(iso), payload: { id } });

// A paginated fake source (2 records per page) that serves records at or after `since`.
function fakeSource(records: RawRecord[], lookbackMs = 0): Source & { calls: Date[] } {
  const calls: Date[] = [];
  return {
    name: "leads",
    system: "test",
    table: rawLeads,
    lookbackMs,
    calls,
    async fetchPage(since, cursor) {
      if (!cursor) calls.push(since);
      const matching = records.filter((r) => r.cursorAt >= since);
      const offset = Number(cursor ?? 0);
      return { items: matching.slice(offset, offset + 2), nextCursor: offset + 2 < matching.length ? String(offset + 2) : undefined };
    },
  };
}

let marks: Map<string, Date>;
const watermarks: WatermarkStore = { get: async (s) => marks.get(s) ?? null, set: async (s, v) => void marks.set(s, v) };
const noSleep: RetryOptions = { attempts: 4, baseDelayMs: 100, sleep: async () => {} };

beforeEach(() => {
  marks = new Map();
});

describe("extractSource (incremental)", () => {
  const records = [
    record("a", "2026-11-01T10:00:00Z"),
    record("b", "2026-11-02T10:00:00Z"),
    record("c", "2026-11-03T10:00:00Z"),
    record("d", "2026-11-04T10:00:00Z"),
    record("e", "2026-11-05T10:00:00Z"),
  ];

  it("reads everything, across pages, when there is no watermark yet", async () => {
    const source = fakeSource(records);
    const result = await extractSource(source, watermarks, noSleep);
    expect(source.calls).toEqual([new Date(0)]);
    expect(result.records.map((r) => r.sourceId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.pages).toBe(3);
    expect(result.newWatermark).toEqual(at("2026-11-05T10:00:00Z"));
  });

  it("reads only from the watermark minus the lookback window", async () => {
    marks.set(watermarkKey(fakeSource([])), at("2026-11-04T10:00:00Z"));
    const source = fakeSource(records, 24 * HOUR);
    const result = await extractSource(source, watermarks, noSleep);
    expect(source.calls).toEqual([at("2026-11-03T10:00:00Z")]);
    expect(result.records.map((r) => r.sourceId)).toEqual(["c", "d", "e"]);
    expect(result.newWatermark).toEqual(at("2026-11-05T10:00:00Z"));
  });

  it("does not write the watermark itself (the run does, only on success)", async () => {
    await extractSource(fakeSource(records), watermarks, noSleep);
    expect(marks.size).toBe(0);
  });

  it("never moves the watermark backwards when nothing new arrived", async () => {
    marks.set(watermarkKey(fakeSource([])), at("2026-11-09T00:00:00Z"));
    const result = await extractSource(fakeSource(records, 24 * HOUR), watermarks, noSleep);
    expect(result.records).toHaveLength(0);
    expect(result.newWatermark).toEqual(at("2026-11-09T00:00:00Z"));
  });

  it("retries a failed page and counts the retries", async () => {
    const source = fakeSource(records);
    const real = source.fetchPage.bind(source);
    let failures = 0;
    source.fetchPage = async (since, cursor) => {
      if (cursor === "2" && failures++ < 2) throw new ProviderError("503", 503);
      return real(since, cursor);
    };
    const result = await extractSource(source, watermarks, noSleep);
    expect(result.retries).toBe(2);
    expect(result.records).toHaveLength(5); // no page lost or repeated
  });
});

describe("withRetry", () => {
  it("waits at least Retry-After on a rate limit", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fn = vi.fn().mockRejectedValueOnce(new ProviderError("429", 429, 1500)).mockResolvedValueOnce("ok");
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 10, sleep })).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(1500);
  });

  it("backs off exponentially between attempts", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new ProviderError("503", 503));
    await expect(withRetry(fn, { attempts: 4, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) })).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[2]).toBeGreaterThanOrEqual(400);
  });

  it("does not retry errors that can't succeed on retry (e.g. 401)", async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderError("401", 401));
    await expect(withRetry(fn, noSleep)).rejects.toThrow("401");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
