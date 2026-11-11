import { describe, expect, it } from "vitest";
import { mockAnalyzeCall } from "./analyze-call";

describe("mockAnalyzeCall", () => {
  it.each([
    ["Customer: Please cancel my service.", "cancellation", "high"],
    ["Customer: The leak came back and I'm disappointed.", "complaint", "medium"],
    ["Customer: Can we reschedule to Monday?", "reschedule", "low"],
    ["Customer: I'd like a quote for a new AC.", "new_quote", "low"],
    ["Customer: What are your Saturday hours?", "other", "low"],
  ])("%s", (transcript, intent, risk) => {
    expect(mockAnalyzeCall(transcript)).toMatchObject({ intent, cancellationRisk: risk });
  });

  it("ignores the agent's words when deciding intent", () => {
    const t = "Agent: I'm sorry you want to cancel? No wait.\nCustomer: I just need a quote.";
    expect(mockAnalyzeCall(t).intent).toBe("new_quote");
  });
});
