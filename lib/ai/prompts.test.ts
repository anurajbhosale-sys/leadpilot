import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ANALYZE_CALL_SYSTEM,
  EXTRACT_LEAD_SYSTEM,
  leadSmsSystem,
  PROMPT_VERSIONS,
  winbackSmsSystem,
} from "./prompts";

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

// The prompt text each version stands for. If this test fails you changed a prompt:
// bump that task's version in prompts.ts, then update the version and fingerprint here.
const PROMPTS: Record<keyof typeof PROMPT_VERSIONS, string> = {
  extract_lead: EXTRACT_LEAD_SYSTEM,
  draft_lead_sms: leadSmsSystem("Branch", ["Offer A"]) + leadSmsSystem("Branch", []),
  analyze_call: ANALYZE_CALL_SYSTEM,
  draft_winback_sms: winbackSmsSystem("Branch", ["Offer A"]) + winbackSmsSystem("Branch", []),
};

describe("prompt versions", () => {
  it("change whenever a prompt's text changes", () => {
    const current = Object.fromEntries(
      Object.entries(PROMPTS).map(([task, text]) => [task, `${PROMPT_VERSIONS[task as keyof typeof PROMPT_VERSIONS]} ${fingerprint(text)}`]),
    );
    expect(current).toEqual(RECORDED);
  });
});

const RECORDED = {
  extract_lead: "extract_lead@1 fa7c4886bbe2",
  draft_lead_sms: "lead_sms@1 48fa14385307",
  analyze_call: "analyze_call@1 e6e67c60d665",
  draft_winback_sms: "winback_sms@1 7ef8a633c010",
};
