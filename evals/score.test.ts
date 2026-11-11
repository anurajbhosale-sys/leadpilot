import { describe, expect, it } from "vitest";
import { loadGoldenSets } from "./golden";
import { latencyStats, meetsThreshold, scoreCase, scoreSuite, totalCost } from "./score";

describe("scoreCase", () => {
  it("marks each field right or wrong, ignoring case and spaces", () => {
    const r = scoreCase("c1", { intent: "complaint", cancellationRisk: "medium" }, { intent: " Complaint ", cancellationRisk: "high" });
    expect(r.fields).toEqual([
      { field: "intent", accepted: ["complaint"], actual: "complaint", correct: true },
      { field: "cancellationRisk", accepted: ["medium"], actual: "high", correct: false },
    ]);
  });

  it("accepts any label from a list (ambiguous cases)", () => {
    const r = scoreCase("c1", { urgency: ["medium", "high"] }, { urgency: "high" });
    expect(r.fields[0].correct).toBe(true);
  });

  it("scores every field wrong when the model call failed", () => {
    const r = scoreCase("c1", { intent: "other", cancellationRisk: "low" }, null, "timeout");
    expect(r.error).toBe("timeout");
    expect(r.fields.map((f) => [f.correct, f.actual])).toEqual([
      [false, "error: timeout"],
      [false, "error: timeout"],
    ]);
  });

  it("treats a missing field as wrong", () => {
    expect(scoreCase("c1", { intent: "other" }, {}).fields[0]).toMatchObject({ correct: false, actual: "" });
  });
});

describe("scoreSuite", () => {
  const results = [
    scoreCase("a", { intent: "new_quote", cancellationRisk: "low" }, { intent: "new_quote", cancellationRisk: "low" }),
    scoreCase("b", { intent: "complaint", cancellationRisk: "medium" }, { intent: "complaint", cancellationRisk: "high" }),
    scoreCase("c", { intent: "cancellation", cancellationRisk: "high" }, { intent: "other", cancellationRisk: "low" }),
    scoreCase("d", { intent: "reschedule", cancellationRisk: "low" }, { intent: "reschedule", cancellationRisk: "low" }),
  ];
  const score = scoreSuite(results);

  it("computes accuracy per field", () => {
    expect(score.perField).toEqual({ intent: 0.75, cancellationRisk: 0.5 });
  });

  it("counts a case as passed only when every field is right", () => {
    expect(score).toMatchObject({ total: 4, passed: 2, passRate: 0.5 });
  });

  it("lists every wrong field with what was expected", () => {
    expect(score.failures).toEqual([
      { caseId: "b", field: "cancellationRisk", expected: "medium", actual: "high" },
      { caseId: "c", field: "intent", expected: "cancellation", actual: "other" },
      { caseId: "c", field: "cancellationRisk", expected: "high", actual: "low" },
    ]);
  });

  it("rounds rates to 4 decimals", () => {
    const thirds = scoreSuite([
      scoreCase("a", { x: "1" }, { x: "1" }),
      scoreCase("b", { x: "1" }, { x: "2" }),
      scoreCase("c", { x: "1" }, { x: "2" }),
    ]);
    expect(thirds.perField.x).toBe(0.3333);
  });
});

describe("meetsThreshold", () => {
  const score = scoreSuite([
    scoreCase("a", { intent: "x", risk: "y" }, { intent: "x", risk: "y" }),
    scoreCase("b", { intent: "x", risk: "y" }, { intent: "x", risk: "n" }),
  ]); // intent 100%, risk 50%

  it("requires every field to reach the threshold", () => {
    expect(meetsThreshold(score, 0.5)).toBe(true);
    expect(meetsThreshold(score, 0.8)).toBe(false);
  });

  it("never passes an empty suite", () => {
    expect(meetsThreshold(scoreSuite([]), 0)).toBe(false);
  });
});

describe("latencyStats and totalCost", () => {
  it("returns the average and nearest-rank 95th percentile", () => {
    const ms = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    expect(latencyStats(ms)).toEqual({ avg: 1050, p95: 1900 });
    expect(latencyStats([])).toEqual({ avg: null, p95: null });
  });

  it("sums known costs and is null when none is known", () => {
    expect(totalCost([0.001, null, 0.002])).toBeCloseTo(0.003);
    expect(totalCost([null, null])).toBeNull();
  });
});

describe("golden sets", () => {
  it("have 20 valid cases each, with labels the schemas allow", () => {
    const sets = loadGoldenSets(); // throws on an unknown label or duplicate ID
    expect(sets.leads).toHaveLength(20);
    expect(sets.calls).toHaveLength(20);
  });

  it("include the tricky categories the evals are meant to catch", () => {
    const notes = Object.values(loadGoldenSets()).flat().map((c) => `${c.id} ${c.note}`.toLowerCase());
    for (const kind of ["vague", "mixed", "discount", "angry"]) {
      expect(notes.some((n) => n.includes(kind)), kind).toBe(true);
    }
  });
});
