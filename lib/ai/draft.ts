import { generateStructured } from "./client";
import { LEAD_SMS_VERSION, leadSmsSystem, WINBACK_SMS_VERSION, winbackSmsSystem } from "./prompts";
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
 * Draft an SMS and run guardrails. If the first draft fails, retry once with the errors
 * in the prompt. If that also fails, the result is "needs_review" and the caller routes it to a human.
 */
async function draftWithGuardrails(opts: {
  task: string;
  promptVersion: string;
  system: string;
  basePrompt: string;
  approvedOffers: string[];
  mock: (attempt: number) => string;
}): Promise<SmsDraftResult> {
  let previous: { sms: string; errors: string[] } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt: string = previous
      ? `${opts.basePrompt}\n\nYour previous draft:\n${previous.sms}\nIt failed these checks:\n- ${previous.errors.join("\n- ")}\nRewrite it so it passes.`
      : opts.basePrompt;

    const { object, errors } = await generateStructured({
      task: opts.task,
      promptVersion: opts.promptVersion,
      schema: smsDraftSchema,
      system: opts.system,
      prompt,
      mock: () => ({ message: opts.mock(attempt) }),
      validate: (draft) => checkSms(draft.message, { approvedOffers: opts.approvedOffers }).errors,
    });

    if (errors.length === 0) return { status: "ready", sms: object.message, attempts: attempt };
    previous = { sms: object.message, errors };
  }
  return { status: "needs_review", sms: previous!.sms, attempts: 2, errors: previous!.errors };
}

export function draftLeadSms(input: SmsDraftInput): Promise<SmsDraftResult> {
  return draftWithGuardrails({
    task: "draft_lead_sms",
    promptVersion: LEAD_SMS_VERSION,
    system: leadSmsSystem(input.branchName, input.approvedOffers),
    // Minimal PII: first name and the request only. No phone, email, or address.
    basePrompt: `Customer first name: ${input.firstName}
Service: ${input.extraction.serviceCategory}
Urgency: ${input.extraction.urgency}
Their request: ${input.message}`,
    approvedOffers: input.approvedOffers,
    mock: (attempt) => mockLeadSms(input, attempt),
  });
}

export type WinbackDraftInput = {
  firstName: string;
  plan: string;
  reason?: string;
  branchName: string;
  approvedOffers: string[];
};

export function draftWinbackSms(input: WinbackDraftInput): Promise<SmsDraftResult> {
  return draftWithGuardrails({
    task: "draft_winback_sms",
    promptVersion: WINBACK_SMS_VERSION,
    system: winbackSmsSystem(input.branchName, input.approvedOffers),
    basePrompt: `Customer first name: ${input.firstName}
Cancelled plan: ${input.plan}
Reason given: ${input.reason ?? "not given"}`,
    approvedOffers: input.approvedOffers,
    mock: () => mockWinbackSms(input),
  });
}

/**
 * Mock win-back "model":
 * - branch has an approved offer -> uses it word for word (passes guardrails)
 * - left because of price and no approved offer -> invents "15% off" every time, so the
 *   draft reaches the approval queue flagged with the guardrail errors
 * - otherwise -> a friendly note with no offer
 */
export function mockWinbackSms(input: WinbackDraftInput): string {
  const pricey = /expensive|price|cost/i.test(input.reason ?? "");
  const offer = input.approvedOffers[0]
    ? ` ${input.approvedOffers[0]} if you come back.`
    : pricey
      ? " We can do 15% off to keep you!"
      : "";
  return `Hi ${input.firstName}, we're sorry to see your ${input.plan.toLowerCase()} end. Thanks for being with ${input.branchName}.${offer} Just reply if you'd like to restart. ${OPT_OUT_TEXT}`;
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
