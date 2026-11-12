import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./pricing";

describe("estimateCostUsd", () => {
  it("prices claude-haiku-5-5 at $0.10 in / $0.50 out per 1M tokens", () => {
    // 1000 x $0.10/M + 200 x $0.50/M = $0.0002
    expect(estimateCostUsd("claude-haiku-5-5", 1000, 200)).toBeCloseTo(0.0002, 10);
  });

  it("charges the long-prompt rate on the whole request once the prompt is over 100,000 tokens", () => {
    expect(estimateCostUsd("claude-haiku-5-5", 100_000, 0)).toBeCloseTo(0.01, 10); // at the limit: still $0.10/M
    // 100,001 x $0.50/M + 1000 x $2.50/M
    expect(estimateCostUsd("claude-haiku-5-5", 100_001, 1000)).toBeCloseTo(0.0500005 + 0.0025, 10);
  });

  it("is free in mock mode and unknown (null) for unpriced models or missing token counts", () => {
    expect(estimateCostUsd("mock", 1000, 1000)).toBe(0);
    expect(estimateCostUsd("some-new-model", 1000, 1000)).toBeNull();
    expect(estimateCostUsd("claude-haiku-5-5", undefined, 10)).toBeNull();
  });
});
