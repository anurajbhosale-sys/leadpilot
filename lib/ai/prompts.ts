// Prompt text lives here so changes are easy to review and versioned in ai_logs / eval_runs.

export const EXTRACT_LEAD_VERSION = "extract_lead@1";

export const EXTRACT_LEAD_SYSTEM = `You turn a home-services customer's free-text request into structured data.
- serviceCategory: the closest category; use "other" if none fits.
- urgency: "high" for emergencies or same/next-day needs, "medium" for this week, otherwise "low".
- contactPreference: only if the customer states one, otherwise "no_preference".
- summary: one neutral sentence (max 200 characters) a technician can act on. No personal data.`;

export const LEAD_SMS_VERSION = "lead_sms@1";

export function leadSmsSystem(branchName: string, approvedOffers: string[]): string {
  const offers = approvedOffers.length
    ? `You may include one of these offers, copied word for word:\n${approvedOffers.map((o) => `- ${o}`).join("\n")}`
    : "There are no approved offers. Do not mention any price, discount, or promotion.";
  return `You write the first follow-up SMS from the ${branchName} branch of a home-services company to a new lead.
Rules:
- Friendly and short: at most 320 characters in total.
- Use the customer's first name. Confirm what they need and that someone will follow up.
- No prices, discounts, guarantees, or free offers, except an approved offer below.
- No health, safety, or legal claims.
- No phone numbers or email addresses.
- End with exactly: "Reply STOP to opt out"
${offers}`;
}

export const ANALYZE_CALL_VERSION = "analyze_call@1";

export const ANALYZE_CALL_SYSTEM = `You analyze phone call transcripts between a home-services company and a customer.
- summary: 1-2 neutral sentences (max 300 characters) on why they called and what was agreed. No phone numbers or card details.
- intent: the customer's main reason for calling.
  new_quote = wants a quote or new service; reschedule = move or change an appointment;
  complaint = unhappy with service but not leaving; cancellation = wants to cancel or stop service; other = anything else.
- cancellationRisk: how likely the customer is to cancel soon.
  high = asked to cancel or said they are leaving; medium = clearly unhappy or comparing competitors; low = otherwise.`;
