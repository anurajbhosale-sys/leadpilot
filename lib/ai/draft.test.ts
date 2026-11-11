import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftLeadSms, type SmsDraftInput } from "./draft";

vi.mock("@/lib/logging", () => ({ logAiCall: vi.fn() }));

const base: SmsDraftInput = {
  firstName: "Ann",
  message: "Water leaking under the kitchen sink",
  extraction: { serviceCategory: "plumbing", urgency: "medium", contactPreference: "no_preference", summary: "Leak" },
  branchName: "Denver Metro",
  approvedOffers: [],
};

describe("draftLeadSms (mock LLM)", () => {
  beforeEach(() => vi.stubEnv("LLM_MOCK", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("returns a compliant draft on the first try", async () => {
    expect(await draftLeadSms(base)).toMatchObject({ status: "ready", attempts: 1 });
  });

  it("retries once with the errors when the first draft fails", async () => {
    const result = await draftLeadSms({ ...base, message: "How much does a leak repair cost?" });
    expect(result).toMatchObject({ status: "ready", attempts: 2 });
    expect(result.sms).not.toContain("$");
  });

  it("routes to review when the retry also fails", async () => {
    const result = await draftLeadSms({ ...base, message: "Any discount for a leaking sink?" });
    expect(result.status).toBe("needs_review");
  });

  it("uses an approved offer when the branch has one", async () => {
    const result = await draftLeadSms({
      ...base,
      message: "Any discount for a leaking sink?",
      approvedOffers: ["$50 off your first service"],
    });
    expect(result).toMatchObject({ status: "ready", attempts: 1 });
    expect(result.sms).toContain("$50 off your first service");
  });
});
