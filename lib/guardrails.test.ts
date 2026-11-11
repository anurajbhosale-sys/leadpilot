import { describe, expect, it } from "vitest";
import { checkSms } from "./guardrails";

const ok = "Hi Ann, thanks for contacting Austin North! A plumbing specialist will reach out shortly. Reply STOP to opt out";
const noOffers = { approvedOffers: [] };

describe("checkSms", () => {
  it("passes a compliant message", () => {
    expect(checkSms(ok, noOffers)).toEqual({ passed: true, errors: [] });
  });

  it.each([
    "Visits start at $89.",
    "Get 20% off today.",
    "Use coupon SAVE10.",
    "We offer a free estimate.",
    "All work is guaranteed.",
  ])("blocks unapproved price/offer wording: %s", (extra) => {
    const result = checkSms(ok.replace("Reply STOP", `${extra} Reply STOP`), noOffers);
    expect(result.passed).toBe(false);
    expect(result.errors[0]).toMatch(/price, discount, or guarantee/);
  });

  it("allows an approved offer quoted verbatim", () => {
    const text = ok.replace("Reply STOP", "$50 off your first service! Reply STOP");
    expect(checkSms(text, { approvedOffers: ["$50 off your first service"] }).passed).toBe(true);
  });

  it("still blocks a reworded version of an approved offer", () => {
    const text = ok.replace("Reply STOP", "$60 off your first service! Reply STOP");
    expect(checkSms(text, { approvedOffers: ["$50 off your first service"] }).passed).toBe(false);
  });

  it.each(["Our treatment is safe for pets.", "Totally non-toxic.", "You may be legally required to fix this."])(
    "blocks health/safety/legal claims: %s",
    (extra) => {
      const result = checkSms(ok.replace("Reply STOP", `${extra} Reply STOP`), noOffers);
      expect(result.errors.some((e) => e.includes("health, safety, or legal"))).toBe(true);
    },
  );

  it("requires the opt-out text", () => {
    const result = checkSms(ok.replace(" Reply STOP to opt out", ""), noOffers);
    expect(result.errors).toContain('Must include "Reply STOP to opt out"');
  });

  it("enforces the 320 character limit", () => {
    const long = `${"x".repeat(300)} Reply STOP to opt out`;
    expect(checkSms(long, noOffers).errors.some((e) => e.startsWith("Too long"))).toBe(true);
  });

  it("blocks phone numbers and emails", () => {
    expect(checkSms(ok.replace("Reply", "Call 512-555-0100. Reply"), noOffers).passed).toBe(false);
    expect(checkSms(ok.replace("Reply", "Email bob@example.com. Reply"), noOffers).passed).toBe(false);
  });
});
