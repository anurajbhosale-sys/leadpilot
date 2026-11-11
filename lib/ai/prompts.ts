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
