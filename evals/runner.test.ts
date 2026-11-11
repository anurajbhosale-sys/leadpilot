import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evalRuns } from "@/db/schema";
import type { Db } from "@/db/types";
import { PROMPT_VERSIONS } from "@/lib/ai/prompts";
import { logAiCall } from "@/lib/logging";
import { createTestDb } from "@/pipeline/test-db";
import type { GoldenSets } from "./golden";
import { runEvals, saveEvalBatch, type EvalTasks } from "./runner";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const sets: GoldenSets = {
  leads: [
    {
      id: "lead-a",
      note: "",
      message: "leaking sink",
      firstName: "Ann",
      branch: { name: "Austin North", approvedOffers: [] },
      expected: { serviceCategory: "plumbing", urgency: "medium", contactPreference: "no_preference" },
    },
    {
      id: "lead-b",
      note: "",
      message: "ants, any discount?",
      firstName: "Bo",
      branch: { name: "Denver Metro", approvedOffers: [] },
      expected: { serviceCategory: "pest_control", urgency: ["low", "medium"], contactPreference: "sms" },
    },
  ],
  calls: [
    { id: "call-a", note: "", transcript: "Customer: cancel", expected: { intent: "cancellation", cancellationRisk: "high" } },
    { id: "call-b", note: "", transcript: "Customer: move it", expected: { intent: "reschedule", cancellationRisk: "low" } },
  ],
};

// A fake "model" that logs each call like the real client does (so cost and latency are measured),
// gets one lead field wrong, fails one call outright, and fails guardrails on the discount request.
const call = async (task: string, latencyMs: number) =>
  logAiCall({ task, model: "claude-haiku-4-5", mocked: false, inputTokens: 1000, outputTokens: 100, latencyMs, passed: true });
const tasks: EvalTasks = {
  async extract(message) {
    await call("extract_lead", 200);
    return message.includes("sink")
      ? { serviceCategory: "plumbing", urgency: "medium", contactPreference: "no_preference", summary: "s" }
      : { serviceCategory: "pest_control", urgency: "low", contactPreference: "phone", summary: "s" }; // contact wrong
  },
  async analyze(transcript) {
    await call("analyze_call", 400);
    if (transcript.includes("move")) throw new Error("model timed out");
    return { intent: "cancellation", cancellationRisk: "high", summary: "s" };
  },
  async draftSms(input) {
    await call("draft_lead_sms", 100);
    return input.message.includes("discount")
      ? { status: "needs_review", sms: "20% off!", attempts: 2, errors: ["Mentions a price"] }
      : { status: "ready", sms: "Hi. Reply STOP to opt out", attempts: 1 };
  },
};

describe("runEvals", () => {
  // logAiCall can't reach a database in tests; it says so on stderr and carries on.
  vi.spyOn(console, "error").mockImplementation(() => {});

  it("scores every suite and measures cost and latency from the calls it made", async () => {
    const batch = await runEvals({ threshold: 0.8, tasks, sets });
    const [extract, calls, sms] = batch.suites;

    expect(extract).toMatchObject({
      suite: "extract_lead",
      promptVersion: PROMPT_VERSIONS.extract_lead,
      model: "claude-haiku-4-5",
      mocked: false,
      calls: 2,
      avgLatencyMs: 200,
      meetsThreshold: false, // contactPreference 50%
    });
    expect(extract.score.perField).toEqual({ serviceCategory: 1, urgency: 1, contactPreference: 0.5 });
    // 2 calls x (1000 in x $1/M + 100 out x $5/M) = $0.003
    expect(extract.costUsd).toBeCloseTo(0.003, 6);

    expect(calls.score).toMatchObject({ total: 2, passed: 1, perField: { intent: 0.5, cancellationRisk: 0.5 } });
    expect(calls.score.failures).toContainEqual({ caseId: "call-b", field: "intent", expected: "reschedule", actual: "error: model timed out" });
    expect(calls.p95LatencyMs).toBe(400);

    expect(sms.score.perField).toEqual({ guardrails: 0.5 });
    expect(sms.score.failures[0]).toMatchObject({ caseId: "lead-b", field: "guardrails", expected: "passed" });
  });

  it("passes when every field reaches the threshold", async () => {
    const batch = await runEvals({ threshold: 0.5, tasks, sets });
    expect(batch.suites.every((s) => s.meetsThreshold)).toBe(true);
  });

  it("runs only the suites asked for", async () => {
    const batch = await runEvals({ threshold: 0.8, tasks, sets, suites: ["analyze_call"] });
    expect(batch.suites.map((s) => s.suite)).toEqual(["analyze_call"]);
  });

  it("flags mock-mode results (the real tasks, with no API key)", async () => {
    vi.stubEnv("LLM_MOCK", "true");
    try {
      const batch = await runEvals({ threshold: 0.8, sets, suites: ["extract_lead"] });
      expect(batch.mocked).toBe(true);
      expect(batch.suites[0]).toMatchObject({ model: "mock", mocked: true, costUsd: 0, calls: 2 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("saveEvalBatch", () => {
  it("records one eval_runs row per suite, sharing the batch ID", async () => {
    const batch = await runEvals({ threshold: 0.8, tasks, sets });
    await saveEvalBatch(db, batch);

    const rows = await db.select().from(evalRuns);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.batchId))).toEqual(new Set([batch.batchId]));

    const extract = rows.find((r) => r.suite === "extract_lead")!;
    expect(extract).toMatchObject({
      promptVersion: "extract_lead@1",
      model: "claude-haiku-4-5",
      mocked: false,
      total: 2,
      passed: 1,
      passRate: "0.5000",
      perField: { serviceCategory: 1, urgency: 1, contactPreference: 0.5 },
      threshold: "0.8000",
      meetsThreshold: false,
      costUsd: "0.003000",
      avgLatencyMs: 200,
      p95LatencyMs: 200,
    });
    expect(extract.failures).toEqual([{ caseId: "lead-b", field: "contactPreference", expected: "sms", actual: "phone" }]);
    expect(rows.find((r) => r.suite === "draft_lead_sms")).toMatchObject({ promptVersion: PROMPT_VERSIONS.draft_lead_sms, passRate: "0.5000" });
  });
});
