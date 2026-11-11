import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWinbackSms, type WinbackDraftInput } from "./ai/draft";
import { checkSms } from "./guardrails";
import { MockCrm, SEED_CUSTOMERS, SEED_SUBSCRIPTIONS } from "./providers/crm";
import type { WatermarkStore } from "./watermarks";
import { runWinback, WINBACK_SOURCE, type WinbackDeps, type WinbackQueueItem } from "./winback";

// In-memory stand-ins for Postgres and the LLM.
let marks: Map<string, Date>;
let queued: WinbackQueueItem[];
let deps: WinbackDeps;
let crm: MockCrm;

const branches: Record<number, { name: string; approvedOffers: string[] }> = {
  1: { name: "Austin North", approvedOffers: ["$50 off your first service"] },
  2: { name: "Denver Metro", approvedOffers: [] },
  3: { name: "Tampa Bay", approvedOffers: ["Your first inspection is free"] },
};

// Deterministic fake drafting that still runs the real guardrails.
const fakeDraft = async (input: WinbackDraftInput) => {
  const sms = mockWinbackSms(input);
  const { errors } = checkSms(sms, { approvedOffers: input.approvedOffers });
  return errors.length ? { status: "needs_review" as const, sms, attempts: 2, errors } : { status: "ready" as const, sms, attempts: 1 };
};

beforeEach(() => {
  crm = new MockCrm(SEED_CUSTOMERS, SEED_SUBSCRIPTIONS);
  marks = new Map();
  queued = [];
  const watermarks: WatermarkStore = {
    get: async (s) => marks.get(s) ?? null,
    set: async (s, v) => void marks.set(s, v),
  };
  deps = {
    crm,
    watermarks,
    branches: { get: async (id) => branches[id] ?? null },
    queue: {
      has: async (key) => queued.some((q) => q.sourceKey === key),
      add: async (item) => {
        if (!queued.some((q) => q.sourceKey === item.sourceKey)) queued.push(item);
      },
    },
    draft: vi.fn(fakeDraft),
  };
});

const LATEST_SEEDED = new Date("2026-11-08T17:00:00Z");

describe("runWinback", () => {
  it("reads every page and advances the watermark to the newest cancellation", async () => {
    const summary = await runWinback(deps);
    expect(summary.cancellations).toBe(6);
    expect(marks.get(WINBACK_SOURCE)).toEqual(LATEST_SEEDED);
  });

  it("skips customers without SMS consent", async () => {
    const summary = await runWinback(deps);
    expect(summary.skippedNoConsent).toBe(2); // Lisa Brown and Ben Ortiz
    expect(queued.map((q) => q.customerId)).not.toContain("cus_00005");
    expect(queued.map((q) => q.customerId)).not.toContain("cus_00008");
    expect(deps.draft).toHaveBeenCalledTimes(4);
  });

  it("sends every draft to the approval queue, flagging guardrail failures", async () => {
    const summary = await runWinback(deps);
    expect(queued).toHaveLength(4);
    expect(summary).toMatchObject({ queued: 4, flagged: 1 });
    // Grace Kim (Denver, no approved offers, left over price): the mock invents "15% off"
    const grace = queued.find((q) => q.customerId === "cus_00007")!;
    expect(grace.guardrailErrors[0]).toMatch(/price, discount, or guarantee/);
  });

  it("does not advance the watermark when the batch fails, and a rerun finishes it", async () => {
    vi.mocked(deps.draft).mockImplementationOnce(fakeDraft).mockRejectedValueOnce(new Error("LLM down"));
    await expect(runWinback(deps)).rejects.toThrow("LLM down");
    expect(marks.has(WINBACK_SOURCE)).toBe(false);
    expect(queued).toHaveLength(1); // the draft before the failure

    const summary = await runWinback(deps);
    expect(summary).toMatchObject({ alreadyQueued: 1, queued: 3 });
    expect(queued).toHaveLength(4); // no duplicates
    expect(marks.get(WINBACK_SOURCE)).toEqual(LATEST_SEEDED);
  });

  it("does not advance the watermark when a CRM page fails", async () => {
    const real = crm.listCancellations.bind(crm);
    vi.spyOn(crm, "listCancellations").mockImplementation(async (since, cursor) => {
      if (cursor) throw new Error("CRM 503");
      return real(since, cursor);
    });
    await expect(runWinback(deps)).rejects.toThrow("CRM 503");
    expect(marks.has(WINBACK_SOURCE)).toBe(false);
    expect(queued).toHaveLength(0); // nothing drafted until all pages are read
  });

  it("only picks up cancellations newer than the watermark on the next run", async () => {
    await runWinback(deps);
    expect((await runWinback(deps)).cancellations).toBe(0);

    crm.addCancellation({ name: "Nina Shah", phone: "813-555-0144", branchId: 3, smsConsent: true }, "Monthly pest control");
    const summary = await runWinback(deps);
    expect(summary).toMatchObject({ cancellations: 1, queued: 1 });
    expect(marks.get(WINBACK_SOURCE)!.getTime()).toBeGreaterThan(LATEST_SEEDED.getTime());
  });

  it("leaves the watermark alone when there is nothing new", async () => {
    marks.set(WINBACK_SOURCE, new Date("2030-01-01T00:00:00Z"));
    const summary = await runWinback(deps);
    expect(summary.cancellations).toBe(0);
    expect(marks.get(WINBACK_SOURCE)).toEqual(new Date("2030-01-01T00:00:00Z"));
  });
});

describe("runWinback with an unknown branch", () => {
  it("queues the draft without a branch instead of failing", async () => {
    deps.branches.get = async () => null;
    const summary = await runWinback(deps);
    expect(summary.queued).toBe(4);
    expect(queued.every((q) => q.branchId === null)).toBe(true);
  });
});
