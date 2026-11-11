import { generateStructured } from "./client";
import { LEAD_SMS_VERSION, leadSmsSystem } from "./prompts";
import { checkSms, OPT_OUT_TEXT } from "@/lib/guardrails";
import { smsDraftSchema, type LeadExtraction } from "@/lib/schemas";

export type SmsDraftInput = {
  firstName: string;
  message: string; // the customer's own request
  extraction: LeadExtraction;
  branchName: string;
  approvedOffers: string[];
};

export type SmsDraftResult =
  | { status: "ready"; sms: string; attempts: number }
  | { status: "needs_review"; sms: string; attempts: number; errors: string[] };

/**
 * Draft the follow-up SMS and run guardrails. If the first draft fails, retry once with the
 * errors in the prompt. If that also fails, the caller sends the draft to a human.
 */
export async function draftLeadSms(input: SmsDraftInput): Promise<SmsDraftResult> {
  const system = leadSmsSystem(input.branchName, input.approvedOffers);
  // Minimal PII: first name and the request only. No phone, email, or address.
  const basePrompt = `Customer first name: ${input.firstName}
Service: ${input.extraction.serviceCategory}
Urgency: ${input.extraction.urgency}
Their request: ${input.message}`;

  let previous: { sms: string; errors: string[] } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt: string = previous
      ? `${basePrompt}\n\nYour previous draft:\n${previous.sms}\nIt failed these checks:\n- ${previous.errors.join("\n- ")}\nRewrite it so it passes.`
      : basePrompt;

    const { object, errors } = await generateStructured({
      task: "draft_lead_sms",
      promptVersion: LEAD_SMS_VERSION,
      schema: smsDraftSchema,
      system,
      prompt,
      mock: () => ({ message: mockLeadSms(input, attempt) }),
      validate: (draft) => checkSms(draft.message, { approvedOffers: input.approvedOffers }).errors,
    });

    if (errors.length === 0) return { status: "ready", sms: object.message, attempts: attempt };
    previous = { sms: object.message, errors };
  }

  return { status: "needs_review", sms: previous!.sms, attempts: 2, errors: previous!.errors };
}

/**
 * Mock "model" that behaves like a real one sometimes does, so every path can be exercised:
 * - asks about price      -> first draft quotes a price, the retry fixes it
 * - asks for a discount    -> uses the branch's approved offer, or if there is none,
 *                             keeps promising "20% off" and ends up in the approval queue
 * - anything else          -> a compliant draft on the first try
 */
export function mockLeadSms(input: SmsDraftInput, attempt: number): string {
  const service = input.extraction.serviceCategory === "hvac" ? "an HVAC" : `a ${input.extraction.serviceCategory.replace("_", " ")}`;
  const when = input.extraction.urgency === "high" ? "shortly" : "within one business day";
  let extra = "";
  if (/\b(discount|coupon|deal|promo\w*)\b/i.test(input.message)) {
    extra = input.approvedOffers[0] ? ` ${input.approvedOffers[0]}!` : " Ask about 20% off your first visit!";
  } else if (/\b(price|cost|how much|quote)\b/i.test(input.message) && attempt === 1) {
    extra = " Diagnostic visits start at $89.";
  }
  return `Hi ${input.firstName}, thanks for contacting ${input.branchName}! ${service[0].toUpperCase()}${service.slice(1)} specialist will reach out ${when}.${extra} ${OPT_OUT_TEXT}`;
}
